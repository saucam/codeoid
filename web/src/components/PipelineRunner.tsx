/**
 * Pipeline Runner — the user-facing way to RUN an installed pack
 * (docs/pipeline-run.md). Opened by the `/pipeline` slash command (and a
 * per-pack Run action) via the exported `openPipelineRunner(goal?)` signal
 * (mirrors `openPackBrowser`).
 *
 * Two states, both driven by state/pipelines.ts:
 *   • Start panel  — pick an installed + active pack, a workdir, and a goal;
 *     Start → runPipeline (create → advance, fire-and-forget).
 *   • Run view     — the phase rail (per-phase status + role, current/halted
 *     highlighted); at a gate halt an Approve / Revise / Reject card; a
 *     terminal status when the run finishes; a subtle "running…" indicator
 *     while a phase is in flight (the poll loop reflects progress — there is
 *     no push for pipelines).
 *
 * This component only renders + dispatches; the round-trips (and the poll
 * loop) live in state/pipelines.ts. `PipelineRunnerView` is the pure
 * presentational body, exported for a render test (mirrors PackBrowserView).
 */

import {
  Component,
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { fetchPacks, packsState } from "../state/packs";
import {
  abort,
  approve,
  pipelinesState,
  reject,
  revise,
  runPipeline,
} from "../state/pipelines";
import type { PackWire, PipelinePhaseWire, PipelineWire } from "../protocol/types";

const [openSignal, setOpenSignal] = createSignal(false);
const [goalPrefill, setGoalPrefill] = createSignal("");

/** Open the pipeline runner, optionally prefilling the goal. Refreshes the pack
 *  list so the Start panel's pack picker is current. Wired to `/pipeline`. */
export function openPipelineRunner(goal?: string): void {
  setGoalPrefill(goal ?? "");
  setOpenSignal(true);
  void fetchPacks();
}

export function closePipelineRunner(): void {
  setOpenSignal(false);
}

const PipelineRunner: Component = () => {
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

  // Only installed packs that are registered into the live pipeline manager
  // (active) — an inactive/broken pack can't back a run.
  const runnablePacks = createMemo(() =>
    packsState().installed.filter((p) => p.active && !p.error),
  );

  return (
    <Show when={openSignal()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-end bg-bg/60 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpenSignal(false);
        }}
      >
        <aside class="flex h-full w-full max-w-3xl flex-col border-l border-border bg-bg-elev shadow-2xl">
          <header class="flex items-center gap-3 border-b border-border px-4 py-3">
            <h2 class="text-base font-semibold tracking-tight text-fg">
              Pipeline Run
            </h2>
            <span class="font-mono text-[11px] text-fg-faint">
              governed SDLC — spec → ship
            </span>
            <span class="ml-auto flex items-center gap-2">
              <Show when={pipelinesState().pipeline}>
                <button
                  type="button"
                  onClick={() => abort()}
                  class="rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:border-danger/40 hover:text-danger disabled:opacity-50"
                  disabled={pipelinesState().busy}
                  title="Abort this run"
                >
                  Abort
                </button>
              </Show>
              <button
                type="button"
                onClick={() => setOpenSignal(false)}
                class="text-fg-faint hover:text-fg"
                title="Close (Esc)"
              >
                ✕
              </button>
            </span>
          </header>

          <Show when={pipelinesState().error}>
            <div class="border-b border-danger/40 bg-danger/10 px-4 py-2 text-[12px] text-danger">
              {pipelinesState().error}
            </div>
          </Show>

          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <PipelineRunnerView
              pipeline={pipelinesState().pipeline}
              packs={runnablePacks()}
              goalPrefill={goalPrefill()}
              busy={pipelinesState().busy}
              loading={pipelinesState().loading}
              onRun={(args) => void runPipeline(args)}
              onApprove={(reqId, value) => approve(reqId, value)}
              onReject={(reqId, value) => reject(reqId, value)}
              onRevise={(reqId, feedback) => revise(reqId, feedback)}
            />
          </div>

          <footer class="border-t border-border px-4 py-2 text-[11px] text-fg-faint">
            A run advances on its own, pausing at each gate for you to Approve,
            Revise, or Reject. Phases run under their pack role (a reviewer can't
            write).
          </footer>
        </aside>
      </div>
    </Show>
  );
};

// ── Presentational body ───────────────────────────────────────────────────────

export interface PipelineRunnerViewProps {
  /** The active run, or null → show the Start panel. */
  pipeline: PipelineWire | null;
  /** Installed + active packs the Start panel picks from. */
  packs: PackWire[];
  goalPrefill?: string;
  /** A create/steer is in flight — disable actions. */
  busy?: boolean;
  loading?: boolean;
  onRun: (args: { pack: string; goal: string; workdir: string }) => void;
  onApprove: (requestId: string, value?: string) => void;
  onReject: (requestId: string, value?: string) => void;
  onRevise: (requestId: string, feedback: string) => void;
}

/** Pure body — no daemon calls. Exported for a render test. */
export const PipelineRunnerView: Component<PipelineRunnerViewProps> = (props) => (
  <Show
    when={props.pipeline}
    fallback={
      <StartPanel
        packs={props.packs}
        goalPrefill={props.goalPrefill}
        busy={props.busy || props.loading}
        onRun={props.onRun}
      />
    }
  >
    {(pipeline) => (
      <RunView
        pipeline={pipeline()}
        busy={props.busy}
        onApprove={props.onApprove}
        onReject={props.onReject}
        onRevise={props.onRevise}
      />
    )}
  </Show>
);

// ── Start panel ────────────────────────────────────────────────────────────────

const inputClass =
  "w-full rounded border border-border bg-bg px-2.5 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent disabled:opacity-50";

const labelClass =
  "text-[10px] font-semibold uppercase tracking-wider text-fg-faint";

const StartPanel: Component<{
  packs: PackWire[];
  goalPrefill?: string;
  busy?: boolean;
  onRun: (args: { pack: string; goal: string; workdir: string }) => void;
}> = (props) => {
  // The chosen pack, or "" until the user picks. `effectivePack` resolves the
  // real selection — falling back to the default (selected) pack, else the
  // first — so a pack list that loads AFTER first paint still yields a valid
  // choice without a stale empty signal.
  const [pack, setPack] = createSignal("");
  const effectivePack = () => {
    const cur = pack();
    if (cur && props.packs.some((p) => p.id === cur)) return cur;
    return props.packs.find((p) => p.selected)?.id ?? props.packs[0]?.id ?? "";
  };
  const [workdir, setWorkdir] = createSignal("");
  const [goal, setGoal] = createSignal(props.goalPrefill ?? "");

  const canStart = () =>
    !props.busy && !!effectivePack() && !!workdir().trim() && !!goal().trim();

  const submit = (e: Event) => {
    e.preventDefault();
    if (!canStart()) return;
    props.onRun({
      pack: effectivePack(),
      goal: goal().trim(),
      workdir: workdir().trim(),
    });
  };

  return (
    <form onSubmit={submit} class="flex flex-col gap-4">
      <div>
        <h3 class="text-[15px] font-semibold text-fg">Start a run</h3>
        <p class="mt-0.5 text-[12px] text-fg-muted">
          Pick an installed pack, a working directory, and a feature goal. The
          run seeds its spec phase from the goal and auto-advances through the
          pack's phases.
        </p>
      </div>

      <Show
        when={props.packs.length > 0}
        fallback={
          <div class="rounded border border-warn/40 bg-warn/10 px-3 py-3 text-[12px] text-warn">
            No active packs. Install and activate one via{" "}
            <code class="font-mono">/packs</code> first.
          </div>
        }
      >
        <label class="flex flex-col gap-1">
          <span class={labelClass}>Pack</span>
          <select
            value={effectivePack()}
            onChange={(e) => setPack(e.currentTarget.value)}
            class={inputClass}
            disabled={props.busy}
            aria-label="Pack"
          >
            <For each={props.packs}>
              {(p) => (
                <option value={p.id}>
                  {p.name} (v{p.version})
                </option>
              )}
            </For>
          </select>
        </label>

        <label class="flex flex-col gap-1">
          <span class={labelClass}>Workdir</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck={false}
            placeholder="/abs/path/to/repo"
            value={workdir()}
            onInput={(e) => setWorkdir(e.currentTarget.value)}
            class={inputClass}
            disabled={props.busy}
            aria-label="Workdir"
          />
        </label>

        <label class="flex flex-col gap-1">
          <span class={labelClass}>Goal</span>
          <textarea
            rows={5}
            placeholder="Describe the feature to build…"
            value={goal()}
            onInput={(e) => setGoal(e.currentTarget.value)}
            class={`${inputClass} resize-y leading-6`}
            disabled={props.busy}
            aria-label="Goal"
          />
        </label>

        <div>
          <button
            type="submit"
            class="rounded bg-accent px-4 py-1.5 text-[12px] font-semibold text-bg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canStart()}
          >
            Start
          </button>
        </div>
      </Show>
    </form>
  );
};

// ── Run view ─────────────────────────────────────────────────────────────────

const TERMINAL: readonly PipelineWire["status"][] = [
  "merged",
  "done",
  "failed",
  "abandoned",
];

function statusClass(status: PipelinePhaseWire["status"]): string {
  switch (status) {
    case "running":
      return "border-accent/50 bg-accent/10 text-accent";
    case "halted":
      return "border-warn/50 bg-warn/10 text-warn";
    case "passed":
      return "border-success/50 bg-success/10 text-success";
    case "failed":
      return "border-danger/50 bg-danger/10 text-danger";
    case "pending":
    default:
      return "border-border bg-bg/40 text-fg-muted";
  }
}

function pipelineStatusClass(status: PipelineWire["status"]): string {
  switch (status) {
    case "running":
      return "border-accent/50 bg-accent/10 text-accent";
    case "halted":
      return "border-warn/50 bg-warn/10 text-warn";
    case "merged":
    case "done":
      return "border-success/50 bg-success/10 text-success";
    case "failed":
    case "abandoned":
      return "border-danger/50 bg-danger/10 text-danger";
    case "draft":
    default:
      return "border-border bg-bg/40 text-fg-muted";
  }
}

const RunView: Component<{
  pipeline: PipelineWire;
  busy?: boolean;
  onApprove: (requestId: string, value?: string) => void;
  onReject: (requestId: string, value?: string) => void;
  onRevise: (requestId: string, feedback: string) => void;
}> = (props) => {
  const p = () => props.pipeline;
  const terminal = () => TERMINAL.includes(p().status);
  // The gate halt awaiting a decision (carries the requestId to echo back).
  const halted = () =>
    p().phases.find((ph) => ph.status === "halted" && !!ph.requestId);
  const isRunning = () => p().status === "running" || (!!props.busy && !terminal());

  return (
    <div class="flex flex-col gap-4">
      {/* Header: name + overall status. */}
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-mono text-[13px] text-fg">{p().name}</span>
        <span
          class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${pipelineStatusClass(
            p().status,
          )}`}
        >
          {p().status}
        </span>
        <Show when={isRunning()}>
          <span
            class="ml-auto flex items-center gap-1.5 text-[11px] text-accent"
            aria-label="running"
          >
            <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            running…
          </span>
        </Show>
      </div>

      <Show when={p().spec}>
        <p class="rounded border border-border bg-bg/30 px-3 py-2 text-[12px] text-fg-muted">
          {p().spec}
        </p>
      </Show>

      {/* Phase rail. */}
      <div class="flex flex-wrap items-center gap-1.5">
        <For each={p().phases}>
          {(ph, i) => (
            <>
              <Show when={i() > 0}>
                <span class="text-fg-faint" aria-hidden="true">
                  →
                </span>
              </Show>
              <span
                class={`inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[11px] ${statusClass(
                  ph.status,
                )} ${i() === p().cursor ? "ring-1 ring-accent/40" : ""}`}
                title={ph.summary ?? ph.reason ?? ph.status}
              >
                {ph.id}
                <Show when={ph.role}>
                  <span
                    class="rounded bg-accent/20 px-1 py-0.5 text-[9px] uppercase tracking-wider text-accent"
                    title={`role: ${ph.role}`}
                  >
                    {ph.role}
                  </span>
                </Show>
                <span class="text-[9px] uppercase tracking-wider opacity-80">
                  {ph.status}
                </span>
              </span>
            </>
          )}
        </For>
      </div>

      {/* Gate halt — Approve / Revise / Reject. */}
      <Show when={p().status === "halted" && halted()}>
        {(phase) => (
          <HaltCard
            phase={phase()}
            busy={props.busy}
            onApprove={props.onApprove}
            onReject={props.onReject}
            onRevise={props.onRevise}
          />
        )}
      </Show>

      {/* Terminal outcome. */}
      <Show when={terminal()}>
        <div
          class={`rounded border px-3 py-3 text-[12px] ${pipelineStatusClass(
            p().status,
          )}`}
        >
          Run {p().status}.
          <Show when={p().phases.find((ph) => ph.status === "failed")?.reason}>
            {(reason) => (
              <span class="mt-1 block font-mono text-[11px] opacity-90">
                {reason()}
              </span>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
};

const HaltCard: Component<{
  phase: PipelinePhaseWire;
  busy?: boolean;
  onApprove: (requestId: string, value?: string) => void;
  onReject: (requestId: string, value?: string) => void;
  onRevise: (requestId: string, feedback: string) => void;
}> = (props) => {
  const [value, setValue] = createSignal("");
  const [feedback, setFeedback] = createSignal("");
  const reqId = () => props.phase.requestId!;
  const btn =
    "rounded border px-3 py-1.5 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div class="rounded border border-warn/40 bg-warn/5 px-3 py-3">
      <div class="flex items-center gap-2">
        <span class="font-mono text-[13px] text-fg">
          {props.phase.name ?? props.phase.id}
        </span>
        <span class="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-warn">
          halted at gate
        </span>
        <Show when={props.phase.role}>
          <span class="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent">
            {props.phase.role}
          </span>
        </Show>
      </div>

      <Show when={props.phase.reason}>
        <p class="mt-2 text-[12px] text-fg-muted">{props.phase.reason}</p>
      </Show>

      <Show when={props.phase.summary}>
        <p class="mt-2 whitespace-pre-wrap text-[12px] text-fg">
          {props.phase.summary}
        </p>
      </Show>

      <Show when={(props.phase.questions?.length ?? 0) > 0}>
        <ul class="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-fg-muted">
          <For each={props.phase.questions}>{(q) => <li>{q}</li>}</For>
        </ul>
      </Show>

      {/* Prior revise notes, oldest → newest. */}
      <Show when={(props.phase.feedback?.length ?? 0) > 0}>
        <div class="mt-3">
          <div class={labelClass}>Revision history</div>
          <ol class="mt-1 space-y-1">
            <For each={props.phase.feedback}>
              {(f, i) => (
                <li class="rounded border border-border bg-bg/40 px-2 py-1 text-[11px] text-fg-muted">
                  <span class="mr-1.5 font-mono text-fg-faint">#{i() + 1}</span>
                  {f}
                </li>
              )}
            </For>
          </ol>
        </div>
      </Show>

      {/* Optional decision note (summary on approve / reason on reject). */}
      <label class="mt-3 flex flex-col gap-1">
        <span class={labelClass}>Note (optional)</span>
        <input
          type="text"
          autocomplete="off"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          class={inputClass}
          disabled={props.busy}
          aria-label="Decision note"
          placeholder="Accepted / rejected because…"
        />
      </label>

      {/* Revise feedback (required to revise). */}
      <label class="mt-2 flex flex-col gap-1">
        <span class={labelClass}>Revise feedback</span>
        <textarea
          rows={3}
          value={feedback()}
          onInput={(e) => setFeedback(e.currentTarget.value)}
          class={`${inputClass} resize-y leading-6`}
          disabled={props.busy}
          aria-label="Revise feedback"
          placeholder="What should this phase do differently? It re-runs with your notes."
        />
      </label>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class={`${btn} border-success/50 bg-success/10 text-success hover:bg-success/20`}
          disabled={props.busy}
          onClick={() => props.onApprove(reqId(), value().trim() || undefined)}
        >
          Approve
        </button>
        <button
          type="button"
          class={`${btn} border-accent/50 bg-accent/10 text-accent hover:bg-accent/20`}
          disabled={props.busy || !feedback().trim()}
          onClick={() => props.onRevise(reqId(), feedback().trim())}
          title={feedback().trim() ? undefined : "Enter feedback to revise"}
        >
          Revise
        </button>
        <button
          type="button"
          class={`${btn} border-danger/50 bg-danger/10 text-danger hover:bg-danger/20`}
          disabled={props.busy}
          onClick={() => props.onReject(reqId(), value().trim() || undefined)}
        >
          Reject
        </button>
      </div>
    </div>
  );
};

export default PipelineRunner;
