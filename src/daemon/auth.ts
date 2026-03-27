/**
 * ZeroID JWT verification for Codeoid connections.
 *
 * Every WebSocket connection and every Telegram message must present a valid
 * ZeroID JWT. The token is verified locally against the JWKS endpoint (no
 * round-trip to ZeroID on the hot path). Scopes in the token are mapped to
 * Codeoid permission scopes and enforced per-message by the daemon.
 */

import { verifyJWT, type ZeroIDIdentity } from "@highflame/sdk/zeroid";
import type { AuthContext } from "../protocol/types.js";
import type { Scope } from "../protocol/scopes.js";

export interface AuthConfig {
  /** ZeroID JWKS URL, e.g. "http://localhost:8899/.well-known/jwks.json" */
  jwksUrl: string;
  /** Expected issuer claim */
  issuer?: string;
  /** Expected audience claim */
  audience?: string;
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
  const identity = await verifyJWT(token, config.jwksUrl);

  if (config.issuer && identity.iss !== config.issuer) {
    throw new Error(`Token issuer mismatch: expected "${config.issuer}", got "${identity.iss}"`);
  }

  if (config.audience && !identity.aud.includes(config.audience)) {
    throw new Error(`Token audience mismatch: expected "${config.audience}"`);
  }

  return identityToAuthContext(identity);
}

function identityToAuthContext(identity: ZeroIDIdentity): AuthContext {
  return {
    sub: identity.sub,
    name: identity.name,
    scopes: (identity.scopes ?? []) as Scope[],
    delegationDepth: identity.delegation_depth ?? 0,
    delegatedBy: identity.act?.sub,
    accountId: identity.account_id,
    projectId: identity.project_id,
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
