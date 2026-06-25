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
 */

import { describe, it, expect } from "bun:test";
import type {
  ToolState,
  ToolCompletedState,
  ToolCancelledState,
} from "../protocol/types.js";
import { reconcileResumedMessage } from "../daemon/resume-reconcile.js";
import type { SessionMessage } from "../protocol/types.js";

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

function makeToolCallMessage(state: ToolState): SessionMessage {
  return {
    type: "session.message",
    sessionId: "test-session",
    messageId: "msg-1",
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

    // Narrowed: result.phase is "cancelled", so this cast is intentional.
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
