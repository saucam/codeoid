/**
 * Scrollback buffer tests — validates circular buffer behavior,
 * eviction, replay, and size limits.
 */

import { describe, test, expect } from "bun:test";
import { ScrollbackBuffer } from "../daemon/scrollback.js";
import type { SessionMessage } from "../protocol/types.js";
import { SYSTEM_IDENTITY } from "../protocol/types.js";

function makeMsg(content: string, sessionId = "s1"): SessionMessage {
  return {
    type: "session.message",
    sessionId,
    messageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role: "assistant",
    content,
    identity: SYSTEM_IDENTITY,
    timestamp: new Date().toISOString(),
  };
}

describe("ScrollbackBuffer", () => {
  test("push and read messages", () => {
    const buf = new ScrollbackBuffer();
    buf.push(makeMsg("hello"));
    buf.push(makeMsg("world"));

    const messages = buf.read();
    expect(messages).toHaveLength(2);
    expect((messages[0] as SessionMessage).content).toBe("hello");
    expect((messages[1] as SessionMessage).content).toBe("world");
  });

  test("read returns a snapshot (safe to modify)", () => {
    const buf = new ScrollbackBuffer();
    buf.push(makeMsg("a"));
    const snap = buf.read();
    buf.push(makeMsg("b"));

    expect(snap).toHaveLength(1);
    expect(buf.read()).toHaveLength(2);
  });

  test("evicts oldest when maxEntries exceeded", () => {
    const buf = new ScrollbackBuffer({ maxEntries: 3, maxBytes: 10_000_000 });
    buf.push(makeMsg("1"));
    buf.push(makeMsg("2"));
    buf.push(makeMsg("3"));
    buf.push(makeMsg("4"));

    const messages = buf.read();
    expect(messages).toHaveLength(3);
    expect((messages[0] as SessionMessage).content).toBe("2");
    expect((messages[2] as SessionMessage).content).toBe("4");
  });

  test("evicts when maxBytes exceeded", () => {
    // Each message is ~200 bytes when serialized
    const buf = new ScrollbackBuffer({ maxEntries: 1000, maxBytes: 500 });
    buf.push(makeMsg("a".repeat(200)));
    buf.push(makeMsg("b".repeat(200)));
    buf.push(makeMsg("c".repeat(200)));

    // Should have evicted oldest to stay under 500 bytes
    expect(buf.length).toBeLessThanOrEqual(2);
    expect(buf.bytes).toBeLessThanOrEqual(500);
  });

  test("length and bytes track correctly", () => {
    const buf = new ScrollbackBuffer();
    expect(buf.length).toBe(0);
    expect(buf.bytes).toBe(0);

    buf.push(makeMsg("hello"));
    expect(buf.length).toBe(1);
    expect(buf.bytes).toBeGreaterThan(0);
  });

  test("clear empties buffer", () => {
    const buf = new ScrollbackBuffer();
    buf.push(makeMsg("a"));
    buf.push(makeMsg("b"));
    buf.clear();

    expect(buf.length).toBe(0);
    expect(buf.bytes).toBe(0);
    expect(buf.read()).toHaveLength(0);
  });

  test("readSince filters by timestamp", () => {
    const buf = new ScrollbackBuffer();
    const t1 = "2026-01-01T00:00:00Z";
    const t2 = "2026-01-01T00:00:01Z";
    const t3 = "2026-01-01T00:00:02Z";

    buf.push({ ...makeMsg("old"), timestamp: t1 });
    buf.push({ ...makeMsg("mid"), timestamp: t2 });
    buf.push({ ...makeMsg("new"), timestamp: t3 });

    const since = buf.readSince(t1);
    expect(since).toHaveLength(2);
    expect((since[0] as SessionMessage).content).toBe("mid");
  });

  test("handles large number of messages", () => {
    const buf = new ScrollbackBuffer({ maxEntries: 500, maxBytes: 1_048_576 });
    for (let i = 0; i < 1000; i++) {
      buf.push(makeMsg(`msg-${i}`));
    }
    expect(buf.length).toBe(500);
    expect((buf.read()[0] as SessionMessage).content).toBe("msg-500");
  });

  test("default config: 500 entries, 1MB", () => {
    const buf = new ScrollbackBuffer();
    // Push 600 messages
    for (let i = 0; i < 600; i++) {
      buf.push(makeMsg(`m${i}`));
    }
    expect(buf.length).toBe(500);
  });
});
