/**
 * Reconcile tool-call state when a session is resumed from its transcript.
 *
 * A tool call replayed from disk may be frozen mid-lifecycle if the daemon was
 * killed while the tool was streaming its input, waiting for approval, or
 * executing. All of those phases are driven by in-memory state (the live SDK
 * `query()` turn, `#pendingApprovals`) that does NOT survive a restart, so on
 * resume they can never receive a terminating `tool_result`. Left untouched,
 * clients replay the tool as perpetually "running".
 */
import type { SessionMessage, ToolPhase } from "../protocol/types.js";

/**
 * Phases that cannot advance after a daemon restart and must be reconciled to a
 * terminal state on resume:
 *   - `streaming`              — the SDK was still generating the tool input
 *   - `waiting_confirmation`   — the approval prompt (`#pendingApprovals`) is gone
 *   - `executing`             — the tool was mid-run; no `tool_result` will arrive
 * The terminal phases (`completed`, `cancelled`) are already settled and left
 * untouched, which also makes a second resume a no-op.
 */
const ORPHANED_TOOL_PHASES: ReadonlySet<ToolPhase> = new Set<ToolPhase>([
  "streaming",
  "waiting_confirmation",
  "executing",
]);

/**
 * Reconcile a single resumed scrollback message. Pure — returns the input
 * unchanged unless it is a tool call frozen in a non-terminal phase, in which
 * case it is rewritten to `cancelled` / `interrupted` so resume is idempotent
 * and clients never replay a phantom "running" tool.
 */
export function reconcileResumedMessage(msg: SessionMessage): SessionMessage {
  if (msg.role !== "tool_call" || !msg.tool) return msg;
  const { phase } = msg.tool.state;
  if (!ORPHANED_TOOL_PHASES.has(phase)) return msg;
  return {
    ...msg,
    tool: {
      ...msg.tool,
      state: {
        phase: "cancelled",
        reason: "interrupted",
        message:
          phase === "waiting_confirmation"
            ? "approval lost on daemon restart"
            : "interrupted by daemon restart",
      },
    },
  };
}
