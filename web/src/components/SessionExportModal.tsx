/**
 * Session export modal — triggered by the session row context menu or
 * `/export`. Issues `session.export`, surfaces the manifest preview,
 * and offers a download button (inline JSON or file path).
 */

import { Component, Show, createSignal, onCleanup, onMount } from "solid-js";

import { getClient, newRequestId } from "../state/connection";
import { focusedSession } from "../state/sessions";
import type {
  SessionExportResultMsg,
} from "../protocol/types";

const [openSignal, setOpenSignal] = createSignal(false);

export function openExportModal(): void {
  setOpenSignal(true);
}

const SessionExportModal: Component = () => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [includeMemory, setIncludeMemory] = createSignal(true);
  const [includePinnedFiles, setIncludePinnedFiles] = createSignal(false);
  const [aliasOverride, setAliasOverride] = createSignal("");
  const [result, setResult] = createSignal<SessionExportResultMsg | null>(null);

  function reset(): void {
    setBusy(false);
    setError(null);
    setResult(null);
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openSignal()) {
        e.preventDefault();
        setOpenSignal(false);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  async function runExport(): Promise<void> {
    const session = focusedSession();
    if (!session) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const id = newRequestId();
      const res = await getClient().request<SessionExportResultMsg>(
        {
          type: "session.export",
          id,
          sessionId: session.id,
          includeMemory: includeMemory(),
          includePinnedFiles: includePinnedFiles(),
          ...(aliasOverride().trim()
            ? { aliasOverride: aliasOverride().trim() }
            : {}),
        },
        {
          waitForResult: (m) =>
            m.type === "session.export.result" && m.requestId === id ? m : undefined,
          timeoutMs: 30_000,
        },
      );
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function downloadInline(): void {
    const r = result();
    if (!r || r.payload.kind !== "inline") return;
    const json = JSON.stringify(r.payload.bundle, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const slug = (r.manifest.session.name || r.manifest.session.id)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .slice(0, 40) || "session";
    a.download = `codeoid-${slug}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Show when={openSignal()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setOpenSignal(false);
            reset();
          }
        }}
      >
        <div class="mt-[10vh] w-full max-w-lg rounded-lg border border-border bg-bg-elev p-5 shadow-2xl">
          <header class="mb-3 flex items-center gap-2">
            <h2 class="text-base font-semibold tracking-tight text-fg">
              Export session
            </h2>
            <button
              type="button"
              onClick={() => {
                setOpenSignal(false);
                reset();
              }}
              class="ml-auto text-fg-faint hover:text-fg"
              title="Close (Esc)"
            >
              ✕
            </button>
          </header>

          <Show when={!focusedSession()}>
            <p class="text-sm text-fg-muted">No session focused.</p>
          </Show>

          <Show when={focusedSession() && !result()}>
            {(_) => (
              <div class="space-y-3">
                <p class="text-[12px] text-fg-muted">
                  Bundle includes the transcript and (optionally) memory
                  episodes + per-turn usage. Paths get rewritten against
                  a workdir alias derived from your git remote so the
                  bundle is portable.
                </p>
                <label class="flex items-center gap-2 text-[12px] text-fg">
                  <input
                    type="checkbox"
                    checked={includeMemory()}
                    onChange={(e) => setIncludeMemory(e.currentTarget.checked)}
                  />
                  <span>Include memory episodes</span>
                </label>
                <label class="flex items-center gap-2 text-[12px] text-fg">
                  <input
                    type="checkbox"
                    checked={includePinnedFiles()}
                    onChange={(e) => setIncludePinnedFiles(e.currentTarget.checked)}
                  />
                  <span>
                    Include pinned files (snapshots — content embedded in
                    the bundle)
                  </span>
                </label>
                <label class="block space-y-1">
                  <span class="text-[10px] uppercase tracking-wider text-fg-faint">
                    Alias override (optional)
                  </span>
                  <input
                    type="text"
                    placeholder="e.g. github.com/team/repo"
                    value={aliasOverride()}
                    onInput={(e) => setAliasOverride(e.currentTarget.value)}
                    class="w-full rounded border border-border bg-bg px-2 py-1 font-mono text-[12px] text-fg outline-none focus:border-accent"
                  />
                  <p class="text-[10px] text-fg-faint">
                    Daemon auto-resolves from `git remote get-url origin`
                    when blank.
                  </p>
                </label>
                <Show when={error()}>
                  <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                    {error()}
                  </div>
                </Show>
                <div class="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenSignal(false);
                      reset();
                    }}
                    class="rounded border border-border px-3 py-1.5 text-sm text-fg-muted hover:bg-bg-hover"
                    disabled={busy()}
                  >
                    cancel
                  </button>
                  <button
                    type="button"
                    onClick={runExport}
                    class="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-bg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy()}
                  >
                    {busy() ? "exporting…" : "Export"}
                  </button>
                </div>
              </div>
            )}
          </Show>

          <Show when={result()}>
            {(r) => (
              <div class="space-y-3">
                <div class="rounded border border-success/40 bg-success/5 px-3 py-2 text-sm text-success">
                  Bundle ready · {Math.round(r().payload.sizeBytes / 1024)}{" "}
                  KB · {r().manifest.counts.messages} msgs ·{" "}
                  {r().manifest.counts.episodes} episodes ·{" "}
                  {r().manifest.counts.turns} turns
                </div>
                <dl class="grid grid-cols-[6rem_1fr] gap-y-1 text-[12px]">
                  <dt class="text-fg-faint">alias</dt>
                  <dd class="break-all font-mono text-fg">
                    {r().manifest.workdir.alias}
                  </dd>
                  <dt class="text-fg-faint">source</dt>
                  <dd class="font-mono text-fg-muted">
                    {r().manifest.workdir.aliasSource}
                  </dd>
                  <dt class="text-fg-faint">workdir</dt>
                  <dd class="break-all font-mono text-fg-muted">
                    {r().manifest.workdir.originalAbsolute}
                  </dd>
                  <dt class="text-fg-faint">payload</dt>
                  <dd class="font-mono text-fg-muted">{r().payload.kind}</dd>
                  <Show when={r().payload.kind === "file"}>
                    <dt class="text-fg-faint">file</dt>
                    <dd class="break-all font-mono text-[11px] text-fg">
                      {(r().payload as { path: string }).path}
                    </dd>
                  </Show>
                </dl>
                <div class="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenSignal(false);
                      reset();
                    }}
                    class="rounded border border-border px-3 py-1.5 text-sm text-fg-muted hover:bg-bg-hover"
                  >
                    close
                  </button>
                  <Show
                    when={r().payload.kind === "inline"}
                    fallback={
                      <button
                        type="button"
                        onClick={() => {
                          if (r().payload.kind === "file") {
                            void navigator.clipboard?.writeText(
                              (r().payload as { path: string }).path,
                            );
                          }
                        }}
                        class="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-bg transition hover:bg-accent-hover"
                      >
                        copy file path
                      </button>
                    }
                  >
                    <button
                      type="button"
                      onClick={downloadInline}
                      class="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-bg transition hover:bg-accent-hover"
                    >
                      download .json
                    </button>
                  </Show>
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default SessionExportModal;
