/**
 * Lazy-expanding file tree rooted at the focused session's workdir. Lives
 * in the left sidebar below the session list. On first focus of a
 * session, the root listing loads on demand.
 */

import { Component, For, Show, createEffect, on } from "solid-js";

import {
  loadDirectory,
  nodeOf,
  openFilePath,
  resetFileTreeForSession,
  toggleExpanded,
} from "../../state/files";
import { focusedSession, focusedSessionId } from "../../state/sessions";
import type { FsEntry } from "../../protocol/types";

const FileTree: Component = () => {
  // Reset cached file state when the session changes; load the root.
  createEffect(
    on(focusedSessionId, (sid, prev) => {
      if (prev !== undefined && prev !== sid) {
        resetFileTreeForSession(prev as string);
      }
      if (sid) {
        // clearFirst: true ensures entries are wiped before the fetch so the
        // loading indicator always shows on session switch — without it, stale
        // entries from a previous visit display silently until the response
        // arrives, making the tree look like it didn't switch sessions.
        void loadDirectory(sid, ".", { clearFirst: true });
      }
    }),
  );

  return (
    <div class="flex flex-col">
      <div class="flex items-center justify-between bg-bg-elev/95 px-3 pt-3 text-[11px] font-medium uppercase tracking-wider text-fg-faint backdrop-blur">
        <span>Files</span>
        <Show when={focusedSession()}>
          <button
            type="button"
            class="text-fg-faint hover:text-fg-muted"
            title="Refresh tree"
            onClick={() => {
              const sid = focusedSessionId();
              if (sid) void loadDirectory(sid, ".");
            }}
          >
            ⟳
          </button>
        </Show>
      </div>
      <Show when={focusedSession()}>
        {(s) => (
          <div
            class="truncate px-3 pb-1 font-mono text-[10px] text-fg-faint"
            title={s().workdir}
          >
            {s().workdir}
          </div>
        )}
      </Show>
      <Show
        when={focusedSessionId()}
        fallback={
          <div class="px-3 py-3 text-xs text-fg-faint">No session selected.</div>
        }
      >
        {(sid) => <DirectoryNode sessionId={sid()} path="." depth={0} />}
      </Show>
    </div>
  );
};

const DirectoryNode: Component<{
  sessionId: string;
  path: string;
  depth: number;
}> = (props) => {
  const node = () => nodeOf(props.sessionId, props.path);
  return (
    <ul class="flex flex-col py-0.5">
      <Show
        when={node().loading && node().entries === null}
        fallback={
          <Show when={node().error}>
            <li class="px-3 py-1 text-[11px] text-danger">{node().error}</li>
          </Show>
        }
      >
        <li class="px-3 py-1 text-[11px] text-fg-faint">loading…</li>
      </Show>
      <Show when={node().entries}>
        {(entries) => (
          <For each={entries()}>
            {(entry) => (
              <FileTreeRow
                sessionId={props.sessionId}
                entry={entry}
                depth={props.depth}
              />
            )}
          </For>
        )}
      </Show>
    </ul>
  );
};

const FileTreeRow: Component<{
  sessionId: string;
  entry: FsEntry;
  depth: number;
}> = (props) => {
  const isDir = () => props.entry.kind === "directory";
  const node = () =>
    isDir() ? nodeOf(props.sessionId, props.entry.path) : null;

  const indent = () => `${0.5 + props.depth * 0.875}rem`;

  return (
    <li>
      <button
        type="button"
        onClick={() => {
          if (isDir()) {
            void toggleExpanded(props.sessionId, props.entry.path);
          } else {
            void openFilePath(props.sessionId, props.entry.path);
          }
        }}
        class={`flex w-full items-center gap-1 px-3 py-0.5 text-left text-[12px] hover:bg-bg-hover ${
          isDir() ? "text-fg-muted" : "text-fg"
        }`}
        style={{ "padding-left": indent() }}
      >
        <span class="w-3 shrink-0 text-fg-faint">
          {isDir() ? (node()?.expanded ? "▾" : "▸") : ""}
        </span>
        <span class="shrink-0">{isDir() ? "▢" : "·"}</span>
        <span class="flex-1 truncate font-mono">{props.entry.name}</span>
        <Show when={!isDir() && props.entry.size != null}>
          <span class="shrink-0 font-mono text-[10px] text-fg-faint">
            {humanSize(props.entry.size!)}
          </span>
        </Show>
      </button>
      <Show when={isDir() && node()?.expanded}>
        <DirectoryNode
          sessionId={props.sessionId}
          path={props.entry.path}
          depth={props.depth + 1}
        />
      </Show>
    </li>
  );
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

export default FileTree;
