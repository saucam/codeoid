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
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { newRequestId, refreshSessions, send } from "../state/connection";
import { focusSession } from "../state/sessions";

const [openSignal, setOpenSignal] = createSignal(false);

/** External hook so the empty-state CTA / sidebar button can open it. */
export function openNewSessionModal(): void {
  setOpenSignal(true);
}

const NewSessionModal: Component = () => {
  const [name, setName] = createSignal("");
  const [workdir, setWorkdir] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  let nameRef: HTMLInputElement | undefined;

  // Global Cmd/Ctrl+N opens; Esc closes.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setOpenSignal(true);
      } else if (e.key === "Escape" && openSignal()) {
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
        requestAnimationFrame(() => nameRef?.focus());
      }
    }),
  );

  async function submit(ev: Event): Promise<void> {
    ev.preventDefault();
    if (busy()) return;
    const n = name().trim();
    if (!n) {
      setError("name required");
      return;
    }
    const wd = workdir().trim() || ".";
    setBusy(true);
    setError(null);
    try {
      send({
        type: "session.create",
        id: newRequestId(),
        name: n,
        workdir: wd,
      });
      // Give the daemon a beat to spin up the agent identity, then
      // refresh the list to capture the new id.
      setTimeout(async () => {
        const list = await refreshSessions().catch(() => []);
        const created = list.find((s) => s.name === n);
        if (created) focusSession(created.id);
        setBusy(false);
        setOpenSignal(false);
        setName("");
        setWorkdir("");
      }, 450);
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
              New session
            </h2>
            <p class="text-xs text-fg-muted">
              A session is one Claude conversation rooted at a workdir. The
              daemon registers a per-session ZeroID agent identity automatically.
            </p>
          </header>

          <label class="block space-y-1.5">
            <span class="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
              Name
            </span>
            <input
              ref={nameRef}
              type="text"
              autocomplete="off"
              spellcheck={false}
              placeholder="e.g. shield-refactor"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              class="w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
              disabled={busy()}
              required
            />
          </label>

          <label class="block space-y-1.5">
            <span class="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
              Workdir
            </span>
            <input
              type="text"
              autocomplete="off"
              spellcheck={false}
              placeholder="."
              value={workdir()}
              onInput={(e) => setWorkdir(e.currentTarget.value)}
              class="w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
              disabled={busy()}
            />
            <p class="text-[10px] text-fg-faint">
              Path on the daemon host. Defaults to the daemon's CWD when blank.
            </p>
          </label>

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
              disabled={busy() || !name().trim()}
            >
              {busy() ? "creating…" : "create"}
            </button>
          </div>
        </form>
      </div>
    </Show>
  );
};

export default NewSessionModal;
