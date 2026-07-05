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

  test("readChunkedSince filters by mutation seq (supersedes timestamp catch-up)", () => {
    const buf = new ScrollbackBuffer();
    buf.push(makeMsg("old"));
    const cursor = buf.maxSeq;
    buf.push(makeMsg("mid"));
    buf.push(makeMsg("new"));

    const since = buf.readChunkedSince(cursor, 10 * 1024 * 1024).flat();
    expect(since).toHaveLength(2);
    expect((since[0] as SessionMessage).content).toBe("mid");
    expect((since[1] as SessionMessage).content).toBe("new");
  });

  test("handles large number of messages", () => {
    const buf = new ScrollbackBuffer({ maxEntries: 500, maxBytes: 1_048_576 });
    for (let i = 0; i < 1000; i++) {
      buf.push(makeMsg(`msg-${i}`));
    }
    expect(buf.length).toBe(500);
    expect((buf.read()[0] as SessionMessage).content).toBe("msg-500");
  });

  test("default config keeps up to 5000 entries", () => {
    const buf = new ScrollbackBuffer();
    for (let i = 0; i < 5050; i++) {
      buf.push(makeMsg(`m${i}`));
    }
    expect(buf.length).toBe(5000);
  });

  test("updateMessage re-accounts bytes when an entry grows in place", () => {
    const buf = new ScrollbackBuffer();
    const msg = makeMsg("x");
    buf.push(msg);
    const before = buf.bytes;
    buf.updateMessage(msg.messageId, (m) => {
      (m as SessionMessage).content = "y".repeat(10_000);
    });
    // bytes grew by ~the added content (not left stale), and exactly matches
    // the entry's serialized size — so later eviction subtracts the right
    // amount instead of drifting #bytes negative.
    expect(buf.bytes).toBeGreaterThan(before + 9_000);
    expect(buf.bytes).toBe(JSON.stringify(buf.read()[0]).length);
  });
});

describe("ScrollbackBuffer — sizeHint", () => {
  test("push honors a caller-provided size hint instead of re-serializing", () => {
    // Real serialized size of each message is ~150+ bytes; hints say 10.
    // With a 300-byte cap, hinted accounting keeps all five messages —
    // re-serialization would have evicted some.
    const buf = new ScrollbackBuffer({ maxEntries: 1000, maxBytes: 300 });
    for (let i = 0; i < 5; i++) {
      buf.push(makeMsg(`hinted message ${i} ${"p".repeat(200)}`), 10);
    }
    expect(buf.length).toBe(5);
    expect(buf.bytes).toBe(50);
  });

  test("push re-accounts an existing entry using the new size hint", () => {
    const buf = new ScrollbackBuffer({ maxEntries: 1000, maxBytes: 1000 });
    const msg = makeMsg("original");
    buf.push(msg, 10);
    buf.push({ ...msg, content: "updated" }, 25);
    expect(buf.length).toBe(1);
    expect(buf.bytes).toBe(25);
  });
});

describe("ScrollbackBuffer — readChunked (#84)", () => {
  const sizeOf = (m: SessionMessage) => Buffer.byteLength(JSON.stringify(m), "utf8");

  test("returns [] for an empty buffer", () => {
    expect(new ScrollbackBuffer().readChunked(1000)).toEqual([]);
  });

  test("returns a single chunk when everything fits the budget", () => {
    const buf = new ScrollbackBuffer();
    buf.push(makeMsg("a"));
    buf.push(makeMsg("b"));
    const chunks = buf.readChunked(10 * 1024 * 1024);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  test("partitions into ordered chunks that cover every message exactly once", () => {
    const buf = new ScrollbackBuffer();
    const pushed: SessionMessage[] = [];
    for (let i = 0; i < 10; i++) {
      const m = makeMsg(`m${i}-${"x".repeat(100)}`);
      pushed.push(m);
      buf.push(m);
    }
    // Budget that holds ~2 messages, forcing multiple chunks.
    const budget = sizeOf(pushed[0]!) * 2 + 10;
    const chunks = buf.readChunked(budget);

    expect(chunks.length).toBeGreaterThan(1);
    // Flattened chunks equal the buffer read() — same messages, same order.
    const flat = chunks.flat();
    expect(flat).toEqual(buf.read());
    // No empty chunks; every multi-message chunk stays within the budget.
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      if (chunk.length > 1) {
        const bytes = chunk.reduce((n, m) => n + sizeOf(m as SessionMessage), 0);
        expect(bytes).toBeLessThanOrEqual(budget);
      }
    }
  });

  test("a message larger than the budget occupies its own chunk (never split)", () => {
    const buf = new ScrollbackBuffer();
    buf.push(makeMsg("a"));
    buf.push(makeMsg("B".repeat(5000)));
    buf.push(makeMsg("c"));
    const chunks = buf.readChunked(500);
    expect(chunks).toHaveLength(3);
    expect(chunks[1]).toHaveLength(1);
    expect((chunks[1]![0] as SessionMessage).content.startsWith("B")).toBe(true);
    expect(chunks.flat()).toEqual(buf.read());
  });
});

describe("ScrollbackBuffer — seq & incremental resume (replay.resume)", () => {
  test("push assigns strictly increasing seqs; maxSeq tracks; message is stamped", () => {
    const buf = new ScrollbackBuffer();
    expect(buf.maxSeq).toBe(0);
    const m1 = makeMsg("one");
    const m2 = makeMsg("two");
    buf.push(m1);
    buf.push(m2);
    expect(buf.maxSeq).toBe(2);
    // Live pushes stamp the message object so the broadcast frame (same
    // reference) carries the cursor on the wire.
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
  });

  test("push with a sizeHint (restore path) does NOT stamp the message", () => {
    const buf = new ScrollbackBuffer();
    const m = makeMsg("restored");
    buf.push(m, 100);
    expect(m.seq).toBeUndefined();
    expect(buf.maxSeq).toBe(1); // entry still gets a seq internally
  });

  test("touch bumps the counter, returns the new seq, undefined for unknown ids", () => {
    const buf = new ScrollbackBuffer();
    const m = makeMsg("streamed");
    buf.push(m);
    const seq = buf.touch(m.messageId);
    expect(seq).toBe(2);
    expect(buf.maxSeq).toBe(2);
    // The buffered message is re-stamped so replays emit a self-consistent
    // per-message seq (entry.seq === msg.seq), never a stale push-time value.
    expect(m.seq).toBe(2);
    expect((buf.read()[0] as SessionMessage).seq).toBe(2);
    expect(buf.touch("nope")).toBeUndefined();
    expect(buf.maxSeq).toBe(2); // failed touch doesn't burn a seq
  });

  test("upsert push and updateMessage advance the entry past an old cursor", () => {
    const buf = new ScrollbackBuffer();
    const m = makeMsg("v1");
    buf.push(m);
    buf.push(makeMsg("other"));
    const cursor = buf.maxSeq; // client saw both

    // Mutation via updateMessage → entry must be resent to a resuming client,
    // carrying the post-mutation seq (not the stale push-time one).
    buf.updateMessage(m.messageId, (msg) => {
      (msg as SessionMessage).content = "v2";
    });
    const tail = buf.readChunkedSince(cursor, 10 * 1024 * 1024).flat();
    expect(tail).toHaveLength(1);
    expect((tail[0] as SessionMessage).content).toBe("v2");
    expect((tail[0] as SessionMessage).seq).toBe(buf.maxSeq);

    // Fully caught up → empty.
    expect(buf.readChunkedSince(buf.maxSeq, 10 * 1024 * 1024)).toEqual([]);
  });

  test("readChunkedSince preserves buffer order and respects the byte budget", () => {
    const buf = new ScrollbackBuffer();
    buf.push(makeMsg("before-cursor"));
    const cursor = buf.maxSeq;
    for (let i = 0; i < 6; i++) buf.push(makeMsg(`tail-${i}-${"x".repeat(150)}`));

    const budget = 2 * Buffer.byteLength(JSON.stringify(makeMsg(`tail-0-${"x".repeat(150)}`))) + 20;
    const chunks = buf.readChunkedSince(cursor, budget);
    expect(chunks.length).toBeGreaterThan(1);
    const flat = chunks.flat() as SessionMessage[];
    expect(flat).toHaveLength(6);
    expect(flat.map((m) => m.content.split("-")[1])).toEqual(["0", "1", "2", "3", "4", "5"]);
    for (const chunk of chunks) expect(chunk.length).toBeGreaterThan(0);
  });
});
