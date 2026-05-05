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

import { createMessages } from "../../state/messages";
import { focusedSession, focusedSessionId } from "../../state/sessions";

const VERBS = ["thinking", "drafting", "considering", "researching", "weighing"];

const WorkerIndicator: Component = () => {
  const messages = createMessages(focusedSessionId);
  const [tick, setTick] = createSignal(0);

  onMount(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1500);
    onCleanup(() => clearInterval(t));
  });

  const status = () => focusedSession()?.status;
  const visible = () =>
    status() === "thinking" || status() === "tool_running";

  // Latest in-flight tool call (executing / streaming).
  const liveTool = createMemo(() => {
    if (status() !== "tool_running") return null;
    const arr = messages();
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
      <div class="border-t border-border/50 bg-bg-elev/40 px-4 py-2">
        <div class="mx-auto flex max-w-3xl items-center gap-2 text-[12px] text-fg-muted">
          <Spinner />
          <Show
            when={liveTool()}
            fallback={
              <span>
                <span class="text-role-thinking italic">{verb()}…</span>
              </span>
            }
          >
            {(t) => (
              <span>
                running{" "}
                <span class="font-mono text-role-tool">{t().name}</span>
                <Show when={(t().state as { progress?: string }).progress}>
                  {" — "}
                  <span class="text-fg-faint">
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

const Spinner: Component = () => (
  <span class="relative inline-flex h-2.5 w-2.5">
    <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-75" />
    <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-warn" />
  </span>
);

export default WorkerIndicator;
