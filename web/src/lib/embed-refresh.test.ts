// @vitest-environment jsdom
/**
 * embed-refresh.ts tests — installEmbedTokenRefresh.
 *
 * All cases assume we have a DOM (jsdom). Gate conditions tested:
 *   1. Not framed (top === self) → no listener, onRefresh never called.
 *   2. Framed, empty allowlist → no listener, onRefresh never called.
 *   3. Framed, allowlist, WRONG origin → onRefresh NOT called.
 *   4. Framed, allowlist, correct origin, wrong message type → NOT called.
 *   5. Framed, allowlist, correct origin, token not a string → NOT called.
 *   6. Framed, allowlist, correct origin, empty token string → NOT called.
 *   7. Framed, allowlist, correct origin, correct shape → onRefresh called.
 *   8. Origin matching is case-insensitive (Studio origin in Mixed case).
 *   9. Cleanup: returned function removes the listener.
 *  10. Non-object data ignored.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { installEmbedTokenRefresh, EMBED_REFRESH_TYPE } from "./embed-refresh";

const ALLOWED = "https://studio.highflame.com";
const OTHER = "https://evil.example.com";
const ALLOWLIST = [ALLOWED];
const FRESH_TOKEN = "eyJhbGciOiJSUzI1NiJ9.fresh.token";

function simulateMessage(origin: string, data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data, origin }));
}

/** Make window.top !== window.self (framed). */
function setFramed(framed: boolean): void {
  Object.defineProperty(window, "top", {
    configurable: true,
    value: framed ? ({} as Window) : window,
  });
}

beforeEach(() => {
  setFramed(true);
});

describe("installEmbedTokenRefresh", () => {
  it("returns noop and never calls onRefresh when not framed", () => {
    setFramed(false);
    const onRefresh = vi.fn();
    const cleanup = installEmbedTokenRefresh({ allowedOrigins: ALLOWLIST, onRefresh });

    simulateMessage(ALLOWED, { type: EMBED_REFRESH_TYPE, token: FRESH_TOKEN });

    expect(onRefresh).not.toHaveBeenCalled();
    expect(cleanup).toBeTypeOf("function");
    cleanup(); // must not throw
  });

  it("returns noop when allowedOrigins is empty", () => {
    const onRefresh = vi.fn();
    const cleanup = installEmbedTokenRefresh({ allowedOrigins: [], onRefresh });

    simulateMessage(ALLOWED, { type: EMBED_REFRESH_TYPE, token: FRESH_TOKEN });

    expect(onRefresh).not.toHaveBeenCalled();
    cleanup();
  });

  it("ignores messages from an origin not in the allowlist", () => {
    const onRefresh = vi.fn();
    const cleanup = installEmbedTokenRefresh({ allowedOrigins: ALLOWLIST, onRefresh });

    simulateMessage(OTHER, { type: EMBED_REFRESH_TYPE, token: FRESH_TOKEN });

    expect(onRefresh).not.toHaveBeenCalled();
    cleanup();
  });

  it("ignores messages with the wrong type", () => {
    const onRefresh = vi.fn();
    const cleanup = installEmbedTokenRefresh({ allowedOrigins: ALLOWLIST, onRefresh });

    simulateMessage(ALLOWED, { type: "SOME_OTHER_MESSAGE", token: FRESH_TOKEN });

    expect(onRefresh).not.toHaveBeenCalled();
    cleanup();
  });

  it("ignores messages where token is not a string", () => {
    const onRefresh = vi.fn();
    const cleanup = installEmbedTokenRefresh({ allowedOrigins: ALLOWLIST, onRefresh });

    simulateMessage(ALLOWED, { type: EMBED_REFRESH_TYPE, token: 42 });

    expect(onRefresh).not.toHaveBeenCalled();
    cleanup();
  });

  it("ignores messages where token is an empty string", () => {
    const onRefresh = vi.fn();
    const cleanup = installEmbedTokenRefresh({ allowedOrigins: ALLOWLIST, onRefresh });

    simulateMessage(ALLOWED, { type: EMBED_REFRESH_TYPE, token: "   " });

    expect(onRefresh).not.toHaveBeenCalled();
    cleanup();
  });

  it("ignores non-object data", () => {
    const onRefresh = vi.fn();
    const cleanup = installEmbedTokenRefresh({ allowedOrigins: ALLOWLIST, onRefresh });

    simulateMessage(ALLOWED, "just a string");
    simulateMessage(ALLOWED, null);
    simulateMessage(ALLOWED, 123);

    expect(onRefresh).not.toHaveBeenCalled();
    cleanup();
  });

  it("calls onRefresh with the token when gate passes", async () => {
    const onRefresh = vi.fn();
    const cleanup = installEmbedTokenRefresh({ allowedOrigins: ALLOWLIST, onRefresh });

    simulateMessage(ALLOWED, { type: EMBED_REFRESH_TYPE, token: FRESH_TOKEN });

    // onRefresh is called synchronously inside the message handler
    await Promise.resolve(); // flush any microtasks
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledWith(FRESH_TOKEN);
    cleanup();
  });

  it("trims whitespace from the token before calling onRefresh", async () => {
    const onRefresh = vi.fn();
    const cleanup = installEmbedTokenRefresh({ allowedOrigins: ALLOWLIST, onRefresh });

    simulateMessage(ALLOWED, { type: EMBED_REFRESH_TYPE, token: `  ${FRESH_TOKEN}  ` });

    await Promise.resolve();
    expect(onRefresh).toHaveBeenCalledWith(FRESH_TOKEN);
    cleanup();
  });

  it("origin matching is case-insensitive", async () => {
    const onRefresh = vi.fn();
    const cleanup = installEmbedTokenRefresh({
      allowedOrigins: ["HTTPS://Studio.Highflame.Com"],
      onRefresh,
    });

    simulateMessage(ALLOWED, { type: EMBED_REFRESH_TYPE, token: FRESH_TOKEN });

    await Promise.resolve();
    expect(onRefresh).toHaveBeenCalledOnce();
    cleanup();
  });

  it("cleanup removes the listener so subsequent messages are ignored", async () => {
    const onRefresh = vi.fn();
    const cleanup = installEmbedTokenRefresh({ allowedOrigins: ALLOWLIST, onRefresh });

    cleanup();

    simulateMessage(ALLOWED, { type: EMBED_REFRESH_TYPE, token: FRESH_TOKEN });

    await Promise.resolve();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("swallows errors thrown by onRefresh (does not propagate)", async () => {
    const onRefresh = vi.fn().mockRejectedValue(new Error("bootstrap failed"));
    const cleanup = installEmbedTokenRefresh({ allowedOrigins: ALLOWLIST, onRefresh });

    // Should not throw to window error handlers.
    expect(() =>
      simulateMessage(ALLOWED, { type: EMBED_REFRESH_TYPE, token: FRESH_TOKEN }),
    ).not.toThrow();

    await Promise.resolve();
    expect(onRefresh).toHaveBeenCalledOnce();
    cleanup();
  });
});
