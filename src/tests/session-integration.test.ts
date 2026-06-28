/**
 * Session integration tests — provider-injection harness.
 *
 * These tests exercise Session's internal logic end-to-end (send → event
 * consumer → scrollback → broadcast) without spawning the Claude Agent SDK.
 * MockSessionProvider supplies scripted ProviderEvent sequences so the tests
 * run offline in CI and complete in milliseconds.
 *
 * MockSessionProvider simulates the SDK's PreToolUse hook by calling
 * opts.canUseTool for each tool_start event it emits — this is what drives
 * the autonomous budget decrement and manual approval paths.
 *
 * Coverage:
 *
 *   T1  Async event ordering — text_delta sequences accumulate in order;
 *       tool_start + tool_complete produces a completed tool message.
 *
 *   T2  Autonomous single-decrement — a non-safe tool call decrements
 *       turnsRemaining exactly once (not twice — double-decrement regression).
 *
 *   T3  Map cleanup on interrupt — after interrupt(), subsequent turns work
 *       correctly (stale entries in #toolCallMessages, #toolUseIdToMessageId,
 *       #messageIdToToolUseId would corrupt tool output).
 *
 *   T4  Recovery path — onRecoveryNeeded fires → session calls resetToNewSession
 *       and issues a second runTurn(); the session reaches idle.
 *
 *   T5  Session resume after restart — restoreScrollback replays to newly
 *       attached clients; subsequent send() using MockSessionProvider works.
 *
 *   T6  ZeroID fence timeout — when AgentIdentityManager.registerSubagent hangs
 *       indefinitely, tool_start completes within ~6 s (fence times out at 5 s).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type AttachedClient } from "../daemon/session.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { mockResult } from "../daemon/providers/mock/index.js";
import { AsyncQueue } from "../daemon/async-queue.js";
import type { DaemonMessage, AuthContext } from "../protocol/types.js";
import type { ProviderEvent, TurnRun } from "../daemon/providers/interface.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_AUTH: AuthContext = {
  sub: "user:test-integration",
  scopes: [],
  delegationDepth: 0,
  accountId: "acc-integ",
  projectId: "proj-integ",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-integ-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  // Yield to the macrotask queue so fire-and-forget async operations from the
  // previous test (consumer finally block → store.updateSessionStatus,
  // TranscriptStore.saveMeta atomic rename) can complete before we close the
  // store and delete the tmp directory.  Without this, the next test's setup
  // races with the previous test's in-flight I/O, producing spurious
  // "Cannot use a closed database" and ENOENT errors.
  await new Promise<void>((r) => setTimeout(r, 100));
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a Session wired with the given MockSessionProvider.
 * Uses existingId so the constructor skips the async saveMeta call,
 * eliminating ENOENT races with afterEach's rmSync.
 */
function makeSession(provider: MockSessionProvider, name = "integ-test"): Session {
  const id = randomUUID();
  store.createSession({
    id,
    name,
    workdir: tmp,
    status: "idle",
    createdBy: TEST_AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: TEST_AUTH.accountId!,
    projectId: TEST_AUTH.projectId!,
  });
  return new Session({
    name,
    workdir: tmp,
    auth: TEST_AUTH,
    store,
    transcriptStore,
    existingId: id,
    _testProvider: provider,
  });
}

/** Build a stub AttachedClient that records every DaemonMessage it receives. */
function makeClient(id = randomUUID()): { client: AttachedClient; received: DaemonMessage[] } {
  const received: DaemonMessage[] = [];
  return {
    client: { id, auth: TEST_AUTH, send: (msg) => received.push(msg) },
    received,
  };
}

/**
 * Resolve when the session broadcasts session.status_change with status "idle"
 * or "error". Checks current status first so we don't miss an already-idle
 * session. Rejects after `timeoutMs` to prevent hung tests.
 *
 * IMPORTANT: Call `await session.send(...)` first (not `void session.send(...)`)
 * so that the session is in "thinking" state before this is called. Otherwise
 * the idle check fires immediately on a session that hasn't started yet.
 */
function waitForIdle(session: Session, timeoutMs = 8000): Promise<void> {
  if (session.status === "idle" || session.status === "error") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcherId = randomUUID();
    const timer = setTimeout(() => {
      session.detach(watcherId);
      reject(new Error(`session did not reach idle within ${timeoutMs}ms — status=${session.status}`));
    }, timeoutMs);
    const watcher: AttachedClient = {
      id: watcherId,
      auth: TEST_AUTH,
      send(msg) {
        if (msg.type === "session.status_change" &&
            (msg.status === "idle" || msg.status === "error")) {
          clearTimeout(timer);
          session.detach(watcherId);
          resolve();
        }
      },
    };
    session.attach(watcher);
  });
}

// ── T1: Async event ordering ──────────────────────────────────────────────────

describe("T1 – async event ordering", () => {
  it("accumulates 50 text_delta events in order; final assistant message has full content", async () => {
    const chunks = Array.from({ length: 50 }, (_, i) => `chunk${i} `);
    const finalText = chunks.join("");
    const deltas: ProviderEvent[] = chunks.map((c) => ({ type: "text_delta" as const, content: c }));

    const provider = new MockSessionProvider("claude", [
      [
        ...deltas,
        { type: "text_done", content: finalText },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);
    const { client, received } = makeClient();
    session.attach(client);

    // await (not void) so session is in "thinking" state when waitForIdle starts.
    await session.send("count to 50", TEST_AUTH);
    await waitForIdle(session);

    // text_done re-broadcasts the assistant message with the full content.
    const assistantMsgs = received.filter(
      (m) => m.type === "session.message" && m.role === "assistant",
    );
    const lastMsg = assistantMsgs.at(-1);
    expect(lastMsg).toBeDefined();
    if (lastMsg?.type === "session.message") {
      expect(lastMsg.content).toBe(finalText);
    }
  });

  it("Read tool (safe) — tool_start + tool_complete produces a completed tool_call message", async () => {
    const toolUseId = "sdk-read-1";
    const provider = new MockSessionProvider("claude", [
      [
        {
          type: "tool_start",
          toolId: "t1",
          sdkToolUseId: toolUseId,
          name: "Read",
          input: { file_path: "/tmp/foo.ts" },
          approvalId: "approval-1",
        },
        {
          type: "tool_complete",
          sdkToolUseId: toolUseId,
          output: "export const x = 1;",
          success: true,
        },
        { type: "text_done", content: "I read the file." },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("read foo.ts", TEST_AUTH);
    await waitForIdle(session);

    // tool_start produces a session.message with role "tool_call".
    const toolMsgs = received.filter(
      (m) => m.type === "session.message" && m.role === "tool_call",
    );
    expect(toolMsgs.length).toBeGreaterThanOrEqual(1);

    // After tool_complete the state should be "completed" — broadcast via session.message.delta.
    const completedDeltas = received.filter(
      (m) => m.type === "session.message.delta" && m.toolStateUpdate?.phase === "completed",
    );
    expect(completedDeltas.length).toBeGreaterThanOrEqual(1);
  });
});

// ── T2: Autonomous single-decrement ───────────────────────────────────────────

describe("T2 – autonomous mode single-decrement", () => {
  it("a non-safe tool (Bash) decrements turnsRemaining exactly once", async () => {
    const toolUseId = "sdk-bash-1";
    // Bash is a mutation tool — not in the safe-tool set (Read/Grep/Glob).
    const provider = new MockSessionProvider("claude", [
      [
        {
          type: "tool_start",
          toolId: "bash-t1",
          sdkToolUseId: toolUseId,
          name: "Bash",
          input: { command: "ls /tmp" },
          approvalId: "ap-bash-1",
        },
        {
          type: "tool_complete",
          sdkToolUseId: toolUseId,
          output: "file1\nfile2",
          success: true,
        },
        { type: "text_done", content: "Listed." },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);

    session.setMode("autonomous", 3);
    expect(session.turnsRemaining).toBe(3);

    await session.send("list tmp", TEST_AUTH);
    await waitForIdle(session);

    // canUseTool calls #shouldAutoApprove which decrements once.
    // tool_start handler uses #peekAutoApprove (no side effect) — not a second decrement.
    expect(session.turnsRemaining).toBe(2);
  });

  it("budget=1: after one non-safe tool, turnsRemaining is 0 (exhausted, not negative)", async () => {
    const toolUseId = "sdk-edit-1";
    const provider = new MockSessionProvider("claude", [
      [
        {
          type: "tool_start",
          toolId: "edit-t1",
          sdkToolUseId: toolUseId,
          name: "Edit",
          input: { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" },
          approvalId: "ap-edit-1",
        },
        {
          type: "tool_complete",
          sdkToolUseId: toolUseId,
          output: "ok",
          success: true,
        },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);
    session.setMode("autonomous", 1);

    await session.send("edit x.ts", TEST_AUTH);
    await waitForIdle(session);

    // Single-decrement: budget=1 → 0 after one tool (not -1 from a double-decrement).
    expect(session.turnsRemaining).toBe(0);
    // Mode stays autonomous until the NEXT tool call finds turnsRemaining=0 and flips it.
    expect(session.mode).toBe("autonomous");
  });
});

// ── T3: Map cleanup on interrupt ──────────────────────────────────────────────

describe("T3 – map cleanup after interrupt", () => {
  it("a second turn works correctly after interrupting the first mid-tool", async () => {
    const toolUseId = "sdk-stuck-1";

    // Turn 1: Bash tool (manual approval required in guarded mode) with no tool_complete.
    // MockSessionProvider calls canUseTool → waits for approval → interrupt fires.
    // Turn 2: clean simple turn (emitted after interrupt resolves).
    const provider = new MockSessionProvider("claude", [
      [
        {
          type: "tool_start",
          toolId: "stuck-t1",
          sdkToolUseId: toolUseId,
          name: "Bash",
          input: { command: "sleep 60" },
          approvalId: "ap-stuck-1",
        },
        // No tool_complete — interrupt resolves the pending canUseTool approval.
      ],
      [
        { type: "text_done", content: "Clean turn." },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);

    // Kick off turn 1. MockSessionProvider emits tool_start, calls canUseTool,
    // and waits for approval (Bash is not auto-approved in guarded mode).
    await session.send("sleep forever", TEST_AUTH);

    // Let the event consumer process tool_start and canUseTool start waiting.
    await new Promise<void>((r) => setTimeout(r, 50));

    // Interrupt resolves all pending approvals with {approved: false}.
    await session.interrupt(TEST_AUTH);
    await waitForIdle(session);

    // Turn 2: send again — if maps leaked, stale entries from turn 1 would
    // cause tool correlation mismatches. The clean turn should produce a
    // proper assistant message.
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("do something clean", TEST_AUTH);
    await waitForIdle(session);

    const assistantMsgs = received.filter(
      (m) => m.type === "session.message" && m.role === "assistant",
    );
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    const last = assistantMsgs.at(-1);
    if (last?.type === "session.message") {
      expect(last.content).toBe("Clean turn.");
    }
  });
});

// ── T4: Recovery path ─────────────────────────────────────────────────────────

describe("T4 – onRecoveryNeeded recovery path", () => {
  it("recovery triggers a second runTurn and the session reaches idle", async () => {
    // Scripted events for the RECOVERY run (the second runTurn call).
    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_done", content: "Recovered." },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);

    let callCount = 0;
    let recoveryTriggered = false;

    // Override runTurn: first call fires onRecoveryNeeded then returns an
    // immediately-closing queue; second call uses the scripted events above.
    const originalRunTurn = provider.runTurn.bind(provider);
    provider.runTurn = (opts): TurnRun => {
      callCount++;
      if (callCount === 1) {
        const queue = new AsyncQueue<ProviderEvent>();
        void Promise.resolve().then(() => {
          recoveryTriggered = true;
          // onRecoveryNeeded is wired by Session.#sendInner before calling runTurn.
          // Calling it here simulates the ClaudeProvider "No conversation found" error.
          provider.onRecoveryNeeded?.(opts.userMessage);
          try { queue.close(); } catch {}
        });
        return {
          events: queue,
          interrupt: async () => { try { queue.close(); } catch {} },
        };
      }
      return originalRunTurn(opts);
    };

    const session = makeSession(provider);
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("trigger recovery", TEST_AUTH);
    await waitForIdle(session, 10000);

    expect(recoveryTriggered).toBe(true);
    expect(callCount).toBe(2);

    const assistantMsgs = received.filter(
      (m) => m.type === "session.message" && m.role === "assistant",
    );
    const last = assistantMsgs.at(-1);
    if (last?.type === "session.message") {
      expect(last.content).toBe("Recovered.");
    }
  });
});

// ── T5: Session resume after restart ─────────────────────────────────────────

describe("T5 – session resume / scrollback replay", () => {
  it("restoreScrollback replays messages to a client that attaches later", () => {
    const provider = new MockSessionProvider("claude");
    const session = makeSession(provider);

    const messages: DaemonMessage[] = [
      {
        type: "session.message",
        sessionId: session.id,
        messageId: randomUUID(),
        role: "user",
        content: "Hello from before restart",
        identity: { sub: TEST_AUTH.sub, name: "User", type: "human" },
        timestamp: new Date().toISOString(),
      },
      {
        type: "session.message",
        sessionId: session.id,
        messageId: randomUUID(),
        role: "assistant",
        content: "I was already here.",
        identity: { sub: "agent:test", name: "Claude", type: "agent" },
        timestamp: new Date().toISOString(),
      },
    ];
    session.restoreScrollback(messages);

    const { client, received } = makeClient();
    session.attach(client);

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("scrollback.replay");
    if (received[0]?.type === "scrollback.replay") {
      expect(received[0].messages).toHaveLength(2);
    }
  });

  it("send() after restoreScrollback works: new turn appends to scrollback", async () => {
    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_done", content: "Post-restart reply." },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);

    session.restoreScrollback([
      {
        type: "session.message",
        sessionId: session.id,
        messageId: randomUUID(),
        role: "user",
        content: "prior turn",
        identity: { sub: TEST_AUTH.sub, name: "User", type: "human" },
        timestamp: new Date().toISOString(),
      },
    ]);

    await session.send("follow-up after restart", TEST_AUTH);
    await waitForIdle(session);

    // Attach a fresh client — replay should include the restored message AND the new reply.
    const { client, received } = makeClient();
    session.attach(client);

    const replay = received.find((m) => m.type === "scrollback.replay");
    expect(replay).toBeDefined();
    if (replay?.type === "scrollback.replay") {
      const assistantMsg = replay.messages.find(
        (m) => m.type === "session.message" && m.role === "assistant",
      );
      expect(assistantMsg).toBeDefined();
    }
  });
});

// ── T6: ZeroID fence timeout ──────────────────────────────────────────────────

describe("T6 – ZeroID fence 5 s timeout", () => {
  it("tool_start completes within 6 s when registerSubagent hangs indefinitely", async () => {
    const subagentId = "subagent-hanging";
    const toolUseId = "sdk-hang-tool-1";

    // Identity manager whose registerSubagent never resolves.
    // registerSessionAgent works normally so #ensureAgentIdentity succeeds.
    const hangingIdentityManager = {
      registerSessionAgent: async (_sid: string, _name: string, _sub: string) => ({
        wimseUri: `wimse://test/${_sid}`,
      }),
      registerSubagent: (_sid: string, _agentId: string, _type: string) =>
        new Promise<never>(() => {}), // hangs forever
      deactivateSubagent: async () => {},
      deactivateSessionAgent: async () => {},
    };

    const provider = new MockSessionProvider("claude", [
      [
        // subagent_start installs the hanging fence.
        { type: "subagent_start", agentId: subagentId, agentType: "Task" },
        // tool_start for that subagent — Session must timeout the fence after 5 s.
        {
          type: "tool_start",
          toolId: "hang-t1",
          sdkToolUseId: toolUseId,
          sdkAgentId: subagentId,
          name: "Read",
          input: { file_path: "/tmp/x.ts" },
          approvalId: "ap-hang-1",
        },
        {
          type: "tool_complete",
          sdkToolUseId: toolUseId,
          output: "content",
          success: true,
        },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);

    const id = randomUUID();
    store.createSession({
      id,
      name: "fence-test",
      workdir: tmp,
      status: "idle",
      createdBy: TEST_AUTH.sub,
      createdAt: new Date().toISOString(),
      attachedClients: 0,
      accountId: TEST_AUTH.accountId!,
      projectId: TEST_AUTH.projectId!,
    });

    const session = new Session({
      name: "fence-test",
      workdir: tmp,
      auth: TEST_AUTH,
      store,
      transcriptStore,
      existingId: id,
      _testProvider: provider,
      // Cast to never — we only implement the subset Session calls.
      identityManager: hangingIdentityManager as never,
    });

    const start = Date.now();
    await session.send("trigger subagent with hanging ZeroID", TEST_AUTH);
    await waitForIdle(session, 15000);
    const elapsed = Date.now() - start;

    // Fence timeout fires at 5 s. Total time should be under 12 s including
    // overhead. The waitForIdle(15s) timeout guards against a true hang.
    expect(elapsed).toBeLessThan(12000);
    expect(session.status).toBe("idle");
  }, 15000);
});

// ── T7: MockSessionProvider direct API ───────────────────────────────────────
// Covers the mock's own helper methods so the file stays above the 80% patch
// coverage gate.  These also serve as sanity checks: if the mock's API drifts
// from SessionProvider's contract the integration tests would silently test
// the wrong thing.

describe("T7 – MockSessionProvider direct API", () => {
  it("listModels returns the mock model list", async () => {
    const provider = new MockSessionProvider("m");
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]!.id).toBeTruthy();
  });

  it("teardown increments teardownCount and clears onRecoveryNeeded", async () => {
    const provider = new MockSessionProvider("m");
    provider.onRecoveryNeeded = () => {};
    await provider.teardown();
    expect(provider.teardownCount).toBe(1);
    expect(provider.onRecoveryNeeded).toBeUndefined();
  });

  it("dispose delegates to teardown", async () => {
    const provider = new MockSessionProvider("m");
    await provider.dispose();
    expect(provider.teardownCount).toBe(1);
  });

  it("setHasQueried updates hasQueried", () => {
    const provider = new MockSessionProvider("m");
    expect(provider.hasQueried).toBe(false);
    provider.setHasQueried(true);
    expect(provider.hasQueried).toBe(true);
    provider.setHasQueried(false);
    expect(provider.hasQueried).toBe(false);
  });

  it("runTurn with empty script falls back to default turn_done", async () => {
    const provider = new MockSessionProvider("m");
    const session = makeSession(provider);
    await session.send("hello", TEST_AUTH);
    await waitForIdle(session);
    expect(session.status).toBe("idle");
  });
});

// ── T8: Regression – text overlap + stale status ─────────────────────────────
// Guards the two regressions introduced by the multi-provider PR:
//
//  (a) Terminal text overlap: session.message.delta events and the committed
//      session.message from text_done must share the same messageId so the
//      terminal client can suppress re-printing content already streamed.
//
//  (b) Stale amber status: session.toInfo() must reflect the live status at
//      call time so that the web UI can update immediately from the
//      session.attach response (rather than waiting for a future broadcast).

describe("T8 – regression guards: text overlap + stale status", () => {
  it("(a) delta and final session.message share the same messageId", async () => {
    const chunks = ["Hello", " world"];
    const deltas: ProviderEvent[] = chunks.map((c) => ({ type: "text_delta" as const, content: c }));
    const provider = new MockSessionProvider("claude", [
      [
        ...deltas,
        { type: "text_done", content: "Hello world" },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("hi", TEST_AUTH);
    await waitForIdle(session);

    // Collect all messageIds that arrived via session.message.delta
    const deltaIds = new Set(
      received
        .filter((m) => m.type === "session.message.delta" && m.messageId)
        .map((m) => (m as { messageId: string }).messageId),
    );
    expect(deltaIds.size).toBeGreaterThan(0);

    // The committed assistant message must carry one of those same IDs.
    const finalMsg = received
      .filter((m) => m.type === "session.message" && m.role === "assistant" && m.content)
      .at(-1) as { messageId?: string } | undefined;
    expect(finalMsg).toBeDefined();
    expect(deltaIds.has(finalMsg!.messageId!)).toBe(true);
  });

  it("(b) toInfo() reflects live status — idle before/after a turn, error on provider error", async () => {
    // Before any turn: toInfo() reports idle (this is what the web UI reads
    // from the session.attach response to immediately correct a stale status).
    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_done", content: "hi" },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
      [
        { type: "error", message: "api blew up" },
      ],
    ]);
    const session = makeSession(provider);

    expect(session.toInfo().status).toBe("idle");

    await session.send("turn 1", TEST_AUTH);
    await waitForIdle(session);
    expect(session.toInfo().status).toBe("idle");

    await session.send("turn 2 — error", TEST_AUTH);
    await waitForIdle(session);
    expect(session.toInfo().status).toBe("error");
  });
});
