/**
 * Inline approval bar — when any tool in the focused session is in the
 * `waiting_confirmation` phase, this surfaces ABOVE the prompt with the
 * tool name + description and approve/deny buttons.
 *
 * Rendering one at a time matches the daemon's serialized approval
 * pipeline; if multiple tools are waiting (rare with stream-input
 * mode), the oldest pending one wins.
 */

import { Component, Show, createMemo } from "solid-js";

import { newRequestId, send } from "../../state/connection";
import { createMessages } from "../../state/messages";
import { focusedSessionId } from "../../state/sessions";
import type { SessionMessage } from "../../protocol/types";

/** Custom event the prompt listens for so "Refine" can focus + hint. */
function focusPromptWithHint(hint: string): void {
  window.dispatchEvent(
    new CustomEvent("codeoid:focus-prompt-with-hint", { detail: { hint } }),
  );
}

const ApprovalBar: Component = () => {
  const messages = createMessages(focusedSessionId);
  const pending = createMemo<SessionMessage | null>(() => {
    for (const m of messages()) {
      if (m.role !== "tool_call" || !m.tool) continue;
      if (m.tool.state.phase === "waiting_confirmation") return m;
    }
    return null;
  });

  return (
    <Show when={pending()}>
      {(m) => {
        const state = () =>
          m().tool!.state as {
            phase: "waiting_confirmation";
            input: unknown;
            description: string;
            approvalId: string;
          };
        const isPlanMode = () =>
          m().tool!.name === "ExitPlanMode" || m().tool!.name === "exit_plan_mode";
        const sid = focusedSessionId;
        const handleApprove = () =>
          approve(sid()!, state().approvalId, true);
        const handleDeny = () =>
          approve(sid()!, state().approvalId, false);
        const handleRefine = () => {
          // Deny the call, then focus the prompt with a hint asking the
          // user what to change. The next message they send is read by
          // Claude as the refinement request.
          approve(sid()!, state().approvalId, false);
          focusPromptWithHint(
            isPlanMode()
              ? "What should change in the plan?"
              : "What would you like Claude to do instead?",
          );
        };

        return (
          <div class="border-t border-accent/30 bg-accent/5 px-4 py-3">
            <div class="mx-auto flex max-w-3xl items-center gap-2">
              <div class="flex flex-1 flex-col min-w-0">
                <div class="flex items-center gap-2 text-xs text-accent">
                  <span class="font-semibold uppercase tracking-wider">
                    {isPlanMode() ? "Plan ready" : "Approval needed"}
                  </span>
                  <span class="font-mono">{m().tool!.name}</span>
                </div>
                <div class="mt-1 truncate text-sm text-fg">
                  {isPlanMode()
                    ? "Review the plan above. Approve to start coding, refine to give Claude feedback."
                    : state().description}
                </div>
              </div>
              <button
                type="button"
                class="rounded bg-success/90 px-3 py-1.5 text-xs font-semibold text-bg transition hover:bg-success"
                onClick={handleApprove}
                title="Approve · Alt+Y"
              >
                {isPlanMode() ? "approve plan" : "approve"}
              </button>
              <button
                type="button"
                class="rounded border border-accent/60 bg-bg px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-accent/10"
                onClick={handleRefine}
                title="Deny + focus prompt for follow-up feedback"
              >
                refine
              </button>
              <button
                type="button"
                class="rounded border border-danger/60 bg-bg px-3 py-1.5 text-xs font-semibold text-danger transition hover:bg-danger/10"
                onClick={handleDeny}
                title="Deny · Alt+D"
              >
                {isPlanMode() ? "cancel" : "deny"}
              </button>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export function approve(sessionId: string, approvalId: string, approved: boolean): void {
  send({
    type: "session.approve",
    id: newRequestId(),
    sessionId,
    approvalId,
    approved,
  });
}

export default ApprovalBar;
