/**
 * Agent actor assertions for RFC 8693 token exchange.
 *
 * ZeroID's delegated `token_exchange` requires the `actor_token` to be a
 * short-lived JWT whose `iss`/`sub` is the actor's WIMSE URI, signed with the
 * actor's own EC P-256 key and validated against the `public_key_pem`
 * registered for that identity. A plain api-key-grant access token is rejected
 * ("actor_token iss is not a valid WIMSE URI"), so the actor must self-sign.
 *
 * Implemented with Web Crypto (available in Bun) — zero extra deps. ECDSA P-256
 * signatures come back in IEEE-P1363 (r‖s) form, which is exactly the JOSE
 * signature encoding, so no DER conversion is needed.
 */

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlString(str: string): string {
  return b64url(new TextEncoder().encode(str));
}

export interface AgentKeypair {
  /** Private key used to sign actor assertions (non-extractable). */
  privateKey: CryptoKey;
  /** SPKI/PKIX PEM to register as the identity's `public_key_pem`. */
  publicKeyPem: string;
}

/** Generate an EC P-256 keypair and its public key in SPKI PEM form. */
export async function generateAgentKeypair(): Promise<AgentKeypair> {
  const kp = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", kp.publicKey),
  );
  let b64 = "";
  for (const b of spki) b64 += String.fromCharCode(b);
  const body = (btoa(b64).match(/.{1,64}/g) ?? []).join("\n");
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
  return { privateKey: kp.privateKey, publicKeyPem };
}

/**
 * Sign a short-lived ES256 actor assertion (iss = sub = `wimseUri`,
 * aud = `audience`). `ttlSeconds` defaults to 2 minutes — the assertion is
 * consumed immediately by the token exchange, so it stays tight.
 */
export async function signActorAssertion(
  privateKey: CryptoKey,
  wimseUri: string,
  audience: string,
  ttlSeconds = 120,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "JWT" };
  const payload = {
    iss: wimseUri,
    sub: wimseUri,
    aud: audience,
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomUUID(),
  };
  const signingInput = `${b64urlString(JSON.stringify(header))}.${b64urlString(
    JSON.stringify(payload),
  )}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${b64url(sig)}`;
}
