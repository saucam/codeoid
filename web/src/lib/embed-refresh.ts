/**
 * postMessage token-refresh listener for the embed SSO flow.
 *
 * Highflame Studio sends a fresh codeoid SSO token every 12 minutes via
 * `postMessage` so the embedded UI can silently re-authenticate without a
 * full page reload (which would wipe the running codeoid session).
 *
 * ── Security gate ──────────────────────────────────────────────────────────
 * Mirrors the hash-handoff gate in `handoff.ts`. A message is accepted ONLY
 * when ALL of the following hold:
 *   1. This page IS embedded (`window.top !== window.self`). A top-level page
 *      cannot receive a meaningful refresh message, and accepting postMessages
 *      from arbitrary origins at the top level would be an open injection
 *      vector.
 *   2. `event.origin` is in the daemon-published allowlist (same allowlist as
 *      the hash handoff — `CODEOID_EMBED_ALLOWED_ORIGINS`). We compare
 *      lowercased origins to avoid case-sensitivity surprises.
 *   3. The message data has the exact expected shape:
 *        `{ type: "CODEOID_TOKEN_REFRESH", token: "<non-empty string>" }`
 *      Any other message type or structure is silently ignored — we don't
 *      break third-party postMessage users (Monaco, analytics, etc.).
 * On any failing condition the message is silently ignored (fail closed).
 * ──────────────────────────────────────────────────────────────────────────
 */

/** The message type Studio posts when it has a refreshed token ready. */
export const EMBED_REFRESH_TYPE = "CODEOID_TOKEN_REFRESH";

export interface EmbedRefreshOptions {
  /** Origins allowed to send a token refresh. Empty ⇒ refresh disabled. */
  allowedOrigins: readonly string[];
  /**
   * Called with the fresh token once the gate passes. May be async; errors are
   * swallowed (the message handler must never throw to the browser's error
   * event — a refresh failure degrades gracefully to the existing session
   * expiry path).
   */
  onRefresh: (token: string) => void | Promise<void>;
}

/**
 * Register the `postMessage` listener for embed token refreshes. Returns a
 * cleanup function that removes it (call on component unmount or `onCleanup`).
 *
 * No-ops and returns a no-op cleanup when:
 *   - Outside a browser context (SSR / tests without a DOM).
 *   - Not embedded (`window.top === window.self`).
 *   - `allowedOrigins` is empty (refresh disabled by the daemon config).
 */
export function installEmbedTokenRefresh(opts: EmbedRefreshOptions): () => void {
  if (typeof window === "undefined") return noop;

  // Only install when actually framed — the refresh channel is meaningless at
  // the top level, and listening there would silently accept postMessages from
  // any allowlisted parent even when the user opened codeoid in a new tab.
  if (window.top === window.self) return noop;

  const allowedLower = opts.allowedOrigins
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);

  // Empty allowlist → refresh disabled (same safe default as the hash handoff).
  if (allowedLower.length === 0) return noop;

  function handleMessage(event: MessageEvent): void {
    // 1. Origin gate — must be in the trusted allowlist.
    if (!allowedLower.includes(event.origin.toLowerCase())) return;

    // 2. Shape gate — must be exactly our message type with a string token.
    //    Other postMessages (Monaco, third-party widgets, etc.) pass through.
    const data = event.data as unknown;
    if (!data || typeof data !== "object") return;
    const d = data as Record<string, unknown>;
    if (d["type"] !== EMBED_REFRESH_TYPE) return;
    if (typeof d["token"] !== "string") return;

    const token = d["token"].trim();
    if (!token) return;

    // Deliver to the connection layer. Swallow errors — a failed refresh is not
    // a crash; the existing session will expire naturally (fail-open on refresh,
    // fail-close on initial auth).
    void Promise.resolve(opts.onRefresh(token)).catch(() => {});
  }

  window.addEventListener("message", handleMessage);
  return () => window.removeEventListener("message", handleMessage);
}

function noop(): void {}
