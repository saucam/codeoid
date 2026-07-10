/**
 * Tool interrupt state — invariant tests.
 *
 * When a turn ends while a tool is still executing (user hits Stop, daemon
 * crashes, or Claude ends the turn before the tool_result arrives),
 * #completeActiveTools() in session.ts closes the orphaned tool call. The
 * required terminal state is `cancelled/interrupted`, NOT `completed/false`.
 *
 * The distinction is load-bearing for the web UI: MessageRow.tsx renders
 * `completed && success === false` as an "edit failed — no error message"
 * error banner — the wrong message for a user-initiated interruption.
 * The `cancelled` phase routes to PhaseBadge + ToolStateBody instead, which
 * correctly displays "cancelled — interrupted".
 *
 * We test:
 *   1. The pure state-transformation invariant (mirroring #completeActiveTools).
 *   2. That the web UI's error-banner condition does NOT fire for cancelled tools.
 *   3. That the same invariant holds in the resume path (reconcileResumedMessage).
 *   4. Regression: `completed/false` would have triggered the error banner.
 *   5. The real Session._applyInterruptedStateToTool() path via a real Session
 *      with a seeded scrollback — covers the actual changed code in session.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ToolState,
  ToolCompletedState,
  ToolCancelledState,
  SessionMessage,
  DaemonMessage,
  AuthContext,
} from "../protocol/types.js";
import { reconcileResumedMessage } from "../daemon/resume-reconcile.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type AttachedClient } from "../daemon/session.js";

// ── Pure-function mirror of #completeActiveTools state assignment ─────────────
//
// The real method mutates an in-memory SessionMessage via scrollback.updateMessage.
// We mirror just the state transition — the invariant under test.

function interruptTool(_currentState: ToolState): ToolCancelledState {
  return { phase: "cancelled", reason: "interrupted" };
}

// ── Web UI error-banner condition (mirrored from MessageRow.tsx) ──────────────
//
// The banner shows when: phase === "completed" && success === false && no output.
// A correctly-cancelled tool must NOT satisfy this condition.

function triggersErrorBanner(state: ToolState): boolean {
  return (
    state.phase === "completed" &&
    (state as ToolCompletedState).success === false
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeToolCallMessage(state: ToolState, msgId?: string): SessionMessage {
  return {
    type: "session.message",
    sessionId: "test-session",
    messageId: msgId ?? "msg-1",
    role: "tool_call",
    content: "",
    identity: { sub: "agent:test", name: "Claude", type: "agent" },
    timestamp: new Date().toISOString(),
    tool: {
      toolId: "tc-1",
      name: "Edit",
      state,
      input: { path: "/tmp/foo.ts", old_string: "x", new_string: "y" },
    },
  };
}

// ── Tests: #completeActiveTools state transition ──────────────────────────────

describe("interrupted tool state — #completeActiveTools invariant", () => {
  it("produces cancelled/interrupted, not completed/false", () => {
    const executingState: ToolState = { phase: "executing" };
    const result = interruptTool(executingState);

    expect(result.phase).toBe("cancelled");
    expect(result.reason).toBe("interrupted");
  });

  it("does NOT produce completed/false for an interrupted tool", () => {
    const executingState: ToolState = { phase: "executing" };
    const result = interruptTool(executingState);

    const asCompleted = result as unknown as ToolCompletedState;
    expect(asCompleted.phase).not.toBe("completed");
  });

  it("cancelled state does not trigger the web UI error banner", () => {
    const executingState: ToolState = { phase: "executing" };
    const result = interruptTool(executingState);

    expect(triggersErrorBanner(result)).toBe(false);
  });

  it("REGRESSION: completed/false would have triggered the error banner", () => {
    // Documents the pre-fix bug: marking an interrupted tool as completed/false
    // caused MessageRow to show "edit failed — no error message".
    const oldBugState: ToolState = { phase: "completed", success: false };
    expect(triggersErrorBanner(oldBugState)).toBe(true);
  });

  it("cancelled phase is accepted by the ToolState discriminated union", () => {
    const state: ToolState = { phase: "cancelled", reason: "interrupted" };
    expect(state.phase).toBe("cancelled");
  });

  it("message field is optional — interruption without a human message is valid", () => {
    const state: ToolCancelledState = { phase: "cancelled", reason: "interrupted" };
    expect(state.message).toBeUndefined();
  });
});

// ── Tests: web UI banner condition ────────────────────────────────────────────

describe("web UI error-banner condition", () => {
  it("fires for completed/false — the legacy interrupted-tool state", () => {
    const state: ToolState = { phase: "completed", success: false };
    expect(triggersErrorBanner(state)).toBe(true);
  });

  it("does NOT fire for completed/true — a genuinely successful tool", () => {
    const state: ToolState = { phase: "completed", success: true, output: "ok" };
    expect(triggersErrorBanner(state)).toBe(false);
  });

  it("does NOT fire for cancelled/interrupted — the correct interrupted-tool state", () => {
    const state: ToolState = { phase: "cancelled", reason: "interrupted" };
    expect(triggersErrorBanner(state)).toBe(false);
  });

  it("does NOT fire for cancelled/denied — the user-rejection state", () => {
    const state: ToolState = { phase: "cancelled", reason: "denied" };
    expect(triggersErrorBanner(state)).toBe(false);
  });

  it("does NOT fire for executing — a running tool", () => {
    const state: ToolState = { phase: "executing" };
    expect(triggersErrorBanner(state)).toBe(false);
  });
});

// ── Tests: reconcileResumedMessage (same cancelled/interrupted invariant) ─────
//
// The resume-reconcile path (daemon restart) already uses cancelled/interrupted
// for the same scenario. These tests verify the contract is consistent.

describe("reconcileResumedMessage — same invariant for restart recovery", () => {
  it("reconciles an executing tool to cancelled/interrupted", () => {
    const msg = makeToolCallMessage({ phase: "executing" });
    const result = reconcileResumedMessage(msg);

    expect(result.tool?.state.phase).toBe("cancelled");
    expect((result.tool?.state as ToolCancelledState).reason).toBe("interrupted");
  });

  it("reconciles a streaming tool to cancelled/interrupted", () => {
    const msg = makeToolCallMessage({ phase: "streaming" });
    const result = reconcileResumedMessage(msg);

    expect(result.tool?.state.phase).toBe("cancelled");
    expect((result.tool?.state as ToolCancelledState).reason).toBe("interrupted");
  });

  it("does NOT change an already-cancelled tool", () => {
    const cancelledState: ToolState = { phase: "cancelled", reason: "interrupted" };
    const msg = makeToolCallMessage(cancelledState);
    const result = reconcileResumedMessage(msg);

    expect(result.tool?.state).toEqual(cancelledState);
  });

  it("does NOT change an already-completed tool", () => {
    const completedState: ToolState = { phase: "completed", success: true, output: "done" };
    const msg = makeToolCallMessage(completedState);
    const result = reconcileResumedMessage(msg);

    expect(result.tool?.state).toEqual(completedState);
  });

  it("reconciled executing tool does not trigger error banner", () => {
    const msg = makeToolCallMessage({ phase: "executing" });
    const result = reconcileResumedMessage(msg);

    expect(triggersErrorBanner(result.tool!.state)).toBe(false);
  });

  it("reconciled state is consistent with what #completeActiveTools now produces", () => {
    // Both paths (turn-end interruption and daemon restart) must produce the
    // same terminal state so there is no visual difference between the two.
    const fromTurnEnd = interruptTool({ phase: "executing" });
    const fromRestart = reconcileResumedMessage(
      makeToolCallMessage({ phase: "executing" }),
    ).tool!.state as ToolCancelledState;

    expect(fromTurnEnd.phase).toBe(fromRestart.phase);
    expect(fromTurnEnd.reason).toBe(fromRestart.reason);
  });
});

// ── Tests: Session._applyInterruptedStateToTool (real session path) ───────────
//
// Exercises the actual changed code in session.ts — the extracted
// _applyInterruptedStateToTool() method — with a real Session, real scrollback,
// and a captured broadcast. This gives Codecov coverage of the session.ts lines
// that #completeActiveTools delegates to.
//
// _applyInterruptedStateToTool is TypeScript-private (not JS `#` private) so
// tests can reach it via an `as unknown as SessionInternal` cast.

const TEST_AUTH: AuthContext = {
  sub: "user:test",
  scopes: [],
  delegationDepth: 0,
  accountId: "acc",
  projectId: "proj",
};

interface SessionInternal {
  _applyInterruptedStateToTool(msgId: string): void;
}

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-tool-interrupt-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(() => {
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function makeSession(name = "test"): Session {
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
  return new Session({ name, workdir: tmp, auth: TEST_AUTH, store, transcriptStore, existingId: id });
}

function makeClient(id: string): { client: AttachedClient; received: DaemonMessage[] } {
  const received: DaemonMessage[] = [];
  return {
    received,
    client: { id, auth: TEST_AUTH, send: (msg) => received.push(msg) },
  };
}

describe("Session._applyInterruptedStateToTool — real session path", () => {
  it("broadcasts a cancelled/interrupted delta to attached clients", () => {
    const session = makeSession();
    const msgId = randomUUID();
    const toolMsg = makeToolCallMessage({ phase: "executing" }, msgId);
    (toolMsg as SessionMessage & { sessionId: string }).sessionId = session.id;

    // Seed the scrollback so updateMessage finds the entry.
    session.restoreScrollback([toolMsg]);

    // Attach a client to capture broadcasts (skip the scrollback.replay).
    const { client, received } = makeClient("test-client");
    session.attach(client);
    received.length = 0; // discard scrollback replay received on attach

    // Call the extracted method directly (TypeScript-private, not JS-private #).
    (session as unknown as SessionInternal)._applyInterruptedStateToTool(msgId);

    // The broadcast delta must carry the cancelled/interrupted state.
    const delta = received.find(
      (m) => m.type === "session.message.delta" && (m as { messageId?: string }).messageId === msgId,
    );
    expect(delta).toBeDefined();
    const state = (delta as { toolStateUpdate?: ToolState })?.toolStateUpdate;
    expect(state?.phase).toBe("cancelled");
    expect((state as ToolCancelledState)?.reason).toBe("interrupted");
  });

  it("updates the scrollback entry so replay shows the cancelled state", () => {
    const session = makeSession();
    const msgId = randomUUID();
    const toolMsg = makeToolCallMessage({ phase: "executing" }, msgId);
    (toolMsg as SessionMessage & { sessionId: string }).sessionId = session.id;

    session.restoreScrollback([toolMsg]);

    (session as unknown as SessionInternal)._applyInterruptedStateToTool(msgId);

    // Re-attach to trigger a scrollback replay — the replayed message must
    // show the updated (cancelled) state, not the original (executing) state.
    const { client, received } = makeClient("replay-client");
    session.attach(client);

    const replay = received.find((m) => m.type === "scrollback.replay") as
      | { messages: SessionMessage[] }
      | undefined;
    expect(replay).toBeDefined();
    const updated = replay!.messages.find((m) => m.messageId === msgId);
    expect(updated?.tool?.state.phase).toBe("cancelled");
    expect((updated?.tool?.state as ToolCancelledState).reason).toBe("interrupted");
  });

  it("is a no-op when the scrollback has no message with that id", () => {
    const session = makeSession();
    const { client, received } = makeClient("c1");
    session.attach(client);
    received.length = 0;

    // Call with an ID that isn't in the scrollback — no crash, broadcast still fires.
    (session as unknown as SessionInternal)._applyInterruptedStateToTool("nonexistent-id");

    // A delta IS broadcast (with cancelled state) even if the scrollback entry
    // was not found — the protocol delta is unconditional.
    const delta = received.find((m) => m.type === "session.message.delta");
    expect(delta).toBeDefined();
  });

  it("does not trigger the error banner for the broadcast state", () => {
    const session = makeSession();
    const msgId = randomUUID();
    session.restoreScrollback([makeToolCallMessage({ phase: "executing" }, msgId)]);

    const { client, received } = makeClient("c1");
    session.attach(client);
    received.length = 0;

    (session as unknown as SessionInternal)._applyInterruptedStateToTool(msgId);

    const delta = received.find((m) => m.type === "session.message.delta");
    const state = (delta as { toolStateUpdate?: ToolState })?.toolStateUpdate;
    expect(state).toBeDefined();
    expect(triggersErrorBanner(state!)).toBe(false);
  });
});

// ── Regression: approval→message correlation cleanup ─────────────────────────
//
// _applyInterruptedStateToTool used to delete the patch-key whitelist for the
// tool's approval but NOT the #approvalIdToMessageId entry itself. Besides the
// per-interrupt leak, a later approve() for the dead approvalId passed the
// `.has()` check and parked in #earlyApprovals forever instead of hitting
// #dismissStaleApproval — so a client replaying a stale ApprovalBar never got
// a dismissal and the bar wedged.
describe("Session._applyInterruptedStateToTool — approval correlation cleanup", () => {
  interface SessionApprovalInternal {
    _applyInterruptedStateToTool(msgId: string): void;
    _seedApprovalCorrelation(approvalId: string, msgId: string): void;
    _approvalCorrelationIds(): string[];
  }

  it("drops the approvalId mapping for the interrupted tool (and only it)", () => {
    const session = makeSession();
    const msgId = randomUUID();
    const otherMsgId = randomUUID();
    const toolMsg = makeToolCallMessage(
      { phase: "waiting_confirmation", input: {}, description: "Edit(/tmp/foo.ts)", approvalId: "ap-dead" },
      msgId,
    );
    (toolMsg as SessionMessage & { sessionId: string }).sessionId = session.id;
    session.restoreScrollback([toolMsg]);

    const internal = session as unknown as SessionApprovalInternal;
    internal._seedApprovalCorrelation("ap-dead", msgId);
    internal._seedApprovalCorrelation("ap-live", otherMsgId);

    internal._applyInterruptedStateToTool(msgId);

    // The interrupted tool's mapping is gone; an unrelated live one survives.
    expect(internal._approvalCorrelationIds()).toEqual(["ap-live"]);

    // A late decision for the dead approval no longer matches the stale
    // mapping — it takes the dismiss path instead of parking forever in the
    // early-approval buffer (which nothing would ever consume).
    session.approve("ap-dead", true, TEST_AUTH);
    expect(internal._approvalCorrelationIds()).toEqual(["ap-live"]);
  });
});
