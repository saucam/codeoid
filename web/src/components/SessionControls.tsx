/**
 * Inline control bar for the focused session — sits in the session
 * header next to the metrics. Buttons are 1:1 with the slash commands
 * (so the prompt and chrome are interchangeable):
 *
 *   [interrupt]  [↻ rotate]  [mode ▾]  [model ▾]  …  [destroy]
 *
 * All actions go through the same protocol verbs the slash commands use
 * (single source of truth) and rely on the daemon's `session.info_update`
 * broadcast for state to reflect — no optimistic updates here.
 */

import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";

import {
  authIdentity,
  newRequestId,
  request,
  send,
} from "../state/connection";
import { focusedSession, removeSession } from "../state/sessions";
import { fetchModels, modelCatalog } from "../state/models";
import type { SessionMode } from "../protocol/types";
import { openExportModal } from "./SessionExportModal";

const MODE_OPTIONS: { value: SessionMode; label: string; hint: string }[] = [
  { value: "guarded", label: "guarded", hint: "Read/Grep/Glob auto; Write/Edit/Bash ask (default)" },
  { value: "interactive", label: "interactive", hint: "every tool asks first" },
  { value: "autonomous", label: "autonomous", hint: "every tool auto-approved — no prompts" },
];

const SessionControls: Component = () => {
  return (
    <Show when={focusedSession()}>
      {(s) => (
        <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
          <InterruptButton sessionId={s().id} status={s().status} />
          <RotateButton sessionId={s().id} />
          <ModePicker sessionId={s().id} current={s().mode ?? "interactive"} />
          <ModelPicker sessionId={s().id} current={s().model} />
          <ProviderPicker sessionId={s().id} current={s().providerId} />
          <ExportButton />
          <span class="ml-auto" />
          <DestroyButton sessionId={s().id} name={s().name} />
        </div>
      )}
    </Show>
  );
};

const InterruptButton: Component<{
  sessionId: string;
  status: string;
}> = (props) => {
  const armed = () =>
    props.status === "working" ||
    props.status === "thinking" ||
    props.status === "tool_running";
  return (
    <button
      type="button"
      disabled={!armed()}
      onClick={() =>
        send({
          type: "session.interrupt",
          id: newRequestId(),
          sessionId: props.sessionId,
        })
      }
      class={`rounded border px-2 py-1 font-mono uppercase tracking-wider transition disabled:cursor-not-allowed ${
        armed()
          ? "border-danger/50 text-danger hover:bg-danger/10"
          : "border-border text-fg-faint opacity-60"
      }`}
      title="Interrupt the running turn (Ctrl+X / Cmd+X)"
    >
      ⏹ interrupt
    </button>
  );
};

const ExportButton: Component = () => (
  <button
    type="button"
    onClick={openExportModal}
    class="rounded border border-border px-2 py-1 font-mono uppercase tracking-wider text-fg-muted transition hover:border-accent/40 hover:bg-accent/5 hover:text-fg"
    title="Export session as a portable bundle (/export)"
  >
    ⤓ export
  </button>
);

const RotateButton: Component<{ sessionId: string }> = (props) => (
  <button
    type="button"
    onClick={() =>
      send({
        type: "session.rotate",
        id: newRequestId(),
        sessionId: props.sessionId,
      })
    }
    class="rounded border border-border px-2 py-1 font-mono uppercase tracking-wider text-fg-muted transition hover:border-accent/40 hover:bg-accent/5 hover:text-fg"
    title="Rotate the Claude Code backing context (refresh skills/settings; memory preserved)"
  >
    ↻ rotate
  </button>
);

/** Dismiss a dropdown on Escape or a pointer-down outside its root — the menus
 * previously closed only on `onMouseLeave`, which a keyboard/touch user can't
 * trigger, so the menu stayed open over the content. Call inside a component. */
function useDismissable(
  rootRef: () => HTMLElement | undefined,
  isOpen: () => boolean,
  close: () => void,
): void {
  createEffect(() => {
    if (!isOpen()) return;
    const onDown = (e: PointerEvent) => {
      const el = rootRef();
      if (el && !el.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    });
  });
}

const ModePicker: Component<{
  sessionId: string;
  current: SessionMode;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  let rootEl: HTMLDivElement | undefined;
  useDismissable(() => rootEl, open, () => setOpen(false));
  return (
    <div class="relative" ref={rootEl}>
      <button
        type="button"
        onClick={() => setOpen(!open())}
        class="flex items-center gap-1 rounded border border-border bg-bg px-2 py-1 font-mono uppercase tracking-wider text-fg-muted hover:border-accent/40 hover:text-fg"
        title="Cycle execution mode"
      >
        mode <span class="text-fg">{props.current}</span> ▾
      </button>
      <Show when={open()}>
        <div
          class="absolute right-0 top-full z-30 mt-1 w-56 rounded border border-border bg-bg-elev shadow-xl"
          onMouseLeave={() => setOpen(false)}
        >
          <For each={MODE_OPTIONS}>
            {(opt) => (
              <button
                type="button"
                onClick={() => {
                  send({
                    type: "session.set_mode",
                    id: newRequestId(),
                    sessionId: props.sessionId,
                    mode: opt.value,
                  });
                  setOpen(false);
                }}
                class={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition hover:bg-bg-hover ${
                  opt.value === props.current ? "bg-bg-active" : ""
                }`}
              >
                <span class="font-mono text-[12px] text-fg">{opt.label}</span>
                <span class="text-[10px] text-fg-faint">{opt.hint}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

// Module-level so `/model` (bare) can open the picker programmatically.
const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
/** Open the focused session's model picker (wired to the bare `/model` slash). */
export function openModelPicker(): void {
  setModelPickerOpen(true);
  void fetchModels();
}

const ModelPicker: Component<{
  sessionId: string;
  current?: string;
}> = (props) => {
  const open = modelPickerOpen;
  const setOpen = setModelPickerOpen;
  const [custom, setCustom] = createSignal("");
  let rootEl: HTMLDivElement | undefined;
  useDismissable(() => rootEl, open, () => setOpen(false));
  return (
    <div class="relative" ref={rootEl}>
      <button
        type="button"
        onClick={() => {
          const next = !open();
          setOpen(next);
          if (next) void fetchModels();
        }}
        class="flex items-center gap-1 rounded border border-border bg-bg px-2 py-1 font-mono uppercase tracking-wider text-fg-muted hover:border-accent/40 hover:text-fg"
        title="Switch model (next turn applies)"
      >
        model <span class="text-fg">{props.current ?? "default"}</span> ▾
      </button>
      <Show when={open()}>
        <div
          class="absolute right-0 top-full z-30 mt-1 w-56 rounded border border-border bg-bg-elev shadow-xl"
          onMouseLeave={() => setOpen(false)}
        >
          <Show
            when={modelCatalog().length > 0}
            fallback={
              <div class="px-3 py-2 text-[11px] text-fg-faint">Loading models…</div>
            }
          >
            <For each={modelCatalog()}>
              {(opt) => (
                <button
                  type="button"
                  onClick={() => {
                    send({
                      type: "session.set_model",
                      id: newRequestId(),
                      sessionId: props.sessionId,
                      model: opt.value,
                    });
                    setOpen(false);
                  }}
                  class={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition hover:bg-bg-hover ${
                    opt.value === props.current ? "bg-bg-active text-fg" : "text-fg-muted"
                  }`}
                  title={opt.description ?? opt.value}
                >
                  <span class="flex flex-col">
                    <span class="text-fg">{opt.displayName}{opt.isDefault ? " ·default" : ""}</span>
                    <span class="font-mono text-[10px] text-fg-faint">{opt.value}</span>
                  </span>
                  <Show when={opt.value === props.current}>
                    <span class="text-accent">●</span>
                  </Show>
                </button>
              )}
            </For>
          </Show>
          <div class="border-t border-border p-2">
            <input
              type="text"
              placeholder="custom model id"
              value={custom()}
              onInput={(e) => setCustom(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && custom().trim()) {
                  send({
                    type: "session.set_model",
                    id: newRequestId(),
                    sessionId: props.sessionId,
                    model: custom().trim(),
                  });
                  setOpen(false);
                  setCustom("");
                }
              }}
              class="w-full rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg outline-none focus:border-accent"
            />
          </div>
        </div>
      </Show>
    </div>
  );
};

/**
 * Backend switcher (`session.set_provider`) — visual counterpart of the
 * `/provider <id>` slash. Hidden on single-backend daemons (and legacy
 * daemons that don't advertise providers). Uses `request()` so the
 * daemon's rejections (mid-turn switch, unknown id) surface inline
 * instead of vanishing.
 */
const ProviderPicker: Component<{
  sessionId: string;
  current?: string;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let rootEl: HTMLDivElement | undefined;
  useDismissable(() => rootEl, open, () => setOpen(false));
  const providers = () => authIdentity()?.providers ?? [];
  const current = () => props.current ?? providers()[0] ?? "claude";
  return (
    <Show when={providers().length > 1}>
      <div class="relative" ref={rootEl}>
        <button
          type="button"
          onClick={() => {
            setOpen(!open());
            setError(null);
          }}
          class="flex items-center gap-1 rounded border border-border bg-bg px-2 py-1 font-mono uppercase tracking-wider text-fg-muted hover:border-accent/40 hover:text-fg"
          title="Switch this session's backend (/provider <id>)"
        >
          backend <span class="text-fg">{current()}</span> ▾
        </button>
        <Show when={open()}>
          <div class="absolute right-0 top-full z-30 mt-1 w-64 rounded border border-border bg-bg-elev shadow-xl">
            <For each={providers()}>
              {(id) => (
                <button
                  type="button"
                  onClick={() => {
                    if (id === current()) {
                      setOpen(false);
                      return;
                    }
                    // A stale rejection from a previous attempt would read as
                    // if it belonged to THIS click — clear before dispatch.
                    setError(null);
                    request({
                      type: "session.set_provider",
                      id: newRequestId(),
                      sessionId: props.sessionId,
                      providerId: id,
                    })
                      .then(() => setOpen(false))
                      .catch((e) =>
                        setError(e instanceof Error ? e.message : String(e)),
                      );
                  }}
                  class={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition hover:bg-bg-hover ${
                    id === current() ? "bg-bg-active text-fg" : "text-fg-muted"
                  }`}
                >
                  <span class="font-mono">{id}</span>
                  <Show when={id === current()}>
                    <span class="text-accent">●</span>
                  </Show>
                </button>
              )}
            </For>
            <Show when={error()}>
              <div class="border-t border-danger/40 px-3 py-1.5 text-[11px] text-danger">
                {error()}
              </div>
            </Show>
            <div class="border-t border-border px-3 py-1.5 text-[10px] text-fg-faint">
              Keeps the session + transcript. The new backend continues from a
              carried transcript; the model resets to its default.
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
};

const DestroyButton: Component<{
  sessionId: string;
  name: string;
}> = (props) => {
  const [confirming, setConfirming] = createSignal(false);
  return (
    <Show
      when={confirming()}
      fallback={
        <button
          type="button"
          onClick={() => setConfirming(true)}
          class="rounded border border-border px-2 py-1 font-mono uppercase tracking-wider text-fg-faint transition hover:border-danger/40 hover:text-danger"
          title="Destroy this session"
        >
          destroy
        </button>
      }
    >
      <span class="flex items-center gap-1">
        <span class="text-danger">delete "{props.name}"?</span>
        <button
          type="button"
          onClick={() => {
            send({
              type: "session.destroy",
              id: newRequestId(),
              sessionId: props.sessionId,
            });
            removeSession(props.sessionId);
            setConfirming(false);
          }}
          class="rounded bg-danger px-2 py-1 font-mono uppercase tracking-wider text-bg hover:bg-danger/80"
        >
          yes
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          class="rounded border border-border px-2 py-1 font-mono uppercase tracking-wider text-fg-muted hover:bg-bg-hover"
        >
          cancel
        </button>
      </span>
    </Show>
  );
};

export default SessionControls;
