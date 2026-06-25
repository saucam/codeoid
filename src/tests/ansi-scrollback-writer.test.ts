/**
 * ScrollbackWriter — the imperative replacement for Ink's <Static>.
 *
 * Invariants these tests pin down:
 *   1. Each (sessionId, messageId) pair is written at most once.
 *   2. Scrollback replay (batch of mixed old + new messages) only emits
 *      the new ones.
 *   3. Banner is emitted once per focus transition; re-focus the same
 *      session twice in a row is a no-op.
 *   4. Null focus clears the banner pointer so re-focusing re-announces.
 *   5. forget() purges all (session:*) keys so a re-created session
 *      starts fresh.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { SessionMessage } from "../protocol/types.js";
import { ScrollbackWriter } from "../tui/ansi/scrollback-writer.js";

function msg(id: string, content: string): SessionMessage {
  return {
    type: "session.message",
    sessionId: "s1",
    messageId: id,
    role: "user",
    content,
    identity: { sub: "user:t", name: "t", type: "human" },
    timestamp: "2026-04-21T00:00:00.000Z",
  };
}

function assistantDelta(id: string, content: string) {
  return {
    messageId: id,
    role: "assistant" as const,
    content,
    identity: {
      sub: "agent:t",
      name: "t",
      type: "agent" as const,
    },
  };
}

describe("ScrollbackWriter dedupe", () => {
  let lines: string[];
  let writer: ScrollbackWriter;
  beforeEach(() => {
    lines = [];
    writer = new ScrollbackWriter({
      log: (ln) => lines.push(ln),
      getCols: () => 80,
    });
  });

  it("emits a single message once", () => {
    writer.writeMessage("s1", msg("m1", "hello"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("hello");
  });

  it("deduplicates repeated writeMessage with same id", () => {
    writer.writeMessage("s1", msg("m1", "hello"));
    writer.writeMessage("s1", msg("m1", "hello"));
    writer.writeMessage("s1", msg("m1", "hello"));
    expect(lines.length).toBe(1);
  });

  it("ignores content changes after first emit (scrollback is immutable)", () => {
    writer.writeMessage("s1", msg("m1", "original"));
    writer.writeMessage("s1", msg("m1", "REDACTED"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("original");
    expect(lines[0]).not.toContain("REDACTED");
  });

  it("differentiates same message-id across different sessions", () => {
    writer.writeMessage("s1", msg("m1", "a"));
    writer.writeMessage("s2", msg("m1", "b"));
    expect(lines.length).toBe(2);
  });
});

describe("ScrollbackWriter.writeBatch", () => {
  let lines: string[];
  let writer: ScrollbackWriter;
  beforeEach(() => {
    lines = [];
    writer = new ScrollbackWriter({
      log: (ln) => lines.push(ln),
      getCols: () => 80,
    });
  });

  it("emits only never-seen messages on replay", () => {
    writer.writeMessage("s1", msg("m1", "alpha"));
    writer.writeMessage("s1", msg("m1", "alpha")); // duplicate — ignored
    const prevEmits = lines.length;

    // Replay: old m1 + new m2 + new m3. Only m2, m3 should reach output.
    writer.writeBatch("s1", [
      msg("m1", "alpha"),
      msg("m2", "beta"),
      msg("m3", "gamma"),
    ]);

    // Exactly one batched write after the initial single message.
    expect(lines.length).toBe(prevEmits + 1);
    const batch = lines[lines.length - 1]!;
    expect(batch).not.toContain("alpha"); // already seen, skipped
    expect(batch).toContain("beta");
    expect(batch).toContain("gamma");
  });

  it("is a no-op when every message in the batch is already seen", () => {
    writer.writeBatch("s1", [msg("m1", "a"), msg("m2", "b")]);
    const before = lines.length;
    writer.writeBatch("s1", [msg("m1", "a"), msg("m2", "b")]);
    expect(lines.length).toBe(before);
  });
});

describe("ScrollbackWriter banner behavior", () => {
  let lines: string[];
  let writer: ScrollbackWriter;
  const resolve = (id: string) =>
    id === "s1"
      ? { name: "alpha", workdir: "/tmp/a" }
      : id === "s2"
        ? { name: "beta", workdir: "/tmp/b" }
        : null;

  beforeEach(() => {
    lines = [];
    writer = new ScrollbackWriter({
      log: (ln) => lines.push(ln),
      getCols: () => 80,
    });
  });

  it("emits a banner on first focus", () => {
    writer.maybeEmitBanner("s1", resolve);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("alpha");
  });

  it("is a no-op when focus does not change", () => {
    writer.maybeEmitBanner("s1", resolve);
    writer.maybeEmitBanner("s1", resolve);
    writer.maybeEmitBanner("s1", resolve);
    expect(lines.length).toBe(1);
  });

  it("emits a new banner on focus change", () => {
    writer.maybeEmitBanner("s1", resolve);
    writer.maybeEmitBanner("s2", resolve);
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("beta");
  });

  it("null focus clears pointer; re-focusing re-announces", () => {
    writer.maybeEmitBanner("s1", resolve);
    writer.maybeEmitBanner(null, resolve);
    writer.maybeEmitBanner("s1", resolve);
    expect(lines.length).toBe(2); // initial + re-announcement
  });

  it("does not emit for unknown session but still updates pointer", () => {
    writer.maybeEmitBanner("unknown", resolve);
    expect(lines.length).toBe(0);
    // Re-calling the same id does not re-query resolver.
    writer.maybeEmitBanner("unknown", resolve);
    expect(lines.length).toBe(0);
  });
});

describe("ScrollbackWriter.forget", () => {
  let lines: string[];
  let writer: ScrollbackWriter;
  beforeEach(() => {
    lines = [];
    writer = new ScrollbackWriter({
      log: (ln) => lines.push(ln),
      getCols: () => 80,
    });
  });

  it("clears the seen-set for one session only", () => {
    writer.writeMessage("s1", msg("m1", "a"));
    writer.writeMessage("s2", msg("m1", "b"));
    writer.forget("s1");
    // m1 on s1 is forgotten — re-writing emits.
    writer.writeMessage("s1", msg("m1", "a"));
    // m1 on s2 is still remembered — re-writing is a no-op.
    writer.writeMessage("s2", msg("m1", "b"));
    expect(lines.length).toBe(3); // original 2 + s1:m1 re-emit
  });

  it("clears banner pointer when the focused session is forgotten", () => {
    const resolve = (_id: string) => ({ name: "x", workdir: "/tmp" });
    writer.maybeEmitBanner("s1", resolve);
    writer.forget("s1");
    writer.maybeEmitBanner("s1", resolve);
    expect(lines.length).toBe(2); // banner emitted twice
  });
});

describe("ScrollbackWriter streaming", () => {
  let lines: string[];
  let writer: ScrollbackWriter;
  beforeEach(() => {
    lines = [];
    writer = new ScrollbackWriter({
      log: (ln) => lines.push(ln),
      getCols: () => 80,
    });
  });

  it("emits a header on first delta, body only on subsequent ones", () => {
    writer.streamDelta("s1", assistantDelta("m1", "Hello"));
    // Header emitted; body buffered because no newline yet.
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("Claude");
  });

  it("flushes complete lines and keeps partials buffered", () => {
    writer.streamDelta("s1", assistantDelta("m1", "line one\n"));
    // Header + the "line one" flush.
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("line one");
    writer.streamDelta("s1", assistantDelta("m1", "line one\ntrailing"));
    // "trailing" is buffered (no newline); no new line.
    expect(lines.length).toBe(2);
  });

  it("finalizeStream flushes the buffered partial and marks emitted", () => {
    writer.streamDelta("s1", assistantDelta("m1", "partial no newline"));
    expect(lines.length).toBe(1); // header only
    writer.finalizeStream("s1", "m1");
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("partial no newline");
    // Subsequent writeMessage is a no-op — already emitted.
    writer.writeMessage("s1", msg("m1", "partial no newline"));
    expect(lines.length).toBe(2);
  });

  it("writeMessage is a no-op for messages currently streaming", () => {
    writer.streamDelta("s1", assistantDelta("m1", "hi\n"));
    const before = lines.length;
    writer.writeMessage("s1", msg("m1", "hi"));
    expect(lines.length).toBe(before); // writeMessage skipped
  });

  it("writeBatch is a no-op for messages currently streaming (no double-print)", () => {
    // Reproduces the duplicate-response bug: a streamed assistant message
    // finalizes. In App.tsx the committed-emission effect (writeBatch) runs
    // BEFORE the stream-finalize effect, so writeBatch sees the message
    // while it's still an active stream. Without the #streams guard it
    // re-renders the whole body, then finalizeStream flushes the buffer —
    // printing the response twice.
    writer.streamDelta("s1", assistantDelta("m1", "Which thread do you want to pull?"));
    // Header emitted; body buffered (no trailing newline).
    const afterStream = lines.length;

    // Committed-emission effect fires first, while the stream is still open.
    writer.writeBatch("s1", [
      msg("m1", "Which thread do you want to pull?"),
    ]);
    expect(lines.length).toBe(afterStream); // writeBatch skipped the live stream

    // Stream-finalize effect runs second and seals the body — once.
    writer.finalizeStream("s1", "m1");
    const body = lines.filter((l) => l.includes("Which thread do you want to pull?"));
    expect(body.length).toBe(1);
  });

  it("forget() wipes stream buffers too", () => {
    writer.streamDelta("s1", assistantDelta("m1", "buffered"));
    writer.forget("s1");
    // After forget, a fresh streamDelta for the same id re-emits a header.
    writer.streamDelta("s1", assistantDelta("m1", "new"));
    const headerLines = lines.filter((l) => l.includes("Claude"));
    expect(headerLines.length).toBe(2);
  });
});

describe("ScrollbackWriter output format", () => {
  it("strips the renderer's trailing newline so console.log does not double it", () => {
    const lines: string[] = [];
    const writer = new ScrollbackWriter({
      log: (ln) => lines.push(ln),
      getCols: () => 80,
    });
    writer.writeMessage("s1", msg("m1", "hi"));
    // The single write we received does NOT end with \n — console.log
    // supplies its own trailing newline.
    expect(lines[0]!.endsWith("\n")).toBe(false);
  });
});
