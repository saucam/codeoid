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

import { Component, For, Show, createSignal } from "solid-js";

import {
  newRequestId,
  send,
} from "../state/connection";
import { focusedSession, removeSession } from "../state/sessions";
import type { SessionMode } from "../protocol/types";
import { openExportModal } from "./SessionExportModal";

const MODE_OPTIONS: { value: SessionMode; label: string; hint: string }[] = [
  { value: "interactive", label: "interactive", hint: "every tool asks first" },
  { value: "auto-allow", label: "auto-allow", hint: "Read/Grep/Glob auto; Write/Bash ask" },
  { value: "autonomous", label: "autonomous", hint: "every tool auto-approved" },
];

// Common Anthropic models we surface as quick picks. ZeroID-side
// configuration can extend this; for v1 keep the list short and obvious.
const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: "opus", label: "Opus (alias)" },
  { id: "sonnet", label: "Sonnet (alias)" },
  { id: "haiku", label: "Haiku (alias)" },
  { id: "claude-opus-4-7", label: "claude-opus-4-7" },
  { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
  { id: "claude-haiku-4-5", label: "claude-haiku-4-5" },
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

const ModePicker: Component<{
  sessionId: string;
  current: SessionMode;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="relative">
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

const ModelPicker: Component<{
  sessionId: string;
  current?: string;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [custom, setCustom] = createSignal("");
  return (
    <div class="relative">
      <button
        type="button"
        onClick={() => setOpen(!open())}
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
          <For each={MODEL_OPTIONS}>
            {(opt) => (
              <button
                type="button"
                onClick={() => {
                  send({
                    type: "session.set_model",
                    id: newRequestId(),
                    sessionId: props.sessionId,
                    model: opt.id,
                  });
                  setOpen(false);
                }}
                class={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition hover:bg-bg-hover ${
                  opt.id === props.current ? "bg-bg-active text-fg" : "text-fg-muted"
                }`}
              >
                <span class="font-mono">{opt.label}</span>
                <Show when={opt.id === props.current}>
                  <span class="text-accent">●</span>
                </Show>
              </button>
            )}
          </For>
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
