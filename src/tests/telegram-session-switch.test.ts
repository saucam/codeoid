/**
 * Telegram frontend — session-switch state invariants.
 *
 * The Grammy Bot class requires a live Telegram token and network I/O, so
 * direct instantiation is impractical in tests. Instead we mirror the
 * UserState structure and the switch/detach logic performed by #handleAttach
 * and #handleDetach, in the same style as telegram-search.test.ts.
 *
 * What we verify:
 *   1. Switching to a different session disconnects from the old one, clears
 *      the streaming buffer, and removes the stop-button reference.
 *   2. Re-attaching to the same session is a no-op — no disconnect, no clear.
 *   3. Attaching for the first time (no prior session) never calls disconnect.
 *   4. Switching with an active streaming buffer FLUSHES buffered content to
 *      the chat first (StreamRelay.flushAndClear) — undelivered content is
 *      never silently discarded — and the cleared buffer cannot bleed into
 *      the new session's output.
 *   5. Switching with an active stop-message id marks the message for deletion.
 *   6. #handleDetach clears streaming + stop-button state regardless of
 *      whether there was an active turn.
 *   7. Cycling through many sessions always leaves state clean after each switch.
 */

import { describe, it, expect } from "bun:test";

// ── Mirrored types ────────────────────────────────────────────────────────────
//
// Replicated from TelegramFrontend to keep tests offline and import-free.
// If the real type changes in a way that breaks the invariant, update both.

interface StreamingBuf {
  role: string;
  content: string;
}

interface UserState {
  attachedSessionId: string | null;
  attachedSessionName: string | null;
  clientId: string;
  streaming: Map<string, StreamingBuf>;
  stopMessageId: number | null;
}

function makeUserState(clientId = "telegram:123"): UserState {
  return {
    attachedSessionId: null,
    attachedSessionName: null,
    clientId,
    streaming: new Map(),
    stopMessageId: null,
  };
}

// ── Mirrored session-switch and detach logic ──────────────────────────────────
//
// Mirrors the logic in #handleAttach (switch block) and #handleDetach.
// The side-effect calls (disconnectClient, deleteMessage) are passed in as
// callbacks so tests can inspect them without a real manager or Telegram API.

interface SwitchDeps {
  disconnectClient: (clientId: string) => void;
  deleteMessage: (chatId: number, messageId: number) => void;
  /**
   * Mirror of StreamRelay.flushAndClear: deliver buffered undelivered
   * content to the chat, then reset the buffer map.
   */
  flushAndClear: (state: UserState) => void;
  /**
   * Mirror of `await state.relay.settle()`: the handlers wait for flushed
   * output to land before the user-visible confirmation, so "Attached to …"
   * / "Detached from …" can't overtake buffered content.
   */
  settle: () => void;
}

/**
 * Mirror of the session-switch block in #handleAttach.
 *
 * Returns true when an actual switch happened (old session was disconnected).
 */
function performSwitch(
  state: UserState,
  newSessionId: string,
  newSessionName: string,
  chatId: number,
  deps: SwitchDeps,
): boolean {
  if (state.attachedSessionId && state.attachedSessionId !== newSessionId) {
    deps.disconnectClient(state.clientId);
    state.attachedSessionId = null;
    state.attachedSessionName = null;
    deps.flushAndClear(state);
    deps.settle();
    if (state.stopMessageId !== null) {
      deps.deleteMessage(chatId, state.stopMessageId);
      state.stopMessageId = null;
    }
    // Caller proceeds to attach to the new session (assumed to succeed here).
    state.attachedSessionId = newSessionId;
    state.attachedSessionName = newSessionName;
    return true;
  }
  // First attach or same-session re-attach — just record the session.
  state.attachedSessionId = newSessionId;
  state.attachedSessionName = newSessionName;
  return false;
}

/**
 * Mirror of the state-cleanup in #handleDetach.
 */
function performDetach(
  state: UserState,
  chatId: number,
  deps: SwitchDeps,
): void {
  deps.disconnectClient(state.clientId);
  state.attachedSessionId = null;
  state.attachedSessionName = null;
  deps.flushAndClear(state);
  deps.settle();
  if (state.stopMessageId !== null) {
    deps.deleteMessage(chatId, state.stopMessageId);
    state.stopMessageId = null;
  }
}

/** Stub deps that record calls for assertion. */
function makeDeps(): SwitchDeps & {
  disconnected: string[];
  deleted: [number, number][];
  flushed: string[];
  /** Ordered log of side-effect calls, for sequencing assertions. */
  ops: string[];
} {
  const disconnected: string[] = [];
  const deleted: [number, number][] = [];
  const flushed: string[] = [];
  const ops: string[] = [];
  return {
    disconnectClient: (id) => {
      ops.push("disconnect");
      disconnected.push(id);
    },
    deleteMessage: (chatId, msgId) => {
      ops.push("deleteStopMessage");
      deleted.push([chatId, msgId]);
    },
    flushAndClear: (state) => {
      ops.push("flushAndClear");
      for (const buf of state.streaming.values()) {
        if (buf.content) flushed.push(buf.content);
      }
      state.streaming.clear();
    },
    settle: () => {
      ops.push("settle");
    },
    disconnected,
    deleted,
    flushed,
    ops,
  };
}

const CHAT_ID = 999_001;

// ── Tests: session switch (#handleAttach logic) ───────────────────────────────

describe("session switch — #handleAttach state transitions", () => {
  it("first attach sets session id without calling disconnectClient", () => {
    const state = makeUserState();
    const deps = makeDeps();

    performSwitch(state, "sess-A", "session-A", CHAT_ID, deps);

    expect(state.attachedSessionId).toBe("sess-A");
    expect(deps.disconnected).toHaveLength(0);
  });

  it("switching to a different session calls disconnectClient with the user's clientId", () => {
    const state = makeUserState("telegram:42");
    const deps = makeDeps();

    performSwitch(state, "sess-A", "session-A", CHAT_ID, deps);
    performSwitch(state, "sess-B", "session-B", CHAT_ID, deps);

    expect(deps.disconnected).toEqual(["telegram:42"]);
    expect(state.attachedSessionId).toBe("sess-B");
  });

  it("re-attaching to the same session does NOT call disconnectClient", () => {
    const state = makeUserState();
    const deps = makeDeps();

    performSwitch(state, "sess-A", "session-A", CHAT_ID, deps);
    performSwitch(state, "sess-A", "session-A", CHAT_ID, deps); // same session

    expect(deps.disconnected).toHaveLength(0);
  });

  it("streaming buffer is flushed to the chat, then cleared, on session switch", () => {
    const state = makeUserState();
    const deps = makeDeps();

    performSwitch(state, "sess-A", "session-A", CHAT_ID, deps);
    // Simulate streaming content arriving from session A.
    state.streaming.set("msg-1", { role: "assistant", content: "partial..." });
    state.streaming.set("msg-2", { role: "thinking", content: "reasoning..." });
    expect(state.streaming.size).toBe(2);

    performSwitch(state, "sess-B", "session-B", CHAT_ID, deps);

    // Buffer must be empty — no content from session A bleeds into session B —
    // but the buffered content was delivered, not silently discarded.
    expect(state.streaming.size).toBe(0);
    expect(deps.flushed).toEqual(["partial...", "reasoning..."]);
  });

  it("streaming buffer is NOT cleared when re-attaching to the same session", () => {
    const state = makeUserState();
    const deps = makeDeps();

    performSwitch(state, "sess-A", "session-A", CHAT_ID, deps);
    state.streaming.set("msg-1", { role: "assistant", content: "in-progress" });

    performSwitch(state, "sess-A", "session-A", CHAT_ID, deps); // same session

    expect(state.streaming.size).toBe(1); // unchanged
  });

  it("stop-message id is cleared and deletion is requested on switch", () => {
    const state = makeUserState();
    const deps = makeDeps();

    performSwitch(state, "sess-A", "session-A", CHAT_ID, deps);
    state.stopMessageId = 777; // simulate: stop button shown for session A

    performSwitch(state, "sess-B", "session-B", CHAT_ID, deps);

    expect(state.stopMessageId).toBeNull();
    expect(deps.deleted).toEqual([[CHAT_ID, 777]]);
  });

  it("no deletion requested when no stop message was shown", () => {
    const state = makeUserState();
    const deps = makeDeps();

    performSwitch(state, "sess-A", "session-A", CHAT_ID, deps);
    // state.stopMessageId stays null (no active turn)

    performSwitch(state, "sess-B", "session-B", CHAT_ID, deps);

    expect(deps.deleted).toHaveLength(0);
  });

  it("cycling through many sessions always leaves state clean after each switch", () => {
    const sessions = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];
    const state = makeUserState("telegram:99");
    const deps = makeDeps();

    for (let i = 0; i < sessions.length; i++) {
      const sid = sessions[i]!;
      // Simulate some streaming content and an active stop button arriving.
      if (i > 0) {
        state.streaming.set(`msg-${i}`, { role: "assistant", content: "partial" });
        state.stopMessageId = 1000 + i;
      }
      performSwitch(state, sid, sid, CHAT_ID, deps);

      expect(state.attachedSessionId).toBe(sid);
      expect(state.streaming.size).toBe(0);
      expect(state.stopMessageId).toBeNull();
    }

    // disconnectClient called once per switch (sessions.length - 1 times).
    expect(deps.disconnected).toHaveLength(sessions.length - 1);
  });
});

// ── Tests: #handleDetach state transitions ────────────────────────────────────

describe("detach — #handleDetach state transitions", () => {
  it("clears attachedSessionId and name", () => {
    const state = makeUserState();
    state.attachedSessionId = "sess-A";
    state.attachedSessionName = "session-A";

    performDetach(state, CHAT_ID, makeDeps());

    expect(state.attachedSessionId).toBeNull();
    expect(state.attachedSessionName).toBeNull();
  });

  it("calls disconnectClient with the user's clientId", () => {
    const state = makeUserState("telegram:77");
    state.attachedSessionId = "sess-A";
    const deps = makeDeps();

    performDetach(state, CHAT_ID, deps);

    expect(deps.disconnected).toEqual(["telegram:77"]);
  });

  it("flushes then clears the streaming buffer", () => {
    const state = makeUserState();
    state.attachedSessionId = "sess-A";
    state.streaming.set("m1", { role: "assistant", content: "partial" });
    const deps = makeDeps();

    performDetach(state, CHAT_ID, deps);

    expect(state.streaming.size).toBe(0);
    expect(deps.flushed).toEqual(["partial"]);
  });

  it("requests stop-message deletion when one is active", () => {
    const state = makeUserState();
    state.attachedSessionId = "sess-A";
    state.stopMessageId = 555;
    const deps = makeDeps();

    performDetach(state, CHAT_ID, deps);

    expect(state.stopMessageId).toBeNull();
    expect(deps.deleted).toEqual([[CHAT_ID, 555]]);
  });

  it("no deletion when no stop message is active", () => {
    const state = makeUserState();
    state.attachedSessionId = "sess-A";
    const deps = makeDeps();

    performDetach(state, CHAT_ID, deps);

    expect(deps.deleted).toHaveLength(0);
  });
});

// ── Tests: streaming isolation between sessions ───────────────────────────────

describe("streaming buffer isolation", () => {
  it("content accumulated for session A is absent after switching to session B", () => {
    const state = makeUserState();
    const deps = makeDeps();

    performSwitch(state, "sess-A", "session-A", CHAT_ID, deps);
    state.streaming.set("msg-a1", { role: "assistant", content: "hello from A" });
    state.streaming.set("msg-a2", { role: "thinking", content: "thinking A" });

    performSwitch(state, "sess-B", "session-B", CHAT_ID, deps);

    // Session B starts with a clean buffer — no A content present.
    expect(state.streaming.has("msg-a1")).toBe(false);
    expect(state.streaming.has("msg-a2")).toBe(false);
    expect(state.streaming.size).toBe(0);
  });

  it("content accumulates correctly within the same session across multiple messages", () => {
    const state = makeUserState();
    const deps = makeDeps();

    performSwitch(state, "sess-A", "session-A", CHAT_ID, deps);
    state.streaming.set("msg-1", { role: "assistant", content: "part1" });
    state.streaming.set("msg-2", { role: "assistant", content: "part2" });

    // Re-attach to same session — buffer is preserved.
    performSwitch(state, "sess-A", "session-A", CHAT_ID, deps);

    expect(state.streaming.size).toBe(2);
  });
});

// ── Tests: flush → settle → confirm ordering ──────────────────────────────────

describe("switch/detach settle ordering — confirmation cannot overtake flushed output", () => {
  it("session switch settles the relay right after flushing, before any later side effect", () => {
    const state = makeUserState();
    const deps = makeDeps();

    performSwitch(state, "sess-A", "session-A", CHAT_ID, deps);
    state.streaming.set("m1", { role: "assistant", content: "buffered" });
    state.stopMessageId = 777;
    performSwitch(state, "sess-B", "session-B", CHAT_ID, deps);

    expect(deps.ops).toEqual([
      "disconnect",
      "flushAndClear",
      "settle",
      "deleteStopMessage",
    ]);
  });

  it("detach settles the relay right after flushing", () => {
    const state = makeUserState();
    state.attachedSessionId = "sess-A";
    const deps = makeDeps();

    performDetach(state, CHAT_ID, deps);

    expect(deps.ops).toEqual(["disconnect", "flushAndClear", "settle"]);
  });
});
