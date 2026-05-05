/**
 * Modal directory picker — drives the daemon's `fs.browse_dir` verb.
 * Lists directories under a configurable root (HOME by default), with
 * a breadcrumb up to that root and `..` to step out one level. The
 * caller passes `onPick` to receive the absolute path the user chose.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { getClient, newRequestId } from "../../state/connection";
import type {
  FsBrowseDirResultMsg,
  FsEntry,
} from "../../protocol/types";

interface BrowseState {
  loading: boolean;
  path: string;
  root: string;
  parent: string | null;
  entries: FsEntry[];
  error: string | null;
}

const EMPTY: BrowseState = {
  loading: false,
  path: "",
  root: "",
  parent: null,
  entries: [],
  error: null,
};

const DirectoryPicker: Component<{
  open: boolean;
  /** Initial directory to start browsing in (absolute). Defaults to HOME. */
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}> = (props) => {
  const [state, setState] = createSignal<BrowseState>(EMPTY);

  async function browse(p?: string): Promise<void> {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const id = newRequestId();
      const result = await getClient().request<FsBrowseDirResultMsg>(
        { type: "fs.browse_dir", id, ...(p ? { path: p } : {}) },
        {
          waitForResult: (m) =>
            m.type === "fs.browse_dir.result" && m.requestId === id ? m : undefined,
          timeoutMs: 8_000,
        },
      );
      setState({
        loading: false,
        path: result.path,
        root: result.root,
        parent: result.parent,
        entries: result.entries,
        error: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  // Re-browse when the modal opens or the initial path changes.
  createEffect(
    on(
      () => props.open,
      (o) => {
        if (!o) return;
        void browse(props.initialPath);
      },
    ),
  );

  // Esc to close.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.open) {
        e.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        <div class="mt-[10vh] w-full max-w-xl rounded-lg border border-border bg-bg-elev shadow-2xl">
          <header class="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <span class="text-fg-faint">📁</span>
            <span class="font-semibold text-fg">Choose workdir</span>
            <button
              type="button"
              onClick={props.onClose}
              class="ml-auto text-fg-faint hover:text-fg"
              title="Close (Esc)"
            >
              ✕
            </button>
          </header>
          <Breadcrumb state={state()} onNavigate={browse} />
          <div class="max-h-[55vh] overflow-y-auto">
            <Show when={state().error}>
              <div class="p-3 text-sm text-danger">{state().error}</div>
            </Show>
            <Show when={state().loading}>
              <div class="p-3 text-xs text-fg-faint">loading…</div>
            </Show>
            <Show when={!state().loading && state().entries.length === 0 && !state().error}>
              <div class="p-6 text-center text-sm text-fg-muted">
                No subdirectories here.
              </div>
            </Show>
            <ul class="divide-y divide-border/50">
              <Show when={state().parent}>
                <li>
                  <button
                    type="button"
                    onClick={() => browse(state().parent ?? undefined)}
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-muted hover:bg-bg-hover"
                  >
                    <span class="font-mono">↑</span>
                    <span class="font-mono text-[12px]">..</span>
                  </button>
                </li>
              </Show>
              <For each={state().entries}>
                {(entry) => (
                  <li>
                    <div class="flex items-center gap-2 px-3 py-1.5 hover:bg-bg-hover">
                      <button
                        type="button"
                        onDblClick={() => browse(entry.path)}
                        onClick={() => browse(entry.path)}
                        class="flex flex-1 items-center gap-2 text-left text-sm text-fg"
                        title="Click to open"
                      >
                        <span class="text-fg-faint">▢</span>
                        <span class="truncate font-mono">{entry.name}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          props.onPick(entry.path);
                          props.onClose();
                        }}
                        class="rounded border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted hover:border-accent/40 hover:text-accent"
                        title="Use this directory as the session workdir"
                      >
                        pick
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </div>
          <footer class="flex items-center gap-2 border-t border-border px-3 py-2">
            <span class="truncate font-mono text-[11px] text-fg-faint" title={state().path}>
              {state().path || "—"}
            </span>
            <button
              type="button"
              onClick={() => {
                if (state().path) {
                  props.onPick(state().path);
                  props.onClose();
                }
              }}
              disabled={!state().path}
              class="ml-auto rounded bg-accent px-3 py-1 text-xs font-semibold text-bg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              title="Use the current directory"
            >
              use this
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
};

const Breadcrumb: Component<{
  state: BrowseState;
  onNavigate: (p: string) => void;
}> = (props) => {
  const segments = () => {
    const root = props.state.root;
    const path = props.state.path;
    if (!root || !path) return [] as { label: string; full: string }[];
    if (path === root) return [{ label: "~", full: root }];
    if (!path.startsWith(root + "/")) return [{ label: path, full: path }];
    const tail = path.slice(root.length + 1);
    const parts = tail.split("/");
    const out = [{ label: "~", full: root }];
    let acc = root;
    for (const part of parts) {
      acc = `${acc}/${part}`;
      out.push({ label: part, full: acc });
    }
    return out;
  };
  return (
    <nav class="flex items-center gap-1 overflow-x-auto whitespace-nowrap border-b border-border/50 px-3 py-1.5 text-[12px]">
      <For each={segments()}>
        {(seg, idx) => (
          <>
            <Show when={idx() > 0}>
              <span class="text-fg-faint">/</span>
            </Show>
            <button
              type="button"
              onClick={() => props.onNavigate(seg.full)}
              class={`rounded px-1 font-mono transition hover:bg-bg-hover ${
                idx() === segments().length - 1
                  ? "text-fg"
                  : "text-fg-muted"
              }`}
              title={seg.full}
            >
              {seg.label}
            </button>
          </>
        )}
      </For>
    </nav>
  );
};

export default DirectoryPicker;
