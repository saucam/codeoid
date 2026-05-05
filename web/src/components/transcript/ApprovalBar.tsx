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
        const state = () => m().tool!.state as Extract<
          typeof m extends () => infer X ? (X extends SessionMessage ? X["tool"] : never) : never,
          { phase: "waiting_confirmation" }
        > extends never
          ? { input: unknown; description: string; approvalId: string }
          : { input: unknown; description: string; approvalId: string };
        const sid = focusedSessionId;
        return (
          <div class="border-t border-accent/30 bg-accent/5 px-4 py-3">
            <div class="mx-auto flex max-w-3xl items-center gap-3">
              <div class="flex flex-1 flex-col">
                <div class="flex items-center gap-2 text-xs text-accent">
                  <span class="font-semibold uppercase tracking-wider">
                    Approval needed
                  </span>
                  <span class="font-mono">{m().tool!.name}</span>
                </div>
                <div class="mt-1 text-sm text-fg">
                  {(state() as { description: string }).description}
                </div>
              </div>
              <button
                type="button"
                class="rounded bg-success/90 px-3 py-1.5 text-xs font-semibold text-bg transition hover:bg-success"
                onClick={() =>
                  approve(
                    sid()!,
                    (state() as { approvalId: string }).approvalId,
                    true,
                  )
                }
                title="Alt+Y"
              >
                approve
              </button>
              <button
                type="button"
                class="rounded border border-danger/60 bg-bg px-3 py-1.5 text-xs font-semibold text-danger transition hover:bg-danger/10"
                onClick={() =>
                  approve(
                    sid()!,
                    (state() as { approvalId: string }).approvalId,
                    false,
                  )
                }
                title="Alt+D"
              >
                deny
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
