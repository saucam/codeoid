/**
 * "Claude is thinking…" indicator that sits between the transcript and
 * the prompt. Shows when SessionInfo.status is `thinking` or
 * `tool_running` — the daemon updates these via session.status_change
 * broadcasts.
 *
 * Picks the most recent activity to ground the indicator: in
 * `tool_running` we surface the running tool's name; in `thinking` we
 * cycle a few status verbs so the spinner feels alive.
 */

import { Component, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { focusedSessionMessages } from "../../state/messages";
import { focusedSession } from "../../state/sessions";

const VERBS = ["thinking", "drafting", "considering", "researching", "weighing"];

const WorkerIndicator: Component = () => {
  const [tick, setTick] = createSignal(0);

  onMount(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1500);
    onCleanup(() => clearInterval(t));
  });

  const status = () => focusedSession()?.status;
  const visible = () =>
    status() === "working" ||
    status() === "thinking" ||
    status() === "tool_running";

  // Latest in-flight tool call (executing / streaming).
  const liveTool = createMemo(() => {
    if (status() !== "tool_running") return null;
    const arr = focusedSessionMessages();
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i];
      if (!m || m.role !== "tool_call" || !m.tool) continue;
      const phase = m.tool.state.phase;
      if (phase === "executing" || phase === "streaming") return m.tool;
    }
    return null;
  });

  const verb = () => VERBS[tick() % VERBS.length] ?? "thinking";

  return (
    <Show when={visible()}>
      <div class="border-t border-accent/30 bg-accent/[0.04] px-4 py-2.5">
        <div class="mx-auto flex max-w-3xl items-center gap-2.5 text-[13px] text-fg">
          <Show when={liveTool()} fallback={<ThinkingDots />}>
            <ToolSpinner />
          </Show>
          <Show
            when={liveTool()}
            fallback={
              <span class="font-medium">
                <span class="italic text-fg-muted">{verb()}</span>
                <span class="thinking-ellipsis text-fg-muted" />
              </span>
            }
          >
            {(t) => (
              <span class="font-medium">
                running{" "}
                <span class="font-mono font-semibold text-role-tool">{t().name}</span>
                <Show when={(t().state as { progress?: string }).progress}>
                  {" — "}
                  <span class="font-mono text-fg-muted">
                    {(t().state as { progress?: string }).progress}
                  </span>
                </Show>
              </span>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
};

/** Three-dot bouncing thinking indicator — Claude Code style. */
const ThinkingDots: Component = () => (
  <span class="inline-flex items-end gap-[3px]" aria-label="thinking">
    <span class="thinking-dot thinking-dot-1" />
    <span class="thinking-dot thinking-dot-2" />
    <span class="thinking-dot thinking-dot-3" />
  </span>
);

/** Rotating spinner used while a tool is executing. */
const ToolSpinner: Component = () => (
  <span class="tool-spinner" aria-label="running tool" />
);

export default WorkerIndicator;
