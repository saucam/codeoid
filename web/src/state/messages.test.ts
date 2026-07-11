import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetMessagesForTest,
  appendScrollback,
  applyDelta,
  applyMessage,
  clearSessionMessages,
  epochOf,
  hasMessage,
  lastActivityAt,
  messagesFor,
  prependMessages,
  registerSessionCachePruner,
  replaceScrollback,
  versionOf,
} from "./messages";
import type {
  ContentPart,
  SessionMessage,
  SessionMessageDelta,
} from "../protocol/types";

const baseIdentity = { sub: "spiffe://x/agent/a", name: "you", type: "human" as const };

function makeMsg(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    type: "session.message",
    sessionId: "s1",
    messageId: "m1",
    role: "user",
    content: "hello",
    identity: baseIdentity,
    timestamp: "2026-05-04T08:00:00Z",
    ...overrides,
  };
}

describe("messages store", () => {
  beforeEach(() => _resetMessagesForTest());

  it("tracks lastActivityAt on message/delta, and clears it with the session", () => {
    expect(lastActivityAt("s1")).toBe(0); // nothing yet
    const before = Date.now();
    applyMessage(makeMsg({ messageId: "m1", content: "hi" }));
    const afterMsg = lastActivityAt("s1");
    expect(afterMsg).toBeGreaterThanOrEqual(before);
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "m1",
      contentAppend: " there",
    } as SessionMessageDelta);
    expect(lastActivityAt("s1")).toBeGreaterThanOrEqual(afterMsg);
    clearSessionMessages("s1");
    expect(lastActivityAt("s1")).toBe(0); // pruned with the session
    expect(lastActivityAt(null)).toBe(0);
  });

  it("appends messages on applyMessage", () => {
    applyMessage(makeMsg({ messageId: "m1", content: "first" }));
    applyMessage(makeMsg({ messageId: "m2", content: "second" }));
    const buf = messagesFor("s1");
    expect(buf).toHaveLength(2);
    expect(buf[0]?.messageId).toBe("m1");
    expect(buf[1]?.messageId).toBe("m2");
  });

  it("replaces an existing message on re-broadcast", () => {
    applyMessage(makeMsg({ messageId: "m1", content: "v1" }));
    applyMessage(makeMsg({ messageId: "m1", content: "v2" }));
    const buf = messagesFor("s1");
    expect(buf).toHaveLength(1);
    expect(buf[0]?.content).toBe("v2");
  });

  it("bumps the version on every mutation", () => {
    expect(versionOf("m1")).toBe(0);
    applyMessage(makeMsg({ messageId: "m1" }));
    expect(versionOf("m1")).toBe(1);
    applyMessage(makeMsg({ messageId: "m1", content: "again" }));
    expect(versionOf("m1")).toBe(2);
  });

  it("appends content via deltas", () => {
    applyMessage(makeMsg({ messageId: "m1", content: "hello" }));
    const delta: SessionMessageDelta = {
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "m1",
      contentAppend: " world",
      timestamp: "2026-05-04T08:00:01Z",
    };
    applyDelta(delta);
    expect(messagesFor("s1")[0]?.content).toBe("hello world");
    expect(versionOf("m1")).toBe(2);
  });

  it("drops deltas for unknown messages (graceful resync)", () => {
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "ghost",
      contentAppend: "drift",
      timestamp: "2026-05-04T08:00:01Z",
    });
    expect(messagesFor("s1")).toHaveLength(0);
    expect(versionOf("ghost")).toBe(0);
  });

  it("appends parts via partsAppend", () => {
    applyMessage(makeMsg({ messageId: "m1", parts: [] }));
    const part: ContentPart = { kind: "text", text: "part-1" };
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "m1",
      partsAppend: [part],
      timestamp: "2026-05-04T08:00:02Z",
    });
    const m = messagesFor("s1")[0];
    expect(m?.parts).toEqual([part]);
  });

  it("updates parts at a specific index via partsUpdate", () => {
    const initial: ContentPart = { kind: "text", text: "old" };
    applyMessage(makeMsg({ messageId: "m1", parts: [initial] }));
    const replacement: ContentPart = { kind: "text", text: "new" };
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "m1",
      partsUpdate: [{ index: 0, part: replacement }],
      timestamp: "2026-05-04T08:00:02Z",
    });
    expect(messagesFor("s1")[0]?.parts?.[0]).toEqual(replacement);
  });

  it("appends partsUpdate when index is past the end", () => {
    applyMessage(makeMsg({ messageId: "m1", parts: [] }));
    const part: ContentPart = { kind: "text", text: "p" };
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "m1",
      partsUpdate: [{ index: 5, part }],
      timestamp: "2026-05-04T08:00:02Z",
    });
    expect(messagesFor("s1")[0]?.parts).toEqual([part]);
  });

  it("transitions tool state via toolStateUpdate", () => {
    applyMessage(
      makeMsg({
        messageId: "tool-1",
        role: "tool_call",
        tool: {
          toolId: "t1",
          name: "Bash",
          state: { phase: "streaming" },
        },
      }),
    );
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "tool-1",
      toolStateUpdate: { phase: "completed", success: true, output: "ok" },
      timestamp: "2026-05-04T08:00:03Z",
    });
    const m = messagesFor("s1")[0];
    expect(m?.tool?.state.phase).toBe("completed");
  });

  it("ignores toolStateUpdate when the message has no tool", () => {
    applyMessage(makeMsg({ messageId: "m1", role: "user" }));
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "m1",
      toolStateUpdate: { phase: "executing" },
      timestamp: "2026-05-04T08:00:03Z",
    });
    expect(messagesFor("s1")[0]?.tool).toBeUndefined();
  });

  it("replaceScrollback overwrites the session's buffer", () => {
    applyMessage(makeMsg({ messageId: "m-old" }));
    replaceScrollback("s1", [
      makeMsg({ messageId: "m-replay-1", content: "first" }),
      makeMsg({ messageId: "m-replay-2", content: "second" }),
    ]);
    const buf = messagesFor("s1");
    expect(buf).toHaveLength(2);
    expect(buf.map((m) => m.messageId)).toEqual(["m-replay-1", "m-replay-2"]);
  });

  it("hasMessage returns false outside the store, true inside", () => {
    expect(hasMessage("s1", "m1")).toBe(false);
    applyMessage(makeMsg({ messageId: "m1" }));
    expect(hasMessage("s1", "m1")).toBe(true);
    expect(hasMessage("s2", "m1")).toBe(false);
  });

  it("epochOf bumps on every applyMessage / applyDelta / replaceScrollback", () => {
    expect(epochOf("s1")).toBe(0);
    applyMessage(makeMsg({ messageId: "m1" }));
    expect(epochOf("s1")).toBe(1);
    applyMessage(makeMsg({ messageId: "m2" }));
    expect(epochOf("s1")).toBe(2);

    // Delta mutating in place must still bump — that's the bug we
    // shipped this for (auto-scroll wasn't firing on streaming).
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "m1",
      contentAppend: " more",
      timestamp: "2026-05-04T08:00:01Z",
    });
    expect(epochOf("s1")).toBe(3);

    replaceScrollback("s1", [makeMsg({ messageId: "m3" })]);
    expect(epochOf("s1")).toBe(4);

    // Other sessions stay at 0.
    expect(epochOf("s2")).toBe(0);
  });

  it("epochOf returns 0 for unknown / nullish sessions", () => {
    expect(epochOf(null)).toBe(0);
    expect(epochOf(undefined)).toBe(0);
    expect(epochOf("never-seen")).toBe(0);
  });

  it("replaceScrollback dedupes replayed duplicates by messageId, keeping the LAST occurrence's content at the first position", () => {
    replaceScrollback("s1", [
      makeMsg({ messageId: "m1", content: "v1" }),
      makeMsg({ messageId: "m2", content: "other" }),
      makeMsg({ messageId: "m1", content: "v2" }),
      makeMsg({ messageId: "m1", content: "v3-final" }),
    ]);
    const buf = messagesFor("s1");
    expect(buf).toHaveLength(2);
    expect(buf.map((m) => m.messageId)).toEqual(["m1", "m2"]);
    expect(buf[0]?.content).toBe("v3-final");
    expect(hasMessage("s1", "m1")).toBe(true);
    expect(hasMessage("s1", "m2")).toBe(true);
  });

  it("appendScrollback extends a reset buffer in order (chunked replay #84)", () => {
    // Mirrors the wire flow: chunk 0 resets via replaceScrollback, later
    // chunks append.
    replaceScrollback("s1", [
      makeMsg({ messageId: "c0-a" }),
      makeMsg({ messageId: "c0-b" }),
    ]);
    appendScrollback("s1", [
      makeMsg({ messageId: "c1-a" }),
      makeMsg({ messageId: "c1-b" }),
    ]);
    appendScrollback("s1", [makeMsg({ messageId: "c2-a" })]);

    expect(messagesFor("s1").map((m) => m.messageId)).toEqual([
      "c0-a", "c0-b", "c1-a", "c1-b", "c2-a",
    ]);
    expect(hasMessage("s1", "c2-a")).toBe(true);
  });

  it("appendScrollback bumps the session epoch and no-ops on an empty chunk", () => {
    replaceScrollback("s1", [makeMsg({ messageId: "m0" })]);
    const before = epochOf("s1");
    appendScrollback("s1", [makeMsg({ messageId: "m1" })]);
    expect(epochOf("s1")).toBe(before + 1);
    appendScrollback("s1", []);
    expect(epochOf("s1")).toBe(before + 1); // empty chunk is a no-op
  });

  it("appendScrollback upserts a redelivered messageId, keeping its position", () => {
    replaceScrollback("s1", [makeMsg({ messageId: "m0", content: "zero" })]);
    appendScrollback("s1", [makeMsg({ messageId: "m1", content: "v1" })]);
    // Redeliver m1 with new content — must update in place, not duplicate.
    appendScrollback("s1", [makeMsg({ messageId: "m1", content: "v2" })]);
    const buf = messagesFor("s1");
    expect(buf.map((m) => m.messageId)).toEqual(["m0", "m1"]);
    expect(buf[1]?.content).toBe("v2");
  });

  it("clearSessionMessages removes messages, ids, epoch AND per-message version entries", () => {
    applyMessage(makeMsg({ messageId: "m1" }));
    applyMessage(makeMsg({ messageId: "m2" }));
    applyMessage(makeMsg({ sessionId: "s2", messageId: "keep" }));
    expect(versionOf("m1")).toBe(1);
    expect(versionOf("m2")).toBe(1);

    clearSessionMessages("s1");

    expect(messagesFor("s1")).toHaveLength(0);
    expect(hasMessage("s1", "m1")).toBe(false);
    expect(epochOf("s1")).toBe(0);
    // versions map must not leak destroyed sessions' entries.
    expect(versionOf("m1")).toBe(0);
    expect(versionOf("m2")).toBe(0);
    // Other sessions untouched.
    expect(versionOf("keep")).toBe(1);
    expect(hasMessage("s2", "keep")).toBe(true);
  });

  it("positional index: deltas land on the right message in a large buffer (#90)", () => {
    // 2000 messages, then patch several NON-tail targets — the map-based
    // positional lookup must hit exactly the intended entries.
    for (let i = 0; i < 2000; i++) {
      applyMessage(makeMsg({ messageId: `m${i}`, content: `c${i}` }));
    }
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "m0",
      contentAppend: "+head",
      timestamp: "t",
    } as SessionMessageDelta);
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "m1000",
      contentAppend: "+mid",
      timestamp: "t",
    } as SessionMessageDelta);

    const buf = messagesFor("s1");
    expect(buf).toHaveLength(2000);
    expect(buf[0]!.content).toBe("c0+head");
    expect(buf[1000]!.content).toBe("c1000+mid");
    expect(buf[1999]!.content).toBe("c1999");
  });

  it("positional index survives re-broadcast upserts and replaceScrollback rebuilds", () => {
    applyMessage(makeMsg({ messageId: "a", content: "A1" }));
    applyMessage(makeMsg({ messageId: "b", content: "B1" }));
    // Upsert keeps position; a subsequent delta still lands correctly.
    applyMessage(makeMsg({ messageId: "a", content: "A2" }));
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "a",
      contentAppend: "+d",
      timestamp: "t",
    } as SessionMessageDelta);
    expect(messagesFor("s1")[0]!.content).toBe("A2+d");

    // Replay with duplicates: index must point at the DEDUPED position.
    replaceScrollback("s1", [
      makeMsg({ messageId: "x", content: "X1" }),
      makeMsg({ messageId: "y", content: "Y" }),
      makeMsg({ messageId: "x", content: "X2" }),
    ]);
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "x",
      contentAppend: "+d",
      timestamp: "t",
    } as SessionMessageDelta);
    const buf = messagesFor("s1");
    expect(buf).toHaveLength(2);
    expect(buf[0]!.content).toBe("X2+d");
    expect(buf[1]!.content).toBe("Y");
  });

  it("clearSessionMessages invokes registered session cache pruners exactly once with the sessionId", () => {
    const pruned: string[] = [];
    const unregister = registerSessionCachePruner((sid) => pruned.push(sid));
    applyMessage(makeMsg({ messageId: "m1" }));
    clearSessionMessages("s1");
    expect(pruned).toEqual(["s1"]);
    unregister();
    clearSessionMessages("s1");
    expect(pruned).toEqual(["s1"]); // unregistered — not called again
  });
});

describe("prependMessages — scrollback.page backfill (#152)", () => {
  beforeEach(() => _resetMessagesForTest());

  function ids(sessionId: string): string[] {
    return messagesFor(sessionId).map((m) => m.messageId);
  }

  it("inserts an older page at the FRONT preserving order", () => {
    replaceScrollback("s1", [
      makeMsg({ messageId: "m5", content: "five" }),
      makeMsg({ messageId: "m6", content: "six" }),
    ]);
    prependMessages("s1", [
      makeMsg({ messageId: "m2", content: "two" }),
      makeMsg({ messageId: "m3", content: "three" }),
      makeMsg({ messageId: "m4", content: "four" }),
    ]);
    expect(ids("s1")).toEqual(["m2", "m3", "m4", "m5", "m6"]);
  });

  it("prepends into an empty session and multiple pages walk backwards", () => {
    prependMessages("s1", [makeMsg({ messageId: "m3" }), makeMsg({ messageId: "m4" })]);
    prependMessages("s1", [makeMsg({ messageId: "m1" }), makeMsg({ messageId: "m2" })]);
    expect(ids("s1")).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("dedupes against already-held ids (overlapping page) and within the batch", () => {
    replaceScrollback("s1", [
      makeMsg({ messageId: "m3", content: "held" }),
      makeMsg({ messageId: "m4" }),
    ]);
    prependMessages("s1", [
      makeMsg({ messageId: "m1" }),
      makeMsg({ messageId: "m2" }),
      makeMsg({ messageId: "m2" }), // in-batch duplicate
      makeMsg({ messageId: "m3", content: "page-copy" }), // already in store
    ]);
    expect(ids("s1")).toEqual(["m1", "m2", "m3", "m4"]);
    // Held content wins for a store collision — history is immutable, the
    // colliding page copy is dropped rather than upserted.
    expect(messagesFor("s1")[2]!.content).toBe("held");
  });

  it("keeps the positional index coherent — deltas still land after a prepend", () => {
    replaceScrollback("s1", [makeMsg({ messageId: "m9", content: "tail" })]);
    prependMessages("s1", [
      makeMsg({ messageId: "m7", content: "seven" }),
      makeMsg({ messageId: "m8", content: "eight" }),
    ]);
    // Delta targets the SHIFTED position of m9 (index 2 now, was 0).
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "m9",
      contentAppend: "+d",
      timestamp: "t",
    } as SessionMessageDelta);
    expect(messagesFor("s1")[2]!.content).toBe("tail+d");
    // And a fresh page still dedupes against every id, old and new.
    expect(hasMessage("s1", "m7")).toBe(true);
    expect(hasMessage("s1", "m8")).toBe(true);
    expect(hasMessage("s1", "m9")).toBe(true);
    // New live messages append at the correct index after the shift.
    applyMessage(makeMsg({ messageId: "m10", content: "live" }));
    expect(ids("s1")).toEqual(["m7", "m8", "m9", "m10"]);
    applyDelta({
      type: "session.message.delta",
      sessionId: "s1",
      messageId: "m10",
      contentAppend: "!",
      timestamp: "t",
    } as SessionMessageDelta);
    expect(messagesFor("s1")[3]!.content).toBe("live!");
  });

  it("bumps the session epoch, no-ops on empty/fully-duplicate input", () => {
    replaceScrollback("s1", [makeMsg({ messageId: "m2" })]);
    const before = epochOf("s1");
    prependMessages("s1", []);
    expect(epochOf("s1")).toBe(before); // empty — untouched
    prependMessages("s1", [makeMsg({ messageId: "m2" })]);
    expect(epochOf("s1")).toBe(before); // all duplicates — untouched
    prependMessages("s1", [makeMsg({ messageId: "m1" })]);
    expect(epochOf("s1")).toBe(before + 1);
  });
});
