/**
 * Attach lifecycle + older-history paging state (#152).
 *
 * Covers the per-session state machine (idle → pending → settled | failed),
 * `hasOlderHistory` derivation from tail-first replay frames, and the
 * `loadOlderHistory` backfill: request shape, anchored prepend ordering,
 * dedupe, hasMore bookkeeping, single-flight, and error → retry.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// attach.ts reaches the transport via dynamic `import("./connection")` —
// vi.mock intercepts dynamic imports by resolved path all the same.
const requestMock = vi.hoisted(() =>
  vi.fn<(msg: unknown, opts?: unknown) => Promise<unknown>>(() =>
    Promise.resolve({}),
  ),
);
const clientRequestMock = vi.hoisted(() =>
  vi.fn<(msg: unknown, opts?: unknown) => Promise<unknown>>(() =>
    Promise.resolve({}),
  ),
);
vi.mock("./connection", () => ({
  request: requestMock,
  newRequestId: () => "req-1",
  getClient: () => ({ request: clientRequestMock }),
}));

import {
  _resetAttachForTest,
  attachError,
  attachRetryEpoch,
  attachSession,
  attachState,
  hasOlderHistory,
  loadOlderHistory,
  markAttachPending,
  noteAttachReplay,
  oldestMessageId,
  pagingBusy,
  pagingError,
  requestAttachRetry,
} from "./attach";
import { _resetMessagesForTest, messagesFor, replaceScrollback } from "./messages";
import type { ScrollbackReplayMsg, SessionMessage } from "../protocol/types";

function makeMsg(messageId: string, content = "x"): SessionMessage {
  return {
    type: "session.message",
    sessionId: "s1",
    messageId,
    role: "assistant",
    content,
    identity: { sub: "agent:a", type: "agent" as const },
    timestamp: "2026-07-11T00:00:00Z",
  } as SessionMessage;
}

function replay(overrides: Partial<ScrollbackReplayMsg> = {}): ScrollbackReplayMsg {
  return {
    type: "scrollback.replay",
    sessionId: "s1",
    messages: [],
    ...overrides,
  } as ScrollbackReplayMsg;
}

beforeEach(() => {
  _resetAttachForTest();
  _resetMessagesForTest();
  requestMock.mockReset();
  requestMock.mockImplementation(() => Promise.resolve({}));
  clientRequestMock.mockReset();
  clientRequestMock.mockImplementation(() => Promise.resolve({}));
});

describe("attach state machine", () => {
  it("starts idle; unknown/null sessions read as defaults", () => {
    expect(attachState("nope")).toBe("idle");
    expect(attachState(null)).toBe("idle");
    expect(attachError("nope")).toBeNull();
    expect(hasOlderHistory(null)).toBe(false);
    expect(pagingBusy("nope")).toBe(false);
    expect(pagingError("nope")).toBeNull();
  });

  it("attachSession: pending while in flight → settled on resolve", async () => {
    let resolveAttach!: (v: unknown) => void;
    requestMock.mockImplementationOnce(() => new Promise((res) => (resolveAttach = res)));

    const p = attachSession("s1");
    expect(attachState("s1")).toBe("pending");
    // Wait for the dynamic import + request dispatch to happen.
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    expect(requestMock.mock.calls[0]![0]).toMatchObject({
      type: "session.attach",
      sessionId: "s1",
    });

    resolveAttach({ id: "s1", status: "idle" });
    await p;
    // Empty sessions send no replay frame — the response itself settles.
    expect(attachState("s1")).toBe("settled");
    expect(attachError("s1")).toBeNull();
  });

  it("pending → settled on the FIRST scrollback.replay frame (before the response)", async () => {
    let resolveAttach!: (v: unknown) => void;
    requestMock.mockImplementationOnce(() => new Promise((res) => (resolveAttach = res)));

    const p = attachSession("s1");
    expect(attachState("s1")).toBe("pending");
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    // Replay frames stream in ahead of response.ok for non-empty sessions.
    noteAttachReplay(replay({ tail: true, hasMore: true }));
    expect(attachState("s1")).toBe("settled");
    expect(hasOlderHistory("s1")).toBe(true);

    resolveAttach({});
    await p;
    expect(attachState("s1")).toBe("settled");
  });

  it("failed on rejection with the error surfaced; rethrows for the caller", async () => {
    requestMock.mockImplementationOnce(() => Promise.reject(new Error("scope denied")));
    await expect(attachSession("s1")).rejects.toThrow("scope denied");
    expect(attachState("s1")).toBe("failed");
    expect(attachError("s1")).toBe("scope denied");
  });

  it("resume cursor is forwarded on the wire", async () => {
    await attachSession("s1", { key: "rk", sinceSeq: 42 });
    expect(requestMock.mock.calls[0]![0]).toMatchObject({
      resume: { key: "rk", sinceSeq: 42 },
    });
  });

  it("requestAttachRetry clears the failure and bumps the retry epoch", async () => {
    requestMock.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    await attachSession("s1").catch(() => {});
    expect(attachState("s1")).toBe("failed");

    const before = attachRetryEpoch();
    requestAttachRetry("s1");
    expect(attachState("s1")).toBe("idle");
    expect(attachError("s1")).toBeNull();
    expect(attachRetryEpoch()).toBe(before + 1);
  });

  it("re-attach goes through the same lifecycle (reconnect path)", async () => {
    await attachSession("s1");
    expect(attachState("s1")).toBe("settled");
    markAttachPending("s1");
    expect(attachState("s1")).toBe("pending");
    noteAttachReplay(replay());
    expect(attachState("s1")).toBe("settled");
  });
});

describe("hasOlderHistory derivation", () => {
  it("tracks tail-first replay frames; non-tail frames leave it untouched", () => {
    noteAttachReplay(replay({ tail: true, hasMore: true }));
    expect(hasOlderHistory("s1")).toBe(true);

    // A later tail frame (re-attach after the history shrank) can clear it.
    noteAttachReplay(replay({ tail: true, hasMore: false }));
    expect(hasOlderHistory("s1")).toBe(false);

    noteAttachReplay(replay({ tail: true, hasMore: true }));
    // Legacy/incremental frames (no tail flag) never touch the value.
    noteAttachReplay(replay({ mode: "incremental" }));
    expect(hasOlderHistory("s1")).toBe(true);
  });
});

describe("oldestMessageId", () => {
  it("is the first message in the session buffer, undefined when empty", () => {
    expect(oldestMessageId("s1")).toBeUndefined();
    replaceScrollback("s1", [makeMsg("m4"), makeMsg("m5")]);
    expect(oldestMessageId("s1")).toBe("m4");
  });
});

describe("loadOlderHistory", () => {
  function pageResult(overrides: Record<string, unknown> = {}) {
    return {
      type: "scrollback.page.result",
      requestId: "req-1",
      sessionId: "s1",
      messages: [],
      hasMore: false,
      source: "buffer",
      ...overrides,
    };
  }

  it("sends scrollback.page anchored on the oldest held messageId and prepends in order", async () => {
    replaceScrollback("s1", [makeMsg("m4"), makeMsg("m5")]);
    noteAttachReplay(replay({ tail: true, hasMore: true }));

    clientRequestMock.mockImplementationOnce(() =>
      Promise.resolve(
        pageResult({ messages: [makeMsg("m2"), makeMsg("m3")], hasMore: true }),
      ),
    );

    await loadOlderHistory("s1");

    expect(clientRequestMock).toHaveBeenCalledTimes(1);
    expect(clientRequestMock.mock.calls[0]![0]).toMatchObject({
      type: "scrollback.page",
      sessionId: "s1",
      beforeMessageId: "m4",
    });
    expect(messagesFor("s1").map((m) => m.messageId)).toEqual(["m2", "m3", "m4", "m5"]);
    expect(hasOlderHistory("s1")).toBe(true); // more pages remain
    expect(pagingBusy("s1")).toBe(false);
    expect(pagingError("s1")).toBeNull();

    // Next page anchors on the NEW oldest id and exhausts history.
    clientRequestMock.mockImplementationOnce(() =>
      Promise.resolve(pageResult({ messages: [makeMsg("m1")], hasMore: false })),
    );
    await loadOlderHistory("s1");
    expect(clientRequestMock.mock.calls[1]![0]).toMatchObject({ beforeMessageId: "m2" });
    expect(messagesFor("s1").map((m) => m.messageId)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(hasOlderHistory("s1")).toBe(false);
  });

  it("resolves the typed result frame via waitForResult (session.search pattern)", async () => {
    replaceScrollback("s1", [makeMsg("m4")]);
    clientRequestMock.mockImplementationOnce((_msg, opts) => {
      const { waitForResult } = opts as {
        waitForResult: (m: unknown) => unknown;
      };
      // Non-matching frames are ignored; the matching one resolves.
      expect(waitForResult({ type: "response.ok", requestId: "req-1" })).toBeUndefined();
      expect(
        waitForResult({ ...pageResult(), requestId: "other" }),
      ).toBeUndefined();
      const match = pageResult({ messages: [makeMsg("m3")] });
      expect(waitForResult(match)).toBe(match);
      return Promise.resolve(match);
    });
    await loadOlderHistory("s1");
    expect(messagesFor("s1").map((m) => m.messageId)).toEqual(["m3", "m4"]);
  });

  it("dedupes an overlapping page against the store", async () => {
    replaceScrollback("s1", [makeMsg("m3"), makeMsg("m4")]);
    clientRequestMock.mockImplementationOnce(() =>
      Promise.resolve(
        pageResult({ messages: [makeMsg("m2"), makeMsg("m3")], hasMore: false }),
      ),
    );
    await loadOlderHistory("s1");
    expect(messagesFor("s1").map((m) => m.messageId)).toEqual(["m2", "m3", "m4"]);
  });

  it("is single-flight per session and no-ops with an empty buffer", async () => {
    // Empty buffer: no anchor to page before — nothing sent.
    await loadOlderHistory("s1");
    expect(clientRequestMock).not.toHaveBeenCalled();

    replaceScrollback("s1", [makeMsg("m4")]);
    let resolvePage!: (v: unknown) => void;
    clientRequestMock.mockImplementationOnce(
      () => new Promise((res) => (resolvePage = res)),
    );
    const first = loadOlderHistory("s1");
    // Busy flips synchronously, before the (async) transport dispatch…
    expect(pagingBusy("s1")).toBe(true);
    const second = loadOlderHistory("s1"); // dropped — busy
    // …so wait for the dispatch before resolving it.
    await vi.waitFor(() => expect(clientRequestMock).toHaveBeenCalledTimes(1));
    resolvePage(pageResult({ messages: [makeMsg("m3")] }));
    await Promise.all([first, second]);
    expect(clientRequestMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a paging error and a retry succeeds after it", async () => {
    replaceScrollback("s1", [makeMsg("m4")]);
    clientRequestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("transcript scan timed out")),
    );
    await loadOlderHistory("s1");
    expect(pagingError("s1")).toBe("transcript scan timed out");
    expect(pagingBusy("s1")).toBe(false);
    expect(messagesFor("s1").map((m) => m.messageId)).toEqual(["m4"]);

    clientRequestMock.mockImplementationOnce(() =>
      Promise.resolve(pageResult({ messages: [makeMsg("m3")], hasMore: false })),
    );
    await loadOlderHistory("s1");
    expect(pagingError("s1")).toBeNull(); // cleared on the retry attempt
    expect(messagesFor("s1").map((m) => m.messageId)).toEqual(["m3", "m4"]);
  });

  it("brackets the prepend with onBeforePrepend/onAfterPrepend hooks", async () => {
    replaceScrollback("s1", [makeMsg("m4")]);
    clientRequestMock.mockImplementationOnce(() =>
      Promise.resolve(pageResult({ messages: [makeMsg("m3")] })),
    );
    const order: string[] = [];
    await loadOlderHistory("s1", {
      onBeforePrepend: () => {
        order.push(`before:${messagesFor("s1").length}`);
      },
      onAfterPrepend: () => {
        order.push(`after:${messagesFor("s1").length}`);
      },
    });
    expect(order).toEqual(["before:1", "after:2"]);
  });
});
