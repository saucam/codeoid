/**
 * New-session creation modal. Triggered by:
 *   - Sidebar "+ new session" button
 *   - Empty-state CTA in the center pane
 *   - Cmd/Ctrl+N anywhere
 *
 * Sends `session.create` and waits for the daemon's `session.list.result`
 * follow-up (or info_update) to populate the new entry. We don't
 * optimistically insert — daemon is canonical.
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

import { authIdentity, newRequestId, refreshSessions, request } from "../state/connection";
import { fetchPacks, packsState } from "../state/packs";
import { runPipeline } from "../state/pipelines";
import { focusSession, mergeSession, sessionList } from "../state/sessions";
import type { PackWire, SessionInfo } from "../protocol/types";
import DirectoryPicker from "./files/DirectoryPicker";

/** The modal serves two flows from one dialog (docs/pipeline-run.md): a plain
 *  session, or a governed pipeline run (adds a goal box + requires a pack). */
type Mode = "session" | "pipeline";

const [openSignal, setOpenSignal] = createSignal(false);
const [mode, setMode] = createSignal<Mode>("session");
const [goalPrefill, setGoalPrefill] = createSignal("");

/** External hook so the empty-state CTA / sidebar button can open it. */
export function openNewSessionModal(): void {
  setMode("session");
  setOpenSignal(true);
}

/** Open the SAME dialog in pipeline mode: a goal / feature box + a required pack.
 *  Submitting starts a governed run and focuses its bound session (the run shows
 *  up as a normal chat). Wired to `/pipeline` and the Pack Browser's Run action. */
export function openPipelineModal(goal?: string): void {
  setMode("pipeline");
  setGoalPrefill(goal ?? "");
  setOpenSignal(true);
}

const NewSessionModal: Component = () => {
  const [name, setName] = createSignal("");
  const [workdir, setWorkdir] = createSignal("");
  // Pipeline mode only: the feature/goal that seeds the run's spec phase.
  const [goal, setGoal] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  // "" = daemon default (first advertised provider).
  const [providerId, setProviderId] = createSignal("");
  // Ambient pack activation (docs/pack-loading.md): "" = freestyle (no pack).
  const [packId, setPackId] = createSignal("");
  // Capability role declared by the chosen pack; "" = no role restriction.
  const [packRole, setPackRole] = createSignal("");

  // Backends this daemon registered (auth.ok `providers`, default first).
  // Older daemons don't advertise — hide the picker, sessions stay claude.
  const providers = createMemo<string[]>(() => authIdentity()?.providers ?? []);

  // Installed packs from the daemon-canonical pack state. Empty when none are
  // installed OR when the fetch was rejected (e.g. the session token lacks
  // `pipeline:read`) — either way we degrade to a subtle note and never block
  // freestyle session creation.
  const installedPacks = createMemo<PackWire[]>(() => packsState().installed ?? []);
  const selectedPack = createMemo<PackWire | undefined>(() =>
    installedPacks().find((p) => p.id === packId()),
  );
  // Roles the chosen pack declares (populate the role <select>).
  const packRoles = createMemo<string[]>(() => selectedPack()?.roles ?? []);

  // Pipeline runs need an ACTIVE (registered) pack — an inactive/broken pack
  // can't back a run; ambient session mode can pick any installed pack.
  const packOptions = createMemo<PackWire[]>(() =>
    mode() === "pipeline" ? installedPacks().filter((p) => p.active && !p.error) : installedPacks(),
  );

  // Changing the pack invalidates any previously-picked role. `defer` so this
  // doesn't clobber the initial empty state on first run.
  createEffect(on(packId, () => setPackRole(""), { defer: true }));

  // Pipeline mode requires a pack, so default the picker to the selected/first
  // active pack once the (async) pack list lands — otherwise the <select> shows
  // a pack visually while packId() is still "" (and Start stays disabled).
  createEffect(() => {
    if (mode() !== "pipeline" || !openSignal() || packId()) return;
    const opts = packOptions();
    const def = opts.find((p) => p.selected)?.id ?? opts[0]?.id;
    if (def) setPackId(def);
  });

  let nameRef: HTMLInputElement | undefined;

  // Recent workdirs from past sessions, deduped and sorted by frequency.
  // Click a chip to fill the input — quick path for "I want another
  // session in the same repo" without retyping the path.
  const recentWorkdirs = createMemo<string[]>(() => {
    const counts = new Map<string, number>();
    for (const s of sessionList()) {
      if (!s.workdir) continue;
      counts.set(s.workdir, (counts.get(s.workdir) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([wd]) => wd)
      .slice(0, 8);
  });

  // Global Cmd/Ctrl+N opens; Esc closes.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setOpenSignal(true);
      } else if (e.key === "Escape" && openSignal() && !pickerOpen()) {
        // When the directory picker is open, let ITS Esc handler close only the
        // picker — don't also tear down the modal and lose the typed name/workdir.
        e.preventDefault();
        setOpenSignal(false);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // Reset state on close, focus name input on open.
  createEffect(
    on(openSignal, (v) => {
      if (v) {
        setBusy(false);
        setError(null);
        if (mode() === "pipeline") setGoal(goalPrefill());
        // Refresh the pack list every open. fetchPacks swallows its own
        // errors (it sets pack-state.error rather than rejecting), but guard
        // anyway so a rejected read can never break opening the modal.
        void fetchPacks().catch(() => {});
        requestAnimationFrame(() => nameRef?.focus());
      }
    }),
  );

  async function submit(ev: Event): Promise<void> {
    ev.preventDefault();
    if (busy()) return;
    const n = name().trim();

    // ── Pipeline run ──────────────────────────────────────────────────────────
    if (mode() === "pipeline") {
      const g = goal().trim();
      if (!packId()) {
        setError("pick a pack to run");
        return;
      }
      if (!g) {
        setError("a goal / feature description is required");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        // runPipeline creates the run, focuses its bound session (the run shows
        // up as a normal chat), and drives it — catching its own errors into
        // pipeline state, so we can close as soon as it returns.
        await runPipeline({
          pack: packId(),
          goal: g,
          workdir: workdir().trim() || ".",
          ...(n ? { name: n } : {}),
          ...(providerId() ? { provider: providerId() } : {}),
        });
        setBusy(false);
        setOpenSignal(false);
        setName("");
        setWorkdir("");
        setGoal("");
        setProviderId("");
        setPackId("");
        setPackRole("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
      return;
    }

    // ── Plain session ─────────────────────────────────────────────────────────
    if (!n) {
      setError("name required");
      return;
    }
    const wd = workdir().trim() || ".";
    setBusy(true);
    setError(null);
    try {
      // request() (not fire-and-forget send + a 450ms guess): the daemon acks
      // with the created SessionInfo, so a rejection (bad scope/workdir) surfaces
      // as an error instead of silently "succeeding", and we focus the exact new
      // id rather than name-matching (which picked the wrong one on duplicates).
      const data = (await request({
        type: "session.create",
        id: newRequestId(),
        name: n,
        workdir: wd,
        ...(providerId() ? { providerId: providerId() } : {}),
        ...(packId() ? { pack: packId() } : {}),
        ...(packRole() ? { packRole: packRole() } : {}),
      })) as SessionInfo | undefined;
      if (data && typeof data === "object" && "id" in data) {
        mergeSession(data);
        focusSession(data.id);
      } else {
        // Older daemon without a data payload — fall back to a list refresh.
        const list = await refreshSessions().catch(() => []);
        const created = list.find((s) => s.name === n);
        if (created) focusSession(created.id);
      }
      setBusy(false);
      setOpenSignal(false);
      setName("");
      setWorkdir("");
      setProviderId("");
      setPackId("");
      setPackRole("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Show when={openSignal()}>
      <div
        class="fixed inset-0 z-40 flex items-start justify-center bg-bg/70 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpenSignal(false);
        }}
      >
        <form
          onSubmit={submit}
          class="mt-[16vh] w-full max-w-md space-y-4 rounded-lg border border-border bg-bg-elev p-5 shadow-2xl"
        >
          <header class="space-y-1">
            <h2 class="text-base font-semibold tracking-tight text-fg">
              {mode() === "pipeline" ? "Start a pipeline run" : "New session"}
            </h2>
            <p class="text-xs text-fg-muted">
              {mode() === "pipeline"
                ? "Run an installed pack against a goal. It creates a session, auto-advances through the pack's phases, and halts at each boundary for you to Approve / Revise / Reject."
                : "A session is one Claude conversation rooted at a workdir. The daemon registers a per-session ZeroID agent identity automatically."}
            </p>
          </header>

          <label class="block space-y-1.5">
            <span class="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
              Name{mode() === "pipeline" ? " (optional)" : ""}
            </span>
            <input
              ref={nameRef}
              type="text"
              autocomplete="off"
              spellcheck={false}
              placeholder={mode() === "pipeline" ? "defaults to the goal" : "e.g. shield-refactor"}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              class="w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
              disabled={busy()}
              required={mode() === "session"}
            />
          </label>

          <label class="block space-y-1.5">
            <span class="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
              Workdir
            </span>
            <div class="flex gap-1.5">
              <input
                type="text"
                autocomplete="off"
                spellcheck={false}
                placeholder="."
                value={workdir()}
                onInput={(e) => setWorkdir(e.currentTarget.value)}
                class="flex-1 rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
                disabled={busy()}
              />
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                class="rounded border border-border bg-bg px-3 py-1.5 text-sm text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy()}
                title="Browse the daemon host's filesystem"
              >
                Browse…
              </button>
            </div>
            <Show when={recentWorkdirs().length > 0}>
              <div class="space-y-1">
                <span class="text-[10px] uppercase tracking-wider text-fg-faint">
                  Recent
                </span>
                <div class="flex flex-wrap gap-1">
                  <For each={recentWorkdirs()}>
                    {(wd) => (
                      <button
                        type="button"
                        onClick={() => setWorkdir(wd)}
                        class={`max-w-full truncate rounded border px-1.5 py-0.5 font-mono text-[11px] transition ${
                          workdir() === wd
                            ? "border-accent/60 bg-accent/10 text-accent"
                            : "border-border bg-bg text-fg-muted hover:border-accent/40 hover:text-fg"
                        }`}
                        title={wd}
                      >
                        {compactPath(wd)}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <p class="text-[10px] text-fg-faint">
              Path on the daemon host. Defaults to the daemon's CWD when blank.
            </p>
          </label>

          <Show when={mode() === "pipeline"}>
            <label class="block space-y-1.5">
              <span class="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
                Goal / feature
              </span>
              <textarea
                rows={4}
                placeholder="Describe the feature to build — this seeds the run's spec phase…"
                value={goal()}
                onInput={(e) => setGoal(e.currentTarget.value)}
                class="w-full resize-y rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm leading-6 text-fg outline-none focus:border-accent"
                disabled={busy()}
                aria-label="Goal"
              />
            </label>
          </Show>

          <Show when={providers().length > 1}>
            <div class="block space-y-1.5">
              <span class="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
                Backend
              </span>
              <div class="flex flex-wrap gap-1" role="radiogroup" aria-label="Backend">
                <For each={providers()}>
                  {(id, i) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={providerId() === id || (!providerId() && i() === 0)}
                      onClick={() => setProviderId(i() === 0 ? "" : id)}
                      class={`rounded border px-2 py-0.5 font-mono text-[12px] transition ${
                        providerId() === id || (!providerId() && i() === 0)
                          ? "border-accent/60 bg-accent/10 text-accent"
                          : "border-border bg-bg text-fg-muted hover:border-accent/40 hover:text-fg"
                      }`}
                      disabled={busy()}
                    >
                      {id}
                      {i() === 0 ? " (default)" : ""}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Pack. Session mode: OPTIONAL ambient activation (constitution +
              skills/subagents + an optional capability role). Pipeline mode:
              REQUIRED — the run's phases come from the pack, and each phase's
              role is applied per-phase (so no role picker here). */}
          <div class="block space-y-1.5">
            <span class="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
              Pack{mode() === "pipeline" ? " (required)" : ""}
            </span>
            <Show
              when={packOptions().length > 0}
              fallback={
                <p class="text-[10px] text-fg-faint">
                  {mode() === "pipeline"
                    ? "No active packs — install + activate one via /packs to run a pipeline."
                    : "No packs installed — this session runs freestyle. Install one via /packs."}
                </p>
              }
            >
              <select
                value={packId()}
                onChange={(e) => setPackId(e.currentTarget.value)}
                class="w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy()}
                aria-label="Pack"
              >
                <Show when={mode() === "session"}>
                  <option value="">None (freestyle)</option>
                </Show>
                <For each={packOptions()}>
                  {(p) => <option value={p.id}>{p.name}</option>}
                </For>
              </select>
              <Show when={mode() === "session" && selectedPack() && packRoles().length > 0}>
                <label class="block space-y-1">
                  <span class="text-[10px] uppercase tracking-wider text-fg-faint">
                    Role (optional)
                  </span>
                  <select
                    value={packRole()}
                    onChange={(e) => setPackRole(e.currentTarget.value)}
                    class="w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy()}
                    aria-label="Pack role"
                  >
                    <option value="">Default (no role restriction)</option>
                    <For each={packRoles()}>
                      {(r) => <option value={r}>{r}</option>}
                    </For>
                  </select>
                </label>
              </Show>
            </Show>
          </div>

          <Show when={error()}>
            <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error()}
            </div>
          </Show>

          <div class="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setOpenSignal(false)}
              class="rounded border border-border px-3 py-1.5 text-sm text-fg-muted hover:bg-bg-hover"
              disabled={busy()}
            >
              cancel
            </button>
            <button
              type="submit"
              class="ml-auto rounded bg-accent px-3 py-1.5 text-sm font-semibold text-bg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy() || (mode() === "pipeline" ? !packId() || !goal().trim() : !name().trim())}
            >
              {busy()
                ? mode() === "pipeline"
                  ? "starting…"
                  : "creating…"
                : mode() === "pipeline"
                  ? "start run"
                  : "create"}
            </button>
          </div>
        </form>
        <DirectoryPicker
          open={pickerOpen()}
          {...(workdir() ? { initialPath: workdir() } : {})}
          onPick={(p) => setWorkdir(p)}
          onClose={() => setPickerOpen(false)}
        />
      </div>
    </Show>
  );
};

/** Tighten "/home/ydatta/Workspace/foo" → "~/Workspace/foo". */
function compactPath(p: string): string {
  // The daemon's home is the user this client typically runs against —
  // best-effort string replace; if it doesn't match we render the path
  // verbatim. The full path is always available on hover via title.
  return p.replace(/^\/home\/[^/]+/, "~");
}

export default NewSessionModal;
