/**
 * ZeroID JWT verification for Codeoid connections.
 *
 * Every WebSocket connection and every Telegram message must present a valid
 * ZeroID JWT. The token is verified locally against the JWKS endpoint (no
 * round-trip to ZeroID on the hot path). Scopes in the token are mapped to
 * Codeoid permission scopes and enforced per-message by the daemon.
 */

import { ZeroIDClient } from "@highflame/sdk";
import type { AuthContext } from "../protocol/types.js";
import type { Scope } from "../protocol/scopes.js";

export interface AuthConfig {
  /** ZeroID base URL, e.g. "http://localhost:8899" */
  baseUrl: string;
  /** ZeroID JWKS URL — derived from baseUrl if not set */
  jwksUrl?: string;
  /** Expected issuer claim */
  issuer?: string;
  /** Expected audience claim */
  audience?: string;
}

// Lazily initialised ZeroID client (one per daemon).
let _zeroidClient: ZeroIDClient | null = null;

function getClient(config: AuthConfig): ZeroIDClient {
  if (!_zeroidClient) {
    _zeroidClient = new ZeroIDClient({ baseUrl: config.baseUrl });
  }
  return _zeroidClient;
}

/**
 * Verify a bearer token and return the Codeoid auth context.
 *
 * @throws {Error} if the token is invalid, expired, or missing required fields.
 */
export async function verifyToken(
  token: string,
  config: AuthConfig,
): Promise<AuthContext> {
  const client = getClient(config);
  const identity = await client.tokens.verify(token);

  if (config.issuer && identity.iss !== config.issuer) {
    throw new Error(`Token issuer mismatch: expected "${config.issuer}", got "${identity.iss}"`);
  }

  if (config.audience && !identity.aud.includes(config.audience)) {
    throw new Error(`Token audience mismatch: expected "${config.audience}"`);
  }

  // Defend locally: the SDK only rejects expiry when `exp` is present, so a
  // signed token that omits `exp` would never expire. Require a numeric,
  // not-yet-expired exp. (A 60s skew allowance covers minor clock drift.)
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof identity.exp !== "number" || identity.exp <= 0) {
    throw new Error("Token missing exp claim");
  }
  if (identity.exp <= nowSec - 60) {
    throw new Error("Token expired");
  }

  return identityToAuthContext(identity);
}

// Use Awaited<ReturnType<...>> to get the identity type without importing the non-exported type.
type VerifiedIdentity = Awaited<ReturnType<ZeroIDClient["tokens"]["verify"]>>;

function identityToAuthContext(identity: VerifiedIdentity): AuthContext {
  return {
    sub: identity.sub,
    name: identity.name,
    scopes: (identity.scopes ?? []) as Scope[],
    delegationDepth: identity.delegation_depth ?? 0,
    delegatedBy: identity.act?.sub,
    accountId: identity.account_id,
    projectId: identity.project_id,
    exp: identity.exp,
  };
}

/**
 * Extract bearer token from an Authorization header value.
 * Returns undefined if the header is missing or malformed.
 */
export function extractBearerToken(
  authHeader: string | undefined,
): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}
