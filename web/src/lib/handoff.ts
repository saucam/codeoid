/**
 * URL-hash credential handoff for embed SSO.
 *
 * An embedding parent (e.g. Highflame Studio) can pre-authenticate this
 * embedded UI by handing a SHORT-LIVED credential in the URL *hash* — never
 * the query string. The hash is not sent to any server, does not appear in the
 * `Referer` header, and is not logged by intermediaries, so it is the safe
 * channel for a bearer credential the parent already holds.
 *
 * On load we CONSUME it: read the two known keys, persist them exactly like the
 * normal sign-in flows (into the same localStorage slots), and immediately
 * strip them from the URL via `history.replaceState` so the credential does not
 * linger in the address bar or browser history. The daemon still verifies the
 * token on the WS handshake and fails closed — this only changes how the
 * browser OBTAINS a token, not the security gate.
 *
 * Accepted hash params (ONLY these two — anything else is ignored/preserved):
 *   #codeoid_token=<JWT>       → persisted as the OAuth JWT (codeoid.token)
 *   #codeoid_key=<zid_sk_...>  → persisted as the API key   (codeoid.apiKey)
 *
 * SECURITY: only the two known keys are accepted; the credential value is never
 * logged; and it is stripped from the URL on the same tick it is read. The
 * parent is expected to hand a SHORT-LIVED token for this to be a safe SSO
 * bridge — a long-lived secret in a hash is a durable-credential leak.
 */

import { STORAGE_KEY_API_KEY, STORAGE_KEY_TOKEN } from "./auth";

const HANDOFF_TOKEN_PARAM = "codeoid_token";
const HANDOFF_KEY_PARAM = "codeoid_key";

export interface HandoffCredential {
  /** Pre-issued daemon JWT handed in via `#codeoid_token=`. */
  token?: string;
  /** ZeroID API key (`zid_sk_...`) handed in via `#codeoid_key=`. */
  apiKey?: string;
}

/** decodeURIComponent that never throws — falls back to the raw value. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Read a credential handed in via the URL hash, persist it like a remembered
 * credential, and strip the handoff params from the URL (preserving any other
 * hash content). Returns what was consumed so the caller can give a
 * freshly-handed-in credential precedence over a stale stored one.
 *
 * Defensive by contract: never throws on load, and ignores malformed or empty
 * values (a `#codeoid_token=` with no value is treated as absent, but is still
 * stripped from the URL).
 */
export function consumeHandoffCredential(): HandoffCredential {
  try {
    // Guard for non-browser contexts (SSR / tests without a DOM).
    if (typeof window === "undefined" || !window.location) return {};

    const rawHash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    if (!rawHash) return {};

    // Split the hash into "&"-separated segments and filter out only the two
    // known handoff params, keeping every other segment verbatim. This avoids
    // the re-encoding surprises a URLSearchParams round-trip would inflict on
    // non-`key=value` hash content (e.g. anchors / client routes).
    let token: string | undefined;
    let apiKey: string | undefined;
    const kept: string[] = [];
    let consumedAny = false;

    for (const segment of rawHash.split("&")) {
      const eq = segment.indexOf("=");
      const key = eq === -1 ? segment : segment.slice(0, eq);
      const value = eq === -1 ? "" : segment.slice(eq + 1);

      if (key === HANDOFF_TOKEN_PARAM) {
        consumedAny = true; // drop from `kept` even if the value is empty
        token = safeDecode(value).trim() || undefined;
        continue;
      }
      if (key === HANDOFF_KEY_PARAM) {
        consumedAny = true;
        apiKey = safeDecode(value).trim() || undefined;
        continue;
      }
      kept.push(segment);
    }

    // No handoff params at all → leave the URL untouched.
    if (!consumedAny) return {};

    const result: HandoffCredential = {};

    // Persist exactly like the existing flows so a handed-in credential behaves
    // like a remembered one on subsequent reloads. NEVER log the value.
    if (token) {
      localStorage.setItem(STORAGE_KEY_TOKEN, token);
      result.token = token;
    }
    if (apiKey) {
      localStorage.setItem(STORAGE_KEY_API_KEY, apiKey);
      result.apiKey = apiKey;
    }

    // Strip the handoff params from the URL (preserving any other hash content)
    // so the credential is not persisted in the address bar or history.
    const newHash = kept.length > 0 ? `#${kept.join("&")}` : "";
    const { pathname, search } = window.location;
    history.replaceState(null, "", `${pathname}${search}${newHash}`);

    return result;
  } catch {
    // Never break app boot on a malformed hash — degrade to "no handoff".
    return {};
  }
}
