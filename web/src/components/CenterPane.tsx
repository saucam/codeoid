/**
 * Center pane — transcript + prompt. P2 stub: shows the focused session's
 * header with full metrics + identity context. Transcript renderer + prompt
 * land in P4.
 */

import { Component, Show } from "solid-js";

import {
  formatCostUsd,
  formatDuration,
  formatPercent,
  formatTokens,
  relativeTime,
} from "../lib/format";
import { sessionAgentLabel, truncateWimseUri } from "../lib/identity";
import { createMessages } from "../state/messages";
import { focusedSession, focusedSessionId } from "../state/sessions";

const CenterPane: Component = () => {
  const messages = createMessages(focusedSessionId);
  return (
    <main class="row-start-2 flex flex-col bg-bg">
      <Show
        when={focusedSession()}
        fallback={
          <div class="flex flex-1 items-center justify-center px-6 text-fg-muted">
            <p class="text-sm">Select a session from the sidebar.</p>
          </div>
        }
      >
        {(s) => (
          <>
            <SessionHeader />
            <section class="flex-1 overflow-y-auto px-6 py-4">
              <div class="mx-auto max-w-3xl space-y-3 text-sm text-fg-muted">
                <p>
                  Showing{" "}
                  <span class="text-fg">{messages().length}</span> message(s) for{" "}
                  <span class="text-fg">{s().name}</span>.
                </p>
                <p class="text-xs text-fg-faint">
                  Transcript renderer arrives in phase 4. Workdir:{" "}
                  <span class="font-mono">{s().workdir}</span>
                </p>
              </div>
            </section>
            <PromptStub />
          </>
        )}
      </Show>
    </main>
  );
};

const SessionHeader: Component = () => (
  <Show when={focusedSession()}>
    {(s) => (
      <div class="flex flex-col gap-2 border-b border-border bg-bg-elev/60 px-4 py-3">
        <div class="flex items-center gap-3">
          <h2 class="font-semibold text-fg">{s().name}</h2>
          <span class="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
            {s().mode ?? "interactive"}
          </span>
          <Show when={s().model}>
            <span class="rounded border border-accent/30 bg-accent/5 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent">
              {s().model}
            </span>
          </Show>
          <span class="ml-auto font-mono text-[11px] text-fg-faint">
            created {relativeTime(s().createdAt)}
          </span>
        </div>
        <div
          class="truncate font-mono text-[11px] text-fg-muted"
          title={s().workdir}
        >
          {s().workdir}
        </div>
        <div
          class="flex items-center gap-2 truncate text-[11px] text-fg-faint"
          title={s().agentUri ?? "anonymous"}
        >
          <span>⌬</span>
          <span class="font-mono">
            {s().agentUri && !s().agentUri!.startsWith("anonymous:")
              ? truncateWimseUri(s().agentUri!)
              : sessionAgentLabel(s())}
          </span>
        </div>
        <UsageStrip />
      </div>
    )}
  </Show>
);

const UsageStrip: Component = () => (
  <Show when={focusedSession()?.usage}>
    {(u) => (
      <div class="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4 lg:grid-cols-7">
        <Stat label="Turns" value={String(u().numTurns)} />
        <Stat label="Input" value={formatTokens(u().inputTokens)} />
        <Stat label="Output" value={formatTokens(u().outputTokens)} />
        <Stat
          label="Cache read"
          value={formatTokens(u().cacheReadTokens)}
          hint={
            u().lastTurnCacheHitRate != null
              ? `last hit rate ${formatPercent(u().lastTurnCacheHitRate, 0)}`
              : undefined
          }
        />
        <Stat label="Cache write" value={formatTokens(u().cacheCreationTokens)} />
        <Stat
          label="Agent time"
          value={formatDuration(u().durationMs)}
          hint="sum of per-turn agent work"
        />
        <Stat
          label="Cost"
          value={formatCostUsd(u().totalCostUsd)}
          accent
          hint="SDK-reported, daemon-canonical"
        />
      </div>
    )}
  </Show>
);

const Stat: Component<{
  label: string;
  value: string;
  accent?: boolean;
  hint?: string;
}> = (props) => (
  <div
    class="flex flex-col gap-0.5 rounded border border-border bg-bg px-2 py-1.5"
    title={props.hint}
  >
    <span class="text-[10px] uppercase tracking-wider text-fg-faint">
      {props.label}
    </span>
    <span
      class={`font-mono text-sm ${props.accent ? "text-accent font-semibold" : "text-fg"}`}
    >
      {props.value}
    </span>
  </div>
);

const PromptStub: Component = () => (
  <footer class="border-t border-border bg-bg-elev px-4 py-3 text-xs text-fg-faint">
    Prompt arrives in phase 4 — Enter sends, Shift+Enter newline.
  </footer>
);

export default CenterPane;
