/**
 * OAuth authorization server — Codeoid mints HS256 auth code JWTs
 * that ZeroID validates and exchanges for access tokens.
 *
 * Flow:
 *   1. Frontend redirects to GET /auth/authorize?client_id=codeoid&code_challenge=...
 *   2. Daemon delegates to the configured IdentityProvider (Google, local, etc.)
 *   3. IdP verifies the user, redirects back to /auth/idp-callback
 *   4. Daemon mints HS256 auth code JWT signed with shared hmac_secret
 *   5. Redirects to the original redirect_uri with ?code=<jwt>&state=<state>
 *   6. Frontend exchanges code at ZeroID /oauth2/token (authorization_code + PKCE)
 *   7. ZeroID returns RS256 access token with user identity
 */

import { createHmac, randomBytes } from "node:crypto";
import type { IdentityProvider, VerifiedUser } from "./identity-provider.js";
import { LocalProvider } from "./identity-provider.js";

export interface OAuthConfig {
  /** Shared HMAC secret with ZeroID (base64url encoded) */
  hmacSecret: string;
  /** Issuer claim in auth code JWTs — must match ZeroID's auth_code_issuer */
  issuer: string;
  /** ZeroID token endpoint */
  tokenEndpoint: string;
  /** Registered OAuth client_id */
  clientId: string;
  /** Account ID for tenant scoping */
  accountId: string;
  /** Project ID */
  projectId: string;
  /** Allowed redirect URIs */
  allowedRedirectUris: string[];
  /** Scopes to grant users */
  defaultScopes: string[];
}

/** Pending authorization — stored between /auth/authorize and IdP callback */
interface PendingAuth {
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state: string;
  createdAt: number;
}

export class OAuthHandler {
  #config: OAuthConfig;
  #idp: IdentityProvider;
  #pending = new Map<string, PendingAuth>();

  constructor(config: OAuthConfig, idp?: IdentityProvider) {
    this.#config = config;
    this.#idp = idp ?? new LocalProvider();

    // Clean up expired pending auths every 60s
    setInterval(() => {
      const cutoff = Date.now() - 600_000;
      for (const [key, auth] of this.#pending) {
        if (auth.createdAt < cutoff) this.#pending.delete(key);
      }
    }, 60_000);
  }

  get providerName(): string {
    return this.#idp.name;
  }

  async handleFetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);

    if (url.pathname === "/auth/authorize" && req.method === "GET") {
      return this.#handleAuthorize(url);
    }

    if (url.pathname === "/auth/authorize" && req.method === "POST") {
      // Local provider form submission
      return this.#handleLocalLogin(req);
    }

    if (url.pathname === "/auth/idp-callback") {
      return this.#handleIdpCallback(url);
    }

    if (url.pathname === "/auth/callback") {
      return this.#handleFinalCallback(url);
    }

    return null;
  }

  // ── GET /auth/authorize — start the auth flow ─────────────────────

  #handleAuthorize(url: URL): Response {
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const codeChallenge = url.searchParams.get("code_challenge");
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "S256";
    const scope = url.searchParams.get("scope") ?? this.#config.defaultScopes.join(" ");
    const state = url.searchParams.get("state") ?? "";

    // Validate
    if (!clientId || clientId !== this.#config.clientId) {
      return new Response("Invalid client_id", { status: 400 });
    }
    if (!redirectUri || !this.#config.allowedRedirectUris.some(
      (u) => normalizeLoopback(u) === normalizeLoopback(redirectUri),
    )) {
      return new Response("Invalid redirect_uri", { status: 400 });
    }
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      return new Response("PKCE code_challenge (S256) required", { status: 400 });
    }

    // Store pending auth
    const internalState = randomBytes(16).toString("hex");
    this.#pending.set(internalState, {
      redirectUri,
      codeChallenge,
      scope,
      state,
      createdAt: Date.now(),
    });

    // Delegate to IdP
    if (this.#idp.name !== "local") {
      // External IdP — redirect to their login page
      const callbackUri = `${url.origin}/auth/idp-callback`;
      const authUrl = this.#idp.getAuthorizationUrl(callbackUri, internalState);
      return Response.redirect(authUrl, 302);
    }

    // Local provider — show built-in login form
    return new Response(loginPage(internalState, scope), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // ── POST /auth/authorize — local provider form submission ─────────

  async #handleLocalLogin(req: Request): Promise<Response> {
    const form = await req.formData();
    const internalState = form.get("auth_state") as string;
    const userId = form.get("user_id") as string;
    const userName = form.get("user_name") as string;

    if (!internalState || !userId) {
      return new Response("Missing fields", { status: 400 });
    }

    const user: VerifiedUser = {
      id: userId,
      name: userName || userId,
      provider: "local",
    };

    return this.#completeAuth(internalState, user);
  }

  // ── GET /auth/idp-callback — external IdP redirects back here ─────

  async #handleIdpCallback(url: URL): Promise<Response> {
    const internalState = url.searchParams.get("state");
    if (!internalState) {
      return new Response("Missing state parameter", { status: 400 });
    }

    const callbackUri = `${url.origin}/auth/idp-callback`;

    try {
      const user = await this.#idp.handleCallback(callbackUri, url.searchParams);
      return this.#completeAuth(internalState, user);
    } catch (err) {
      const pending = this.#pending.get(internalState);
      this.#pending.delete(internalState);

      if (pending) {
        const callbackUrl = new URL(pending.redirectUri);
        callbackUrl.searchParams.set("error", err instanceof Error ? err.message : "Authentication failed");
        if (pending.state) callbackUrl.searchParams.set("state", pending.state);
        return Response.redirect(callbackUrl.toString(), 302);
      }

      return new Response(`Authentication failed: ${err instanceof Error ? err.message : "unknown"}`, { status: 400 });
    }
  }

  // ── Complete auth — mint code, redirect to original redirect_uri ──

  #completeAuth(internalState: string, user: VerifiedUser): Response {
    const pending = this.#pending.get(internalState);
    if (!pending) {
      return new Response("Invalid or expired authorization request", { status: 400 });
    }
    this.#pending.delete(internalState);

    const scopes = pending.scope.split(" ").filter(Boolean);
    const code = mintAuthCode(
      this.#config,
      user.id,
      pending.codeChallenge,
      pending.redirectUri,
      scopes.length > 0 ? scopes : this.#config.defaultScopes,
    );

    const callbackUrl = new URL(pending.redirectUri);
    callbackUrl.searchParams.set("code", code);
    if (pending.state) callbackUrl.searchParams.set("state", pending.state);

    return Response.redirect(callbackUrl.toString(), 302);
  }

  // ── GET /auth/callback — landing page for client-side token exchange

  #handleFinalCallback(url: URL): Response {
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      return new Response(errorPage(error), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (!code) {
      return new Response("Missing authorization code", { status: 400 });
    }

    return new Response(callbackPage(code, this.#config.clientId), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

// =============================================================================
// Auth code minting
// =============================================================================

function mintAuthCode(
  config: OAuthConfig,
  userId: string,
  codeChallenge: string,
  redirectUri: string,
  scopes: string[],
): string {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: config.issuer,
    sub: "auth-code",
    iat: now,
    exp: now + 300,
    cid: config.clientId,
    uid: userId,
    aid: config.accountId,
    pid: config.projectId,
    cc: codeChallenge,
    ruri: redirectUri,
    scp: scopes,
  };

  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signature = b64url(
    createHmac("sha256", config.hmacSecret)
      .update(`${headerB64}.${payloadB64}`)
      .digest(),
  );

  return `${headerB64}.${payloadB64}.${signature}`;
}

function b64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

function normalizeLoopback(uri: string): string {
  return uri.replace("://localhost", "://127.0.0.1");
}

// =============================================================================
// HTML pages
// =============================================================================

function loginPage(authState: string, scope: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codeoid — Login</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif;
  background: #0a0a0f; color: #e4e4ed; height: 100dvh;
  display: flex; align-items: center; justify-content: center;
}
.card {
  background: #141420; border: 1px solid #2a2a3e; border-radius: 16px;
  padding: 2rem; width: min(90vw, 400px); display: flex; flex-direction: column; gap: 1.25rem;
}
.logo { font-size: 1.8rem; font-weight: 700; text-align: center; }
.subtitle { color: #8888a0; font-size: 0.9rem; text-align: center; }
.scopes { background: #0a0a0f; border-radius: 10px; padding: 0.75rem 1rem; font-size: 0.85rem; color: #8888a0; }
.scopes strong { color: #e4e4ed; }
label { font-size: 0.85rem; color: #8888a0; font-weight: 500; }
input {
  background: #0a0a0f; border: 1px solid #2a2a3e; border-radius: 10px;
  color: #e4e4ed; padding: 0.75rem 1rem; font-size: 1rem; outline: none; width: 100%;
}
input:focus { border-color: #6366f1; }
.btn {
  background: #6366f1; color: white; border: none; border-radius: 10px;
  padding: 0.75rem; font-size: 1rem; font-weight: 600; cursor: pointer;
}
.btn:hover { background: #818cf8; }
.field { display: flex; flex-direction: column; gap: 0.35rem; }
.warn { font-size: 0.75rem; color: #eab308; text-align: center; padding: 0.5rem; background: #1c1c2e; border-radius: 8px; }
.security { font-size: 0.75rem; color: #8888a0; text-align: center; }
</style>
</head>
<body>
<form method="POST" action="/auth/authorize" class="card">
  <div class="logo">&#9889; Codeoid</div>
  <p class="subtitle">Authorize access to your AI coding sessions</p>
  <div class="warn">&#9888; Local dev mode — no password verification. Configure Google OAuth for production.</div>
  <div class="scopes">
    <strong>Requested permissions:</strong><br>
    ${scope.split(" ").map((s) => `&bull; ${s}`).join("<br>")}
  </div>
  <div class="field">
    <label for="user_id">User ID</label>
    <input id="user_id" name="user_id" required placeholder="e.g. ydatta" autocomplete="username" autofocus />
  </div>
  <div class="field">
    <label for="user_name">Display Name</label>
    <input id="user_name" name="user_name" placeholder="e.g. Yash Datta" autocomplete="name" />
  </div>
  <input type="hidden" name="auth_state" value="${authState}" />
  <button type="submit" class="btn">Authorize</button>
  <p class="security">Secured by ZeroID &mdash; every action auditable</p>
</form>
</body>
</html>`;
}

function callbackPage(code: string, clientId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codeoid — Authenticating...</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  background: #0a0a0f; color: #e4e4ed; height: 100dvh;
  display: flex; align-items: center; justify-content: center;
}
.card {
  background: #141420; border: 1px solid #2a2a3e; border-radius: 16px;
  padding: 2rem; width: min(90vw, 400px); text-align: center;
}
.status { font-size: 1.2rem; font-weight: 600; margin-bottom: 0.5rem; }
.detail { color: #8888a0; font-size: 0.9rem; }
.error { color: #ef4444; }
.success { color: #22c55e; }
</style>
</head>
<body>
<div class="card">
  <div class="status" id="status">Exchanging token...</div>
  <div class="detail" id="detail">Please wait</div>
</div>
<script>
(async function() {
  const code = ${JSON.stringify(code)};
  const verifier = sessionStorage.getItem('codeoid_pkce_verifier');

  if (!verifier) {
    document.getElementById('status').textContent = 'Error';
    document.getElementById('status').className = 'status error';
    document.getElementById('detail').textContent = 'PKCE verifier not found. Please try logging in again.';
    return;
  }

  try {
    const resp = await fetch('/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: ${JSON.stringify(clientId)},
        code: code,
        code_verifier: verifier,
        redirect_uri: window.location.origin + '/auth/callback'
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(function() { return { error: 'Token exchange failed' }; });
      throw new Error(err.error_description || err.error || 'Token exchange failed');
    }

    const token = await resp.json();

    localStorage.setItem('codeoid_token', token.access_token);
    if (token.refresh_token) localStorage.setItem('codeoid_refresh_token', token.refresh_token);
    localStorage.setItem('codeoid_user_id', token.user_id || '');

    sessionStorage.removeItem('codeoid_pkce_verifier');
    sessionStorage.removeItem('codeoid_pkce_state');

    document.getElementById('status').textContent = 'Authenticated!';
    document.getElementById('status').className = 'status success';
    document.getElementById('detail').textContent = 'Redirecting to Codeoid...';

    setTimeout(function() { window.location.href = '/app'; }, 500);
  } catch (err) {
    document.getElementById('status').textContent = 'Error';
    document.getElementById('status').className = 'status error';
    document.getElementById('detail').textContent = err.message;
  }
})();
</script>
</body>
</html>`;
}

function errorPage(error: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Error</title>
<style>body{font-family:system-ui;background:#0a0a0f;color:#ef4444;display:flex;align-items:center;justify-content:center;height:100vh;}</style>
</head><body><div><h2>Authorization Failed</h2><p>${error}</p><p><a href="/app" style="color:#6366f1">Back to Codeoid</a></p></div></body></html>`;
}
