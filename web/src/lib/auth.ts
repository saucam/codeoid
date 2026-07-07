/**
 * Resolve a daemon access token. Mirrors the Rust client's `resolve_token`:
 *
 *   1. If a JWT is provided directly (`token`), use it.
 *   2. Else if an API key is provided (`apiKey` starting with `zid_sk_`),
 *      exchange it at ZeroID's `/oauth2/token` for a JWT.
 *   3. Else throw a structured error so the caller can surface a "sign in"
 *      affordance instead of crashing.
 *
 * The web UI persists credentials in localStorage so reloads stay signed in:
 * the API key (`codeoid.apiKey`, a long-lived `zid_sk_` secret) for the key
 * flow, and the JWT (`codeoid.token`) for the OAuth flow. SECURITY: both are
 * therefore readable by any same-origin script — an XSS would exfiltrate a
 * durable credential, not just a session. This is a known tradeoff for
 * reload-persistence; hardening (httpOnly cookie / non-persistent key) is
 * tracked separately. The markdown render path is XSS-sanitized (see
 * lib/sanitize-url) precisely because these live here.
 */

const STORAGE_KEY_API_KEY = "codeoid.apiKey";
const STORAGE_KEY_TOKEN = "codeoid.token";

export interface ResolveOptions {
  /** Pre-issued daemon JWT. Takes precedence. */
  token?: string;
  /** ZeroID API key (`zid_sk_...`) to exchange for a JWT. */
  apiKey?: string;
  /** ZeroID base URL. Defaults to http://localhost:8899. */
  zeroidUrl?: string;
  /**
   * Space-delimited scopes to request when exchanging an api_key.
   * Defaults to the codeoid web operator set — every verb the UI sends.
   * ZeroID propagates these into the issued JWT's `scopes` claim, which
   * the daemon enforces per-message. Without this, JWTs come back with
   * an empty scope set and every protocol verb is denied.
   */
  scope?: string;
  /** AbortSignal for the exchange call. */
  signal?: AbortSignal;
}

/** Default scope request for the web UI — every codeoid verb it sends. */
export const DEFAULT_WEB_SCOPES = [
  "session:list",
  "session:create",
  "session:attach",
  "session:watch",
  "session:send",
  "session:interrupt",
  "session:approve",
  "session:destroy",
  // Conductor scopes — delegated owner → conductor when the web UI opens the
  // conductor session. Harmless on non-conductor use.
  "session:read",
  "session:dispatch",
  "fs:read",
].join(" ");

export interface ResolvedAuth {
  /** Bearer token to use against the daemon. */
  token: string;
  /** True if this came from an apiKey exchange (vs. a direct JWT). */
  exchanged: boolean;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly kind: "missing" | "exchange_failed" | "invalid",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export async function resolveToken(opts: ResolveOptions): Promise<ResolvedAuth> {
  if (opts.token) return { token: opts.token, exchanged: false };

  // After Google OAuth, /auth/callback stores a ZeroID RS256 token directly
  // in localStorage. Use it only when no API key is available (explicit or stored),
  // so a saved API key always takes precedence over an OAuth token.
  const storedApiKey = localStorage.getItem(STORAGE_KEY_API_KEY) ?? undefined;
  if (!opts.apiKey && !storedApiKey) {
    const storedToken = localStorage.getItem(STORAGE_KEY_TOKEN);
    if (storedToken) return { token: storedToken, exchanged: false };
  }

  const apiKey = opts.apiKey ?? storedApiKey;
  if (!apiKey) {
    throw new AuthError(
      "no auth — supply CODEOID_API_KEY (a zid_sk_… token) or sign in",
      "missing",
    );
  }
  if (!apiKey.startsWith("zid_sk_")) {
    throw new AuthError(
      `api key must start with "zid_sk_" — got "${apiKey.slice(0, 8)}…"`,
      "invalid",
    );
  }

  // Default to a same-origin URL ("/oauth2/token") so the browser doesn't
  // hit ZeroID cross-origin (ZeroID's /oauth2/token doesn't return CORS
  // headers). In dev, Vite's proxy intercepts /oauth2/* and forwards to
  // ZEROID_URL server-side. In prod, the deploy is expected to do the
  // same (ingress / nginx). An explicit `zeroidUrl` override still
  // works for absolute URLs.
  const zeroidUrl = opts.zeroidUrl ?? "";
  const url = zeroidUrl
    ? `${zeroidUrl.replace(/\/+$/, "")}/oauth2/token`
    : "/oauth2/token";

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "api_key",
        api_key: apiKey,
        scope: opts.scope ?? DEFAULT_WEB_SCOPES,
      }),
      signal: opts.signal,
    });
  } catch (err) {
    throw new AuthError(`cannot reach ZeroID at ${url}`, "exchange_failed", err);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AuthError(
      `ZeroID rejected the API key (${res.status}): ${body.slice(0, 200) || res.statusText}`,
      "exchange_failed",
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new AuthError("ZeroID returned non-JSON", "exchange_failed", err);
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !("access_token" in payload) ||
    typeof (payload as { access_token: unknown }).access_token !== "string"
  ) {
    throw new AuthError("ZeroID response missing access_token", "exchange_failed");
  }

  const token = (payload as { access_token: string }).access_token;
  return { token, exchanged: true };
}

/** Persist an API key for re-use across reloads (no JWT — those are short-lived). */
export function rememberApiKey(apiKey: string): void {
  localStorage.setItem(STORAGE_KEY_API_KEY, apiKey);
}

/** Forget all persisted credentials (sign-out). */
export function forgetApiKey(): void {
  localStorage.removeItem(STORAGE_KEY_API_KEY);
  localStorage.removeItem(STORAGE_KEY_TOKEN);
}

export function rememberedApiKey(): string | null {
  return localStorage.getItem(STORAGE_KEY_API_KEY);
}

/** Returns the ZeroID token stored after a successful Google OAuth login. */
export function rememberedOAuthToken(): string | null {
  return localStorage.getItem(STORAGE_KEY_TOKEN);
}

/**
 * Fetch which OAuth provider the daemon is configured with.
 * Returns null when Google OAuth is not configured (API-key-only mode).
 */
export async function fetchOAuthProvider(): Promise<"google" | null> {
  try {
    const res = await fetch("/auth/provider");
    if (!res.ok) return null;
    const data = (await res.json()) as { provider: string | null };
    return data.provider === "google" ? "google" : null;
  } catch {
    return null;
  }
}

/**
 * Start the Google OAuth login flow. Redirects to the daemon's /auth/authorize;
 * the daemon handles the Google redirect and ZeroID token exchange server-side,
 * then lands the browser on /auth/callback with the ready access token.
 */
export function startOAuthLogin(opts?: { scope?: string }): void {
  const params = new URLSearchParams({
    client_id: "codeoid",
    redirect_uri: `${window.location.origin}/auth/callback`,
    scope: opts?.scope ?? DEFAULT_WEB_SCOPES,
  });
  window.location.href = `/auth/authorize?${params}`;
}

/**
 * Register a fresh agent identity in ZeroID and return the new API key.
 *
 * Used by the SignIn flow's "Register new web agent" affordance so a
 * brand-new user doesn't have to do CLI gymnastics. Defaults pick
 * sensible labels (`codeoid-web`) so the connected identity reads as
 * an actual web client, not a borrowed TUI agent.
 *
 * Endpoint: ZeroID's `/api/v1/agents/register`. Today the daemon's
 * default ZeroID is configured without admin auth on this route — fine
 * for local dev; production deploys must front it with proper auth.
 */
export async function registerWebAgent(opts: {
  name?: string;
  accountId?: string;
  projectId?: string;
  ownerId?: string;
  zeroidUrl?: string;
  signal?: AbortSignal;
} = {}): Promise<{ apiKey: string; agentUri: string; identityId: string }> {
  const baseUrl = (opts.zeroidUrl ?? "").replace(/\/+$/, "");
  const url = baseUrl
    ? `${baseUrl}/api/v1/agents/register`
    : "/api/v1/agents/register";

  const accountId = opts.accountId ?? "acct_demo";
  const projectId = opts.projectId ?? "proj_demo";
  const ownerId = opts.ownerId ?? "web-user@local";
  const name = opts.name ?? "codeoid-web";
  const externalId = `${name}-${Math.random().toString(36).slice(2, 10)}`;

  const body = {
    name,
    external_id: externalId,
    sub_type: "autonomous",
    trust_level: "first_party",
    framework: "codeoid-web",
    publisher: "codeoid",
    created_by: ownerId,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Account-ID": accountId,
        "X-Project-ID": projectId,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    throw new AuthError(
      `cannot reach ZeroID admin endpoint at ${url}`,
      "exchange_failed",
      err,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AuthError(
      `ZeroID rejected the registration (${res.status}): ${text.slice(0, 240) || res.statusText}`,
      "exchange_failed",
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new AuthError("ZeroID returned non-JSON", "exchange_failed", err);
  }

  if (!payload || typeof payload !== "object") {
    throw new AuthError("ZeroID response missing fields", "exchange_failed");
  }
  const obj = payload as Record<string, unknown>;
  const apiKey = obj["api_key"];
  const identity = obj["identity"];
  if (typeof apiKey !== "string") {
    throw new AuthError("ZeroID response missing api_key", "exchange_failed");
  }
  const identityObj = identity && typeof identity === "object" ? (identity as Record<string, unknown>) : null;
  const agentUri =
    typeof identityObj?.["wimse_uri"] === "string"
      ? (identityObj["wimse_uri"] as string)
      : "";
  const identityId =
    typeof identityObj?.["id"] === "string"
      ? (identityObj["id"] as string)
      : "";

  return { apiKey, agentUri, identityId };
}
