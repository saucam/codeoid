/**
 * Resolve a daemon access token. Mirrors the Rust client's `resolve_token`:
 *
 *   1. If a JWT is provided directly (`token`), use it.
 *   2. Else if an API key is provided (`apiKey` starting with `zid_sk_`),
 *      exchange it at ZeroID's `/oauth2/token` for a JWT.
 *   3. Else throw a structured error so the caller can surface a "sign in"
 *      affordance instead of crashing.
 *
 * The web UI persists the API key in localStorage so reloads stay signed
 * in — the JWT itself is held only in memory (short-lived).
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
  /** AbortSignal for the exchange call. */
  signal?: AbortSignal;
}

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

  const apiKey = opts.apiKey ?? localStorage.getItem(STORAGE_KEY_API_KEY) ?? undefined;
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

  const zeroidUrl = opts.zeroidUrl ?? "http://localhost:8899";
  const url = `${zeroidUrl.replace(/\/+$/, "")}/oauth2/token`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "api_key", api_key: apiKey }),
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

/** Forget the persisted API key (sign-out). Also clears any cached token. */
export function forgetApiKey(): void {
  localStorage.removeItem(STORAGE_KEY_API_KEY);
  localStorage.removeItem(STORAGE_KEY_TOKEN);
}

export function rememberedApiKey(): string | null {
  return localStorage.getItem(STORAGE_KEY_API_KEY);
}
