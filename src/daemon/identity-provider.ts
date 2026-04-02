/**
 * Identity Provider interface — pluggable user authentication.
 *
 * Codeoid delegates "who is this human?" to an IdP. After the IdP verifies
 * the user, Codeoid mints an HS256 auth code for ZeroID.
 *
 * Built-in providers:
 *   - GoogleOAuthProvider: Google OAuth 2.0 (open source default)
 *   - LocalProvider: form-based login, no verification (dev only)
 *
 * Future:
 *   - ClerkProvider: for Highflame platform (users already in Studio)
 *   - GitHubProvider: for developer-focused deployments
 *   - PasskeyProvider: WebAuthn/FIDO2 for local-first SOTA security
 */

import { randomBytes, createHash } from "node:crypto";

// =============================================================================
// Interface
// =============================================================================

export interface VerifiedUser {
  /** Unique user ID from the IdP */
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  /** Which provider verified this user */
  provider: string;
}

export interface IdentityProvider {
  readonly name: string;

  /**
   * Get the URL to redirect the user to for authentication.
   * The IdP will redirect back to `callbackUri` after login.
   */
  getAuthorizationUrl(callbackUri: string, state: string): string;

  /**
   * Handle the callback from the IdP. Validates the response and returns
   * the verified user identity. Throws on failure.
   */
  handleCallback(callbackUri: string, params: URLSearchParams): Promise<VerifiedUser>;
}

// =============================================================================
// Google OAuth 2.0 Provider
// =============================================================================

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export class GoogleOAuthProvider implements IdentityProvider {
  readonly name = "google";
  #config: GoogleOAuthConfig;

  constructor(config: GoogleOAuthConfig) {
    this.#config = config;
  }

  getAuthorizationUrl(callbackUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.#config.clientId,
      redirect_uri: callbackUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async handleCallback(callbackUri: string, params: URLSearchParams): Promise<VerifiedUser> {
    const code = params.get("code");
    if (!code) {
      const error = params.get("error") ?? "missing code";
      throw new Error(`Google OAuth error: ${error}`);
    }

    // Exchange code for tokens
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
        redirect_uri: callbackUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResp.ok) {
      const err = await tokenResp.text();
      throw new Error(`Google token exchange failed: ${err}`);
    }

    const tokens = (await tokenResp.json()) as {
      id_token?: string;
      access_token?: string;
    };

    if (!tokens.id_token) {
      throw new Error("No id_token in Google response");
    }

    // Decode ID token (JWT) — we trust Google's signature since we just
    // exchanged a code over HTTPS. For production, verify the signature
    // against Google's JWKS, but the code exchange already proves authenticity.
    const payload = JSON.parse(
      Buffer.from(tokens.id_token.split(".")[1], "base64url").toString(),
    ) as {
      sub: string;
      email?: string;
      name?: string;
      picture?: string;
      email_verified?: boolean;
    };

    if (!payload.sub) {
      throw new Error("Invalid Google ID token: missing sub");
    }

    return {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      avatarUrl: payload.picture,
      provider: "google",
    };
  }
}

// =============================================================================
// Local Provider (dev only — no real verification)
// =============================================================================

export class LocalProvider implements IdentityProvider {
  readonly name = "local";

  getAuthorizationUrl(_callbackUri: string, _state: string): string {
    // Local provider doesn't redirect — it shows a form directly
    return "";
  }

  async handleCallback(_callbackUri: string, params: URLSearchParams): Promise<VerifiedUser> {
    const userId = params.get("user_id");
    const userName = params.get("user_name");

    if (!userId) {
      throw new Error("Missing user_id");
    }

    return {
      id: userId,
      name: userName ?? userId,
      provider: "local",
    };
  }
}

// =============================================================================
// PKCE helpers (used by CLI login flow)
// =============================================================================

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
