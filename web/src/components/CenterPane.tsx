/**
 * Center pane — header (with full UsageStrip) → transcript →
 * approval bar (when active) → prompt.
 */

import { Component, Show } from "solid-js";

import {
  formatCostUsd,
  formatDuration,
  formatPercent,
  formatTokens,
  relativeTime,
} from "../lib/format";
import { sessionAgentLabel, shortSub, truncateWimseUri } from "../lib/identity";
import { focusedSession } from "../state/sessions";

import ApprovalBar from "./transcript/ApprovalBar";
import PromptBox from "./prompt/PromptBox";
import SessionControls from "./SessionControls";
import Transcript from "./transcript/Transcript";
import WorkerIndicator from "./transcript/WorkerIndicator";
import { openNewSessionModal } from "./NewSessionModal";

const CenterPane: Component = () => {
  return (
    <main class="row-start-2 col-start-3 flex min-h-0 min-w-0 flex-col bg-bg">
      <Show
        when={focusedSession()}
        fallback={
          <div class="flex flex-1 items-center justify-center px-6">
            <div class="max-w-md space-y-4 text-center">
              <h1 class="text-lg font-semibold text-fg">No active session</h1>
              <p class="text-sm text-fg-muted">
                Sessions are persistent Claude conversations rooted at a
                workdir. The daemon registers a per-session ZeroID identity
                so any frontend (web, TUI, Telegram) can resume them.
              </p>
              <button
                type="button"
                onClick={openNewSessionModal}
                class="rounded bg-accent px-4 py-2 text-sm font-semibold text-bg transition hover:bg-accent-hover"
              >
                Create your first session
              </button>
              <p class="text-[11px] text-fg-faint">
                or press <kbd class="rounded border border-border bg-bg-elev px-1 font-mono">⌘N</kbd>{" "}
                anywhere ·{" "}
                <kbd class="rounded border border-border bg-bg-elev px-1 font-mono">⌘K</kbd>{" "}
                to search across sessions
              </p>
            </div>
          </div>
        }
      >
        <SessionHeader />
        <Transcript />
        <WorkerIndicator />
        <ApprovalBar />
        <PromptBox />
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
        <SessionControls />
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
          <SubagentChip />
        </div>
        <UsageStrip />
      </div>
    )}
  </Show>
);

const SubagentChip: Component = () => {
  const active = () =>
    focusedSession()?.subagents?.filter((sa) => sa.active) ?? [];
  return (
    <Show when={active().length > 0}>
      <span
        class="ml-2 flex items-center gap-1 rounded border border-role-tool/30 bg-role-tool/5 px-1.5 py-0.5 text-role-tool"
        title={active()
          .map((sa) => `${sa.agentType} · ${shortSub(sa.wimseUri)}`)
          .join("\n")}
      >
        <span>⊕</span>
        <span class="font-mono text-[10px]">{active().length} sub</span>
      </span>
    </Show>
  );
};

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

export default CenterPane;
