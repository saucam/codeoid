/**
 * Cross-session search — Ctrl+K. Hits `session.search` with a debounced
 * query and renders ranked sessions with snippet previews. Clicking a
 * hit focuses that session.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { getClient, newRequestId } from "../state/connection";
import { focusSession, focusedSession } from "../state/sessions";
import { relativeTime } from "../lib/format";
import type {
  SessionSearchHit,
  SessionSearchResultMsg,
} from "../protocol/types";

const DEBOUNCE_MS = 220;

const SearchModal: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<SessionSearchHit[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [highlight, setHighlight] = createSignal(0);

  let inputRef: HTMLInputElement | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let runId = 0;

  function reset(): void {
    setQuery("");
    setHits([]);
    setError(null);
    setHighlight(0);
    setBusy(false);
  }

  // Global Ctrl+K to toggle, Esc to close.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        if (open()) requestAnimationFrame(() => inputRef?.focus());
      } else if (e.key === "Escape" && open()) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // Reset on close.
  createEffect(
    on(open, (v) => {
      if (!v) reset();
      else requestAnimationFrame(() => inputRef?.focus());
    }),
  );

  // Debounce + dispatch search on every query change.
  createEffect(
    on(query, async (q) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      const trimmed = q.trim();
      if (trimmed.length < 2) {
        setHits([]);
        setBusy(false);
        return;
      }
      const myRun = ++runId;
      setBusy(true);
      debounceTimer = setTimeout(async () => {
        try {
          const id = newRequestId();
          const result = await getClient().request<SessionSearchResultMsg>(
            {
              type: "session.search",
              id,
              query: trimmed,
              limit: 10,
              ...(focusedSession()?.workdir
                ? { workdir: focusedSession()!.workdir, scope: "workspace" }
                : { scope: "all" }),
            },
            {
              waitForResult: (m) =>
                m.type === "session.search.result" && m.requestId === id ? m : undefined,
              timeoutMs: 8_000,
            },
          );
          if (myRun !== runId) return;
          setHits(result.sessions);
          setError(null);
        } catch (err) {
          if (myRun !== runId) return;
          setError(err instanceof Error ? err.message : String(err));
          setHits([]);
        } finally {
          if (myRun === runId) setBusy(false);
        }
      }, DEBOUNCE_MS);
    }),
  );

  function pick(idx: number): void {
    const hit = hits()[idx];
    if (!hit) return;
    focusSession(hit.sessionId);
    setOpen(false);
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setHighlight((h) => Math.min(h + 1, hits().length - 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      pick(highlight());
    }
  }

  return (
    <Show when={open()}>
      <div
        class="fixed inset-0 z-40 flex items-start justify-center bg-bg/70 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpen(false);
        }}
      >
        <div class="mt-[12vh] w-full max-w-2xl rounded-lg border border-border bg-bg-elev shadow-2xl">
          <div class="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <span class="text-fg-faint">🔍</span>
            <input
              ref={inputRef}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder="Search messages, tools, code…"
              class="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint"
              autocomplete="off"
              spellcheck={false}
            />
            <span class="rounded border border-border px-1.5 py-0.5 text-[10px] text-fg-faint">
              Ctrl+K
            </span>
          </div>
          <ResultsBody
            busy={busy()}
            error={error()}
            query={query()}
            hits={hits()}
            highlight={highlight()}
            setHighlight={setHighlight}
            onPick={pick}
          />
        </div>
      </div>
    </Show>
  );
};

const ResultsBody: Component<{
  busy: boolean;
  error: string | null;
  query: string;
  hits: SessionSearchHit[];
  highlight: number;
  setHighlight: (n: number) => void;
  onPick: (idx: number) => void;
}> = (props) => {
  const empty = createMemo(
    () =>
      !props.busy &&
      !props.error &&
      props.query.trim().length >= 2 &&
      props.hits.length === 0,
  );
  return (
    <div class="max-h-[60vh] overflow-y-auto">
      <Show when={props.error}>
        <div class="p-3 text-sm text-danger">{props.error}</div>
      </Show>
      <Show when={props.busy}>
        <div class="p-3 text-xs text-fg-faint">searching…</div>
      </Show>
      <Show when={empty()}>
        <div class="p-6 text-center text-sm text-fg-muted">No matches.</div>
      </Show>
      <Show when={!props.busy && !props.error && props.query.trim().length < 2}>
        <div class="p-6 text-center text-sm text-fg-muted">
          <p>Type at least 2 characters to search across sessions.</p>
        </div>
      </Show>
      <ul class="divide-y divide-border">
        <For each={props.hits}>
          {(hit, idx) => (
            <li
              onClick={() => props.onPick(idx())}
              onMouseEnter={() => props.setHighlight(idx())}
              class={`cursor-pointer px-3 py-2 transition ${
                idx() === props.highlight ? "bg-bg-active" : "hover:bg-bg-hover"
              }`}
            >
              <div class="flex items-center gap-2 text-sm">
                <span class="font-medium text-fg">{hit.sessionName}</span>
                <span class="font-mono text-[11px] text-fg-faint">{hit.workdir}</span>
                <span class="ml-auto text-[10px] text-fg-faint">
                  {hit.matchCount} matches · last {relativeTime(hit.lastMatchAt)}
                </span>
              </div>
              <div class="mt-1 space-y-1">
                <For each={hit.snippets.slice(0, 2)}>
                  {(s) => (
                    <div class="truncate text-[11px] text-fg-muted">
                      <span class="text-accent">{s.kind}</span>
                      {s.toolName ? ` · ${s.toolName}` : ""} · {s.excerpt}
                    </div>
                  )}
                </For>
              </div>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
};

export default SearchModal;
