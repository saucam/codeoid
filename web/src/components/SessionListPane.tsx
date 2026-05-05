/**
 * Left sidebar — session list with per-row metrics, identity, and
 * status. Future-me note: file-tree pane mounts BELOW this in the same
 * column when P5 lands.
 */

import { Component, For, Show } from "solid-js";

import { formatCostUsd, formatTokens, relativeTime } from "../lib/format";
import { sessionAgentLabel, shortSub } from "../lib/identity";
import {
  focusedSessionId,
  focusSession,
  sessionList,
} from "../state/sessions";
import type { SessionInfo, SessionStatus } from "../protocol/types";

const SessionListPane: Component = () => {
  return (
    <aside class="row-start-2 flex flex-col overflow-y-auto border-r border-border bg-bg-elev">
      <SectionHeader title="Sessions" count={sessionList().length} />
      <Show
        when={sessionList().length > 0}
        fallback={<EmptyState />}
      >
        <ul class="flex flex-col py-1">
          <For each={sessionList()}>
            {(s) => <SessionRow session={s} />}
          </For>
        </ul>
      </Show>
    </aside>
  );
};

const SectionHeader: Component<{ title: string; count: number }> = (props) => (
  <div class="sticky top-0 z-10 flex items-center justify-between bg-bg-elev/95 px-3 pb-2 pt-3 text-[11px] font-medium uppercase tracking-wider text-fg-faint backdrop-blur">
    <span>{props.title}</span>
    <Show when={props.count > 0}>
      <span class="rounded-full bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
        {props.count}
      </span>
    </Show>
  </div>
);

const EmptyState: Component = () => (
  <div class="px-3 py-6 text-sm text-fg-muted">
    <p class="mb-2">No sessions yet.</p>
    <p class="text-xs text-fg-faint">
      Create one from the prompt with <code class="font-mono">/new &lt;name&gt; [workdir]</code>.
    </p>
  </div>
);

const SessionRow: Component<{ session: SessionInfo }> = (props) => {
  const isActive = () => focusedSessionId() === props.session.id;
  return (
    <li>
      <button
        type="button"
        onClick={() => focusSession(props.session.id)}
        class={`flex w-full flex-col gap-1 border-l-2 px-3 py-2 text-left transition hover:bg-bg-hover ${
          isActive()
            ? "border-l-accent bg-bg-active"
            : "border-l-transparent"
        }`}
      >
        <div class="flex items-center gap-2">
          <StatusDot status={props.session.status} />
          <span class="flex-1 truncate text-sm font-medium text-fg">
            {props.session.name}
          </span>
          <Show when={props.session.usage}>
            {(u) => (
              <span class="font-mono text-[11px] text-accent" title="Estimated cost">
                {formatCostUsd(u().totalCostUsd)}
              </span>
            )}
          </Show>
        </div>
        <div
          class="truncate text-[11px] text-fg-faint"
          title={props.session.workdir}
        >
          {props.session.workdir}
        </div>
        <div class="flex items-center gap-2 text-[11px] text-fg-muted">
          <span title={`Agent: ${props.session.agentUri ?? "anonymous"}`}>
            ⌬ <span class="font-mono">{sessionAgentLabel(props.session)}</span>
          </span>
          <Show when={props.session.usage}>
            {(u) => (
              <>
                <span class="text-fg-faint">·</span>
                <span title="Cumulative input / output tokens">
                  {formatTokens(u().inputTokens)}/{formatTokens(u().outputTokens)}
                </span>
                <span class="text-fg-faint">·</span>
                <span title="Total turns">{u().numTurns}t</span>
              </>
            )}
          </Show>
          <Show
            when={
              props.session.subagents &&
              props.session.subagents.filter((sa) => sa.active).length > 0
            }
          >
            <span class="text-fg-faint">·</span>
            <span
              class="text-role-tool"
              title={
                props.session.subagents
                  ?.filter((sa) => sa.active)
                  .map((sa) => `${sa.agentType} (${shortSub(sa.wimseUri)})`)
                  .join("\n")
              }
            >
              {
                props.session.subagents?.filter((sa) => sa.active).length
              }{" "}
              sub
            </span>
          </Show>
        </div>
        <div class="text-[10px] text-fg-faint">
          created {relativeTime(props.session.createdAt)}
        </div>
      </button>
    </li>
  );
};

const StatusDot: Component<{ status: SessionStatus }> = (props) => {
  const cls = () => {
    switch (props.status) {
      case "thinking":
      case "tool_running":
        return "bg-warn animate-pulse";
      case "error":
        return "bg-danger";
      default:
        return "bg-success/70";
    }
  };
  return (
    <span
      class={`inline-block h-2 w-2 shrink-0 rounded-full ${cls()}`}
      title={props.status}
    />
  );
};

export default SessionListPane;
