/**
 * Left sidebar — session list (top) + file tree (bottom). Both are
 * scoped to the focused session. Has a "collapse to rail" mode where
 * the sidebar shrinks to 56px and renders icon-only chrome so the
 * chat area dominates the viewport.
 */

import { Component, For, Show } from "solid-js";

import { formatCostUsd, formatTokens, relativeTime } from "../lib/format";
import { sessionAgentLabel, shortSub } from "../lib/identity";
import {
  focusedSessionId,
  focusSession,
  sessionList,
} from "../state/sessions";
import {
  closeNav,
  isLeftCollapsed,
  isMobile,
  toggleLeftCollapsed,
} from "../state/layout";
import type { SessionInfo, SessionStatus } from "../protocol/types";

import FileTree from "./files/FileTree";
import { openNewSessionModal } from "./NewSessionModal";

/** Focus a session and, on mobile, close the off-canvas drawer. */
function pickSession(id: string): void {
  focusSession(id);
  if (isMobile()) closeNav();
}

const SessionListPane: Component = () => {
  return (
    <Show
      when={!isLeftCollapsed()}
      fallback={<CollapsedRail />}
    >
      <aside class="row-start-2 col-start-1 flex h-full flex-col overflow-y-auto border-r border-border bg-bg-elev">
        <SectionHeader title="Sessions" count={sessionList().length} />
        <button
          type="button"
          onClick={openNewSessionModal}
          class="mx-3 mt-1 flex items-center gap-2 rounded border border-dashed border-border px-2 py-1.5 text-left text-xs text-fg-muted transition hover:border-accent/40 hover:bg-accent/5 hover:text-fg"
          title="New session (Ctrl+N)"
        >
          <span class="text-base leading-none">＋</span>
          <span>new session</span>
          <span class="ml-auto rounded bg-bg px-1 py-0.5 font-mono text-[10px] text-fg-faint">
            ⌘N
          </span>
        </button>
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
        <Show when={focusedSessionId()}>
          <div class="mt-2 border-t border-border pt-1">
            <FileTree />
          </div>
        </Show>
      </aside>
    </Show>
  );
};

const CollapsedRail: Component = () => (
  <aside class="row-start-2 col-start-1 flex h-full flex-col items-center gap-2 overflow-y-auto border-r border-border bg-bg-elev py-2">
    <button
      type="button"
      onClick={toggleLeftCollapsed}
      class="rounded p-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
      title="Expand sidebar"
    >
      ▸
    </button>
    <button
      type="button"
      onClick={openNewSessionModal}
      class="rounded p-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
      title="New session (Ctrl+N)"
    >
      ＋
    </button>
    <div class="my-1 h-px w-6 bg-border" />
    <For each={sessionList()}>
      {(s) => (
        <button
          type="button"
          onClick={() => pickSession(s.id)}
          class={`flex h-7 w-7 items-center justify-center rounded text-[11px] font-mono transition ${
            focusedSessionId() === s.id
              ? "bg-accent/20 text-accent"
              : "text-fg-muted hover:bg-bg-hover hover:text-fg"
          }`}
          title={`${s.name} · ${s.workdir}`}
        >
          {s.name.slice(0, 2).toUpperCase()}
        </button>
      )}
    </For>
  </aside>
);

const SectionHeader: Component<{ title: string; count: number }> = (props) => (
  <div class="sticky top-0 z-10 flex items-center justify-between gap-2 bg-bg-elev/95 px-3 pb-2 pt-3 text-[11px] font-medium uppercase tracking-wider text-fg-faint backdrop-blur">
    <span>{props.title}</span>
    <Show when={props.count > 0}>
      <span class="rounded-full bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
        {props.count}
      </span>
    </Show>
    <button
      type="button"
      onClick={toggleLeftCollapsed}
      class="ml-auto rounded p-0.5 text-fg-faint transition hover:bg-bg-hover hover:text-fg"
      title="Collapse sidebar"
    >
      ◂
    </button>
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
        onClick={() => pickSession(props.session.id)}
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
      case "working":
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
