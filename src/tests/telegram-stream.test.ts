/**
 * Telegram StreamRelay tests — exactly-once, in-order delivery of streamed
 * content.
 *
 * Unlike the older telegram tests that mirror module-private logic, these
 * exercise the REAL StreamRelay from src/frontends/telegram/stream.ts with a
 * fake Telegram API injected through the RelayApi seam (same spirit: offline,
 * no Bot, side effects captured via callbacks).
 *
 * What we verify:
 *   1. A streamed turn (empty start → deltas → final full rebroadcast → idle)
 *      delivers the content EXACTLY ONCE, with "✅ Done." after it.
 *   2. Thinking blocks are delivered exactly once.
 *   3. A mid-stream tool_call broadcast neither drops nor duplicates streamed
 *      text, and content arrives in order around the tool line.
 *   4. Thinking flushes that fail Markdown parsing retry as plain text.
 *   5. sendChunked emits >4000-char content as ordered, sequential chunks
 *      split on line boundaries.
 *   6. chunkText edge cases.
 */

import { describe, it, expect } from "bun:test";
import {
  StreamRelay,
  chunkText,
  type RelayApi,
} from "../frontends/telegram/stream.js";
import type {
  SessionMessage,
  SessionMessageDelta,
  ToolState,
} from "../protocol/types.js";

const CHAT = 999_001;

// ── Fake Telegram API ─────────────────────────────────────────────────────────

interface SentMessage {
  chatId: number;
  text: string;
  opts?: Record<string, unknown>;
}

function makeApi(options?: {
  /** Reject the send when this returns true (simulates a Telegram 400). */
  failWhen?: (text: string, opts?: Record<string, unknown>) => boolean;
  /** Per-send artificial delay in ms (to catch out-of-order parallel sends). */
  delayMs?: (callIndex: number) => number;
}) {
  const sent: SentMessage[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const api: RelayApi = {
    async sendMessage(chatId, text, opts) {
      const idx = calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const delay = options?.delayMs?.(idx) ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      inFlight--;
      if (options?.failWhen?.(text, opts)) {
        throw new Error("400: Bad Request: can't parse entities");
      }
      sent.push({ chatId, text, opts });
      return { message_id: sent.length };
    },
  };
  return {
    api,
    sent,
    texts: () => sent.map((m) => m.text),
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

/** Minimal full session.message (fields the relay doesn't read are stubbed). */
function full(
  messageId: string,
  role: SessionMessage["role"],
  content: string,
  tool?: SessionMessage["tool"],
): SessionMessage {
  return {
    type: "session.message",
    sessionId: "sess-1",
    messageId,
    role,
    content,
    tool,
    identity: { sub: "agent:test", type: "agent" },
    timestamp: new Date().toISOString(),
  } as SessionMessage;
}

function delta(messageId: string, contentAppend: string): SessionMessageDelta {
  return {
    type: "session.message.delta",
    sessionId: "sess-1",
    messageId,
    contentAppend,
    timestamp: new Date().toISOString(),
  };
}

/** Count non-overlapping occurrences of `needle` across all sent texts. */
function countOccurrences(haystacks: string[], needle: string): number {
  return haystacks.reduce((n, t) => n + t.split(needle).length - 1, 0);
}

// ── Exactly-once delivery ─────────────────────────────────────────────────────

describe("StreamRelay — exactly-once streamed delivery", () => {
  it("streamed assistant turn (start, deltas, final rebroadcast, idle) delivers content exactly once", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    // Daemon flow: empty assistant message opens the stream…
    relay.handleMessage(CHAT, full("m1", "assistant", ""));
    // …deltas accumulate…
    relay.handleDelta(CHAT, delta("m1", "Hello "));
    relay.handleDelta(CHAT, delta("m1", "world"));
    // …the daemon re-broadcasts the finished message with full content…
    relay.handleMessage(CHAT, full("m1", "assistant", "Hello world"));
    // …then the session goes idle (this used to re-send the buffer).
    relay.flushIdle(CHAT);
    await relay.settle();

    expect(countOccurrences(texts(), "Hello world")).toBe(1);
    expect(texts()).toEqual(["Hello world", "✅ Done."]);
    expect(relay.bufferCount).toBe(0);
  });

  it("thinking block is delivered exactly once", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleMessage(CHAT, full("t1", "thinking", ""));
    relay.handleDelta(CHAT, delta("t1", "pondering deeply"));
    relay.handleMessage(CHAT, full("t1", "thinking", "pondering deeply"));
    relay.flushIdle(CHAT);
    await relay.settle();

    expect(countOccurrences(texts(), "pondering deeply")).toBe(1);
    const thinkingSends = texts().filter((t) => t.startsWith("💭"));
    expect(thinkingSends).toHaveLength(1);
    // "Done" arrives last.
    expect(texts().at(-1)).toBe("✅ Done.");
  });

  it("assistant content that never streamed (direct full message) is sent once", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleMessage(CHAT, full("m1", "assistant", "one-shot answer"));
    relay.flushIdle(CHAT);
    await relay.settle();

    expect(texts()).toEqual(["one-shot answer", "✅ Done."]);
  });

  it("turn that ends without a final rebroadcast still flushes the buffer once on idle", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleMessage(CHAT, full("m1", "assistant", ""));
    relay.handleDelta(CHAT, delta("m1", "partial answer"));
    relay.flushIdle(CHAT);
    await relay.settle();

    expect(texts()).toEqual(["partial answer", "✅ Done."]);
  });

  it("duplicate empty start does not reset an accumulating buffer", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleMessage(CHAT, full("m1", "assistant", ""));
    relay.handleDelta(CHAT, delta("m1", "abc"));
    relay.handleMessage(CHAT, full("m1", "assistant", "")); // dup start
    relay.handleDelta(CHAT, delta("m1", "def"));
    relay.flushIdle(CHAT);
    await relay.settle();

    expect(texts()).toEqual(["abcdef", "✅ Done."]);
  });
});

// ── Interleaved tool calls ────────────────────────────────────────────────────

describe("StreamRelay — mid-stream tool_call interleaving", () => {
  it("tool_call broadcast mid-stream flushes the prefix, keeps the buffer live, no dup, in order", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleMessage(CHAT, full("m1", "assistant", ""));
    relay.handleDelta(CHAT, delta("m1", "Let me check. "));

    // A tool_call broadcast with a DIFFERENT messageId arrives mid-stream.
    relay.handleMessage(
      CHAT,
      full("tc1", "tool_call", "", {
        toolId: "tu-1",
        name: "Bash",
        state: { phase: "executing" },
      }),
    );

    // Later deltas for m1 must NOT be dropped (buffer stayed live).
    relay.handleDelta(CHAT, delta("m1", "Found it."));
    // Final rebroadcast carries the FULL content; only the tail may be sent.
    relay.handleMessage(CHAT, full("m1", "assistant", "Let me check. Found it."));
    relay.flushIdle(CHAT);
    await relay.settle();

    expect(texts()).toEqual([
      "Let me check. ",
      "⚡ Bash",
      "Found it.",
      "✅ Done.",
    ]);
    // Exactly once overall.
    expect(countOccurrences(texts(), "Let me check. ")).toBe(1);
    expect(countOccurrences(texts(), "Found it.")).toBe(1);
  });

  it("multiple interleavings never duplicate or reorder streamed text", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleMessage(CHAT, full("m1", "assistant", ""));
    relay.handleDelta(CHAT, delta("m1", "A"));
    relay.handleMessage(
      CHAT,
      full("tc1", "tool_call", "", { toolId: "t1", name: "Read", state: { phase: "executing" } }),
    );
    relay.handleDelta(CHAT, delta("m1", "B"));
    relay.handleMessage(
      CHAT,
      full("tc2", "tool_call", "", { toolId: "t2", name: "Grep", state: { phase: "executing" } }),
    );
    relay.handleDelta(CHAT, delta("m1", "C"));
    relay.handleMessage(CHAT, full("m1", "assistant", "ABC"));
    relay.flushIdle(CHAT);
    await relay.settle();

    expect(texts()).toEqual(["A", "⚡ Read", "B", "⚡ Grep", "C", "✅ Done."]);
  });
});

// ── Thinking Markdown fallback ────────────────────────────────────────────────

describe("StreamRelay — thinking parse-failure fallback", () => {
  it("retries as plain text when Markdown parse fails instead of dropping the thought", async () => {
    // Fail any send that carries a parse_mode (simulates Telegram 400 on
    // unbalanced markdown in raw model text).
    const { api, sent } = makeApi({
      failWhen: (_text, opts) => opts?.parse_mode !== undefined,
    });
    const relay = new StreamRelay(api);

    relay.handleMessage(CHAT, full("t1", "thinking", "unbalanced *bold _and `tick"));
    await relay.settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.opts?.parse_mode).toBeUndefined();
    expect(sent[0]!.text).toContain("unbalanced *bold _and `tick");
  });

  it("keeps parse_mode Markdown when it succeeds", async () => {
    const { api, sent } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleMessage(CHAT, full("t1", "thinking", "clean thought"));
    await relay.settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.opts?.parse_mode).toBe("Markdown");
  });
});

// ── Chunking ──────────────────────────────────────────────────────────────────

describe("chunkText", () => {
  it("returns [] for empty text and [text] under the limit", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("short")).toEqual(["short"]);
    expect(chunkText("x".repeat(4000))).toEqual(["x".repeat(4000)]);
  });

  it("splits on line boundaries when a newline exists in the window", () => {
    const line = "y".repeat(3000);
    const text = `${line}\n${line}`;
    const chunks = chunkText(text);
    expect(chunks).toEqual([line, line]);
  });

  it("hard-cuts a single line longer than the limit", () => {
    const text = "z".repeat(9000);
    const chunks = chunkText(text);
    expect(chunks.map((c) => c.length)).toEqual([4000, 4000, 1000]);
    expect(chunks.join("")).toBe(text);
  });

  it("every chunk fits the limit and content is preserved modulo boundary newlines", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${"a".repeat(40)}`).join("\n");
    const chunks = chunkText(text);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
    expect(chunks.join("\n")).toBe(text);
  });
});

describe("StreamRelay — sequential chunked sends", () => {
  it("emits chunks in order even when individual sends are slow", async () => {
    // First send is slow; if chunks were fired in parallel, chunk 2 would
    // land before chunk 1.
    const fake = makeApi({
      delayMs: (i) => (i === 0 ? 30 : 0),
    });
    const relay = new StreamRelay(fake.api);

    const first = "a".repeat(3999);
    const second = "b".repeat(3999);
    const third = "c".repeat(100);
    relay.sendChunked(CHAT, `${first}\n${second}\n${third}`);
    await relay.settle();

    expect(fake.texts()).toEqual([first, second, third]);
    // Sequential: never more than one send in flight.
    expect(fake.maxInFlight).toBe(1);
  });

  it("'✅ Done.' never overtakes a long flush", async () => {
    const { api, texts } = makeApi({ delayMs: (i) => (i === 0 ? 20 : 0) });
    const relay = new StreamRelay(api);

    relay.handleMessage(CHAT, full("m1", "assistant", ""));
    relay.handleDelta(CHAT, delta("m1", "x".repeat(8100)));
    relay.flushIdle(CHAT);
    await relay.settle();

    const all = texts();
    expect(all.at(-1)).toBe("✅ Done.");
    expect(all.slice(0, -1).join("")).toBe("x".repeat(8100));
  });

  it("a failed chunk does not abort or reorder the remaining chunks", async () => {
    let failed = false;
    const { api, texts } = makeApi({
      failWhen: (text) => {
        if (!failed && text.startsWith("b")) {
          failed = true;
          return true;
        }
        return false;
      },
    });
    const relay = new StreamRelay(api);
    relay.sendChunked(CHAT, `${"a".repeat(10)}\n${"b".repeat(10)}\n${"c".repeat(10)}`);
    // Under 4000 chars total → single chunk; force multi-chunk instead:
    relay.sendChunked(CHAT, `${"b".repeat(4000)}${"c".repeat(4000)}`);
    await relay.settle();

    // First call: single chunk "aaa…\nbbb…\nccc…" (no failure — starts with a).
    // Second call: chunk1 ("b"*4000) fails once and is skipped, chunk2 still lands.
    expect(texts().at(-1)).toBe("c".repeat(4000));
  });
});

// ── toolStateUpdate deltas (tool completed / cancelled) ───────────────────────

describe("StreamRelay — toolStateUpdate deltas render tool completion", () => {
  function toolDelta(
    messageId: string,
    toolStateUpdate: ToolState,
  ): SessionMessageDelta {
    return {
      type: "session.message.delta",
      sessionId: "sess-1",
      messageId,
      toolStateUpdate,
      timestamp: new Date().toISOString(),
    };
  }

  it("renders ✓ with the remembered tool name when a completed delta arrives", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleMessage(
      CHAT,
      full("tc1", "tool_call", "", { toolId: "t1", name: "Bash", state: { phase: "executing" } }),
    );
    relay.handleDelta(CHAT, toolDelta("tc1", { phase: "completed", success: true, output: "ok" }));
    await relay.settle();

    expect(texts()).toEqual(["⚡ Bash", "✓ Bash"]);
  });

  it("renders ✗ failed when the tool completed unsuccessfully", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleMessage(
      CHAT,
      full("tc1", "tool_call", "", { toolId: "t1", name: "Edit", state: { phase: "executing" } }),
    );
    relay.handleDelta(CHAT, toolDelta("tc1", { phase: "completed", success: false }));
    await relay.settle();

    expect(texts()).toEqual(["⚡ Edit", "✗ Edit failed"]);
  });

  it("renders ✗ cancelled for a cancelled delta (denied approval)", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    // waiting_confirmation renders no line here (approval keyboard is the
    // frontend's job) but must still register the tool name.
    relay.handleMessage(
      CHAT,
      full("tc1", "tool_call", "", {
        toolId: "t1",
        name: "Write",
        state: { phase: "waiting_confirmation", input: {}, description: "Write(file)", approvalId: "ap-1" },
      }),
    );
    relay.handleDelta(CHAT, toolDelta("tc1", { phase: "cancelled", reason: "denied" }));
    await relay.settle();

    expect(texts()).toEqual(["✗ Write cancelled"]);
  });

  it("tool completion mid-stream flushes streamed text first (in order, no dup)", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleMessage(CHAT, full("m1", "assistant", ""));
    relay.handleDelta(CHAT, delta("m1", "Running the build. "));
    relay.handleMessage(
      CHAT,
      full("tc1", "tool_call", "", { toolId: "t1", name: "Bash", state: { phase: "executing" } }),
    );
    relay.handleDelta(CHAT, delta("m1", "It passed."));
    relay.handleDelta(CHAT, toolDelta("tc1", { phase: "completed", success: true }));
    relay.handleMessage(CHAT, full("m1", "assistant", "Running the build. It passed."));
    relay.flushIdle(CHAT);
    await relay.settle();

    expect(texts()).toEqual([
      "Running the build. ",
      "⚡ Bash",
      "It passed.",
      "✓ Bash",
      "✅ Done.",
    ]);
  });

  it("falls back to 'tool' when the name was never seen", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleDelta(CHAT, toolDelta("unknown-id", { phase: "completed", success: true }));
    await relay.settle();

    expect(texts()).toEqual(["✓ tool"]);
  });
});

// ── flush-on-detach / session switch ──────────────────────────────────────────

describe("StreamRelay — flushAndClear (detach / session switch)", () => {
  it("delivers buffered undelivered content with an interruption marker", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleMessage(CHAT, full("m1", "assistant", ""));
    relay.handleDelta(CHAT, delta("m1", "half-finished answ"));
    relay.flushAndClear(CHAT);
    await relay.settle();

    expect(texts()[0]).toBe("half-finished answ");
    expect(texts()[1]).toContain("✂️");
    expect(relay.bufferCount).toBe(0);
  });

  it("no marker when nothing was pending", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleMessage(CHAT, full("m1", "assistant", "already delivered"));
    await relay.settle();
    relay.flushAndClear(CHAT);
    await relay.settle();

    expect(texts()).toEqual(["already delivered"]);
  });

  it("post-clear deltas for old messageIds are dropped, fresh streams work", async () => {
    const { api, texts } = makeApi();
    const relay = new StreamRelay(api);

    relay.handleMessage(CHAT, full("m1", "assistant", ""));
    relay.handleDelta(CHAT, delta("m1", "old session text"));
    relay.flushAndClear(CHAT);

    // Stale delta from the old session after the switch — ignored.
    relay.handleDelta(CHAT, delta("m1", " ghost"));
    // New session streams normally.
    relay.handleMessage(CHAT, full("m2", "assistant", ""));
    relay.handleDelta(CHAT, delta("m2", "new session text"));
    relay.flushIdle(CHAT);
    await relay.settle();

    expect(countOccurrences(texts(), "ghost")).toBe(0);
    expect(countOccurrences(texts(), "new session text")).toBe(1);
    expect(countOccurrences(texts(), "old session text")).toBe(1);
  });
});

// ── settle() semantics (switch/detach confirmations wait on this) ─────────────

describe("StreamRelay — settle() waits for queued flush output", () => {
  it("resolves only after slow flushed sends have landed, so a confirmation sent after settle() cannot overtake them", async () => {
    // Every send is slow — if settle() resolved early, `sent` would still be
    // empty when the caller proceeds to send its confirmation.
    const fake = makeApi({ delayMs: () => 20 });
    const relay = new StreamRelay(fake.api);

    relay.handleMessage(CHAT, full("m1", "assistant", ""));
    relay.handleDelta(CHAT, delta("m1", "buffered tail"));
    relay.flushAndClear(CHAT);
    await relay.settle();

    // Both the flushed tail and the interruption marker are already
    // delivered by the time settle() resolves — the /attach//detach
    // confirmation (sent outside the relay) comes strictly after.
    expect(fake.texts()[0]).toBe("buffered tail");
    expect(fake.texts()[1]).toContain("✂️");
    expect(fake.texts()).toHaveLength(2);
  });
});
