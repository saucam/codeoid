/**
 * Session import modal — pick a bundle (file picker or paste JSON),
 * map to a target workdir, fork off a new session.
 */

import { Component, Show, createSignal, onCleanup, onMount } from "solid-js";

import { getClient, newRequestId } from "../state/connection";
import { focusSession, sessionList } from "../state/sessions";
import { refreshSessions } from "../state/connection";
import type { SessionImportResultMsg } from "../protocol/types";

import DirectoryPicker from "./files/DirectoryPicker";

const [openSignal, setOpenSignal] = createSignal(false);

export function openImportModal(): void {
  setOpenSignal(true);
}

interface ParsedBundle {
  raw: unknown;
  alias: string;
  sessionName: string;
  counts: { messages: number; episodes: number; turns: number; pinnedFiles: number };
  exportedAt: string;
  exporter: string;
}

const SessionImportModal: Component = () => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [parsed, setParsed] = createSignal<ParsedBundle | null>(null);
  const [targetWorkdir, setTargetWorkdir] = createSignal("");
  const [nameOverride, setNameOverride] = createSignal("");
  const [writePinnedFiles, setWritePinnedFiles] = createSignal(false);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [result, setResult] = createSignal<SessionImportResultMsg | null>(null);

  function reset(): void {
    setBusy(false);
    setError(null);
    setParsed(null);
    setTargetWorkdir("");
    setNameOverride("");
    setWritePinnedFiles(false);
    setResult(null);
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openSignal() && !pickerOpen()) {
        e.preventDefault();
        setOpenSignal(false);
        reset();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  function handleFile(file: File): void {
    setError(null);
    void file.text().then((text) => {
      try {
        const obj = JSON.parse(text);
        validateAndSet(obj);
      } catch (err) {
        setError(`bundle isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  function validateAndSet(obj: unknown): void {
    if (!obj || typeof obj !== "object") {
      setError("bundle isn't an object");
      return;
    }
    const o = obj as Record<string, unknown>;
    if (o["kind"] !== "codeoid.session") {
      setError("not a codeoid session bundle (missing kind: 'codeoid.session')");
      return;
    }
    const manifest = o["manifest"] as Record<string, unknown> | undefined;
    if (!manifest) {
      setError("bundle is missing manifest");
      return;
    }
    const workdir = (manifest["workdir"] ?? {}) as Record<string, unknown>;
    const session = (manifest["session"] ?? {}) as Record<string, unknown>;
    const counts = (manifest["counts"] ?? {}) as Record<string, unknown>;
    const identity = (manifest["exporterIdentity"] ?? {}) as Record<string, unknown>;
    setParsed({
      raw: obj,
      alias: typeof workdir["alias"] === "string" ? (workdir["alias"] as string) : "—",
      sessionName: typeof session["name"] === "string" ? (session["name"] as string) : "—",
      counts: {
        messages: Number(counts["messages"] ?? 0),
        episodes: Number(counts["episodes"] ?? 0),
        turns: Number(counts["turns"] ?? 0),
        pinnedFiles: Number(counts["pinnedFiles"] ?? 0),
      },
      exportedAt:
        typeof manifest["exportedAt"] === "string"
          ? (manifest["exportedAt"] as string)
          : "—",
      exporter:
        typeof identity["name"] === "string"
          ? (identity["name"] as string)
          : typeof identity["sub"] === "string"
            ? (identity["sub"] as string)
            : "—",
    });
    // Suggest a workdir from sessions that share the alias, falling
    // back to the focused session's workdir. Previously the predicate
    // was `() => true`, which meant any session at all — usually the
    // most recent — masquerading as an alias match.
    const aliasFromBundle =
      typeof workdir["alias"] === "string" ? (workdir["alias"] as string) : null;
    const aliasMatch = aliasFromBundle
      ? sessionList().find((s) => s.workdir.endsWith(`/${aliasFromBundle}`))
      : null;
    const fallback = sessionList()[0] ?? null;
    const candidate = aliasMatch ?? fallback;
    if (candidate) setTargetWorkdir(candidate.workdir);
  }

  async function runImport(): Promise<void> {
    const p = parsed();
    if (!p) return;
    if (!targetWorkdir().trim()) {
      setError("pick a workdir to anchor the imported session");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const id = newRequestId();
      const res = await getClient().request<SessionImportResultMsg>(
        {
          type: "session.import",
          id,
          source: { kind: "inline", bundle: p.raw },
          targetWorkdir: targetWorkdir().trim(),
          ...(nameOverride().trim() ? { nameOverride: nameOverride().trim() } : {}),
          writePinnedFiles: writePinnedFiles(),
        },
        {
          waitForResult: (m) =>
            m.type === "session.import.result" && m.requestId === id ? m : undefined,
          timeoutMs: 30_000,
        },
      );
      setResult(res);
      // Update local state — refetch sessions and focus the new one.
      void refreshSessions().then(() => focusSession(res.newSessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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
              Import session
            </h2>
            <button
              type="button"
              onClick={() => {
                setOpenSignal(false);
                reset();
              }}
              class="ml-auto text-fg-faint hover:text-fg"
            >
              ✕
            </button>
          </header>

          <Show when={result()}>
            {(r) => (
              <div class="space-y-3">
                <div class="rounded border border-success/40 bg-success/5 px-3 py-2 text-sm text-success">
                  Forked into a new session ({r().importedMessages} msgs ·{" "}
                  {r().importedEpisodes} episodes · {r().importedTurns} turns
                  {r().pinnedFilesWritten > 0
                    ? ` · ${r().pinnedFilesWritten} pinned files written`
                    : ""}
                  ).
                </div>
                <Show when={r().warnings.length > 0}>
                  <ul class="space-y-1 rounded border border-warn/40 bg-warn/5 px-3 py-2 text-[12px] text-warn">
                    {r().warnings.map((w) => (
                      <li>⚠ {w}</li>
                    ))}
                  </ul>
                </Show>
                <div class="flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenSignal(false);
                      reset();
                    }}
                    class="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-bg hover:bg-accent-hover"
                  >
                    open new session
                  </button>
                </div>
              </div>
            )}
          </Show>

          <Show when={!result() && !parsed()}>
            <div class="space-y-3">
              <p class="text-[12px] text-fg-muted">
                Drop in a bundle exported via the Export modal. The
                daemon validates the format, rewrites paths against your
                target workdir, and forks a new session id.
              </p>
              <input
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  if (f) handleFile(f);
                }}
                class="block w-full text-[12px] text-fg-muted file:mr-3 file:rounded file:border file:border-border file:bg-bg file:px-3 file:py-1.5 file:text-fg-muted hover:file:border-accent/40"
              />
              <Show when={error()}>
                <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {error()}
                </div>
              </Show>
            </div>
          </Show>

          <Show when={!result() && parsed()}>
            {(p) => (
              <div class="space-y-3">
                <dl class="grid grid-cols-[7rem_1fr] gap-y-1 rounded border border-border bg-bg/40 px-3 py-2 text-[12px]">
                  <dt class="text-fg-faint">alias</dt>
                  <dd class="break-all font-mono text-fg">{p().alias}</dd>
                  <dt class="text-fg-faint">session</dt>
                  <dd class="font-mono text-fg">{p().sessionName}</dd>
                  <dt class="text-fg-faint">exporter</dt>
                  <dd class="break-all font-mono text-fg-muted">{p().exporter}</dd>
                  <dt class="text-fg-faint">exported</dt>
                  <dd class="font-mono text-fg-muted">{p().exportedAt}</dd>
                  <dt class="text-fg-faint">counts</dt>
                  <dd class="font-mono text-fg-muted">
                    {p().counts.messages} msgs · {p().counts.episodes} ep ·{" "}
                    {p().counts.turns} turns ·{" "}
                    {p().counts.pinnedFiles} pinned
                  </dd>
                </dl>

                <label class="block space-y-1">
                  <span class="text-[10px] uppercase tracking-wider text-fg-faint">
                    Target workdir (local)
                  </span>
                  <div class="flex gap-1.5">
                    <input
                      type="text"
                      placeholder="/home/me/Workspace/codeoid"
                      value={targetWorkdir()}
                      onInput={(e) => setTargetWorkdir(e.currentTarget.value)}
                      class="flex-1 rounded border border-border bg-bg px-3 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() => setPickerOpen(true)}
                      class="rounded border border-border bg-bg px-3 py-1.5 text-[12px] text-fg-muted hover:border-accent/40 hover:text-fg"
                    >
                      Browse…
                    </button>
                  </div>
                </label>

                <label class="block space-y-1">
                  <span class="text-[10px] uppercase tracking-wider text-fg-faint">
                    Name override (optional)
                  </span>
                  <input
                    type="text"
                    placeholder={p().sessionName}
                    value={nameOverride()}
                    onInput={(e) => setNameOverride(e.currentTarget.value)}
                    class="w-full rounded border border-border bg-bg px-3 py-1.5 text-[12px] text-fg outline-none focus:border-accent"
                  />
                </label>

                <Show when={p().counts.pinnedFiles > 0}>
                  <label class="flex items-center gap-2 text-[12px] text-fg">
                    <input
                      type="checkbox"
                      checked={writePinnedFiles()}
                      onChange={(e) =>
                        setWritePinnedFiles(e.currentTarget.checked)
                      }
                    />
                    <span>
                      Write {p().counts.pinnedFiles} pinned file(s) into
                      target workdir (skips when an existing file differs)
                    </span>
                  </label>
                </Show>

                <Show when={error()}>
                  <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                    {error()}
                  </div>
                </Show>

                <div class="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setParsed(null);
                      setError(null);
                    }}
                    class="rounded border border-border px-3 py-1.5 text-sm text-fg-muted hover:bg-bg-hover"
                    disabled={busy()}
                  >
                    back
                  </button>
                  <button
                    type="button"
                    onClick={runImport}
                    class="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-bg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy() || !targetWorkdir().trim()}
                  >
                    {busy() ? "importing…" : "Fork"}
                  </button>
                </div>
              </div>
            )}
          </Show>
        </div>
        <DirectoryPicker
          open={pickerOpen()}
          {...(targetWorkdir() ? { initialPath: targetWorkdir() } : {})}
          onPick={(p) => setTargetWorkdir(p)}
          onClose={() => setPickerOpen(false)}
        />
      </div>
    </Show>
  );
};

export default SessionImportModal;
