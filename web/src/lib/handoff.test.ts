// @vitest-environment jsdom
/**
 * URL-hash credential handoff tests — consumeHandoffCredential.
 *
 * Covers:
 *   A. token case   — #codeoid_token=<JWT> persists to codeoid.token
 *   B. key case     — #codeoid_key=<zid_sk_...> persists to codeoid.apiKey
 *   C. both at once — token + key handed together
 *   D. empty/malformed — no hash, empty value, unknown params, non-throwing
 *   E. hash-stripping — the credential is removed from the URL on consume
 *   F. other-hash-preserved — unrelated hash content survives the strip
 *   G. value handling — URL-encoded values are decoded; whitespace trimmed
 */

import { describe, it, expect, beforeEach } from "vitest";
import { consumeHandoffCredential } from "./handoff";
import { STORAGE_KEY_API_KEY, STORAGE_KEY_TOKEN } from "./auth";

/** Reset URL + storage before each test so cases don't leak into each other. */
function setHash(hash: string): void {
  history.replaceState(null, "", `/ui/${hash}`);
}

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/ui/");
});

// ── A. token case ─────────────────────────────────────────────────────────────

describe("consumeHandoffCredential — token", () => {
  it("reads #codeoid_token, persists it, and strips the hash", () => {
    setHash("#codeoid_token=jwt-abc");
    const result = consumeHandoffCredential();

    expect(result).toEqual({ token: "jwt-abc" });
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBe("jwt-abc");
    expect(localStorage.getItem(STORAGE_KEY_API_KEY)).toBeNull();
    expect(window.location.hash).toBe("");
  });
});

// ── B. key case ───────────────────────────────────────────────────────────────

describe("consumeHandoffCredential — api key", () => {
  it("reads #codeoid_key, persists it, and strips the hash", () => {
    setHash("#codeoid_key=zid_sk_xyz");
    const result = consumeHandoffCredential();

    expect(result).toEqual({ apiKey: "zid_sk_xyz" });
    expect(localStorage.getItem(STORAGE_KEY_API_KEY)).toBe("zid_sk_xyz");
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
    expect(window.location.hash).toBe("");
  });
});

// ── C. both at once ───────────────────────────────────────────────────────────

describe("consumeHandoffCredential — token + key together", () => {
  it("consumes both and strips both", () => {
    setHash("#codeoid_token=jwt-1&codeoid_key=zid_sk_2");
    const result = consumeHandoffCredential();

    expect(result).toEqual({ token: "jwt-1", apiKey: "zid_sk_2" });
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBe("jwt-1");
    expect(localStorage.getItem(STORAGE_KEY_API_KEY)).toBe("zid_sk_2");
    expect(window.location.hash).toBe("");
  });
});

// ── D. empty / malformed ──────────────────────────────────────────────────────

describe("consumeHandoffCredential — empty / malformed", () => {
  it("returns {} and writes nothing when there is no hash", () => {
    const result = consumeHandoffCredential();
    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY_API_KEY)).toBeNull();
  });

  it("treats an empty credential value as absent (but still strips it)", () => {
    setHash("#codeoid_token=");
    const result = consumeHandoffCredential();
    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
    // The empty handoff param is still removed from the URL.
    expect(window.location.hash).toBe("");
  });

  it("ignores unknown hash params and leaves the URL untouched", () => {
    setHash("#some_other=value&foo=bar");
    const result = consumeHandoffCredential();
    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY_API_KEY)).toBeNull();
    // Unknown content is preserved verbatim (no known param → no rewrite).
    expect(window.location.hash).toBe("#some_other=value&foo=bar");
  });

  it("ignores a bare anchor-style hash with no params", () => {
    setHash("#section-2");
    const result = consumeHandoffCredential();
    expect(result).toEqual({});
    expect(window.location.hash).toBe("#section-2");
  });

  it("does not throw on a malformed percent-encoding", () => {
    setHash("#codeoid_token=%E0%A4%A"); // truncated escape → decode would throw
    let result: ReturnType<typeof consumeHandoffCredential>;
    expect(() => {
      result = consumeHandoffCredential();
    }).not.toThrow();
    // safeDecode falls back to the raw value, which is non-empty here.
    expect(result!.token).toBe("%E0%A4%A");
  });
});

// ── E. hash stripping ─────────────────────────────────────────────────────────

describe("consumeHandoffCredential — hash stripping", () => {
  it("leaves no trace of the credential in the URL after consuming", () => {
    setHash("#codeoid_token=super-secret-jwt");
    consumeHandoffCredential();
    expect(window.location.href).not.toContain("super-secret-jwt");
    expect(window.location.hash).toBe("");
  });
});

// ── F. other hash content preserved ───────────────────────────────────────────

describe("consumeHandoffCredential — preserves other hash content", () => {
  it("strips only the handoff params, keeping unrelated hash params", () => {
    setHash("#codeoid_token=jwt-x&view=settings&tab=providers");
    const result = consumeHandoffCredential();

    expect(result).toEqual({ token: "jwt-x" });
    expect(window.location.hash).toBe("#view=settings&tab=providers");
  });

  it("preserves other content when it precedes the handoff param", () => {
    setHash("#view=settings&codeoid_key=zid_sk_9");
    const result = consumeHandoffCredential();

    expect(result).toEqual({ apiKey: "zid_sk_9" });
    expect(window.location.hash).toBe("#view=settings");
  });
});

// ── G. value handling ─────────────────────────────────────────────────────────

describe("consumeHandoffCredential — value handling", () => {
  it("URL-decodes the credential value", () => {
    setHash(`#codeoid_key=${encodeURIComponent("zid_sk_a b")}`);
    const result = consumeHandoffCredential();
    expect(result.apiKey).toBe("zid_sk_a b");
  });

  it("trims surrounding whitespace and treats whitespace-only as empty", () => {
    setHash(`#codeoid_token=${encodeURIComponent("   ")}`);
    const result = consumeHandoffCredential();
    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
  });
});
