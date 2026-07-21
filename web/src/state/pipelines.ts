/**
 * Pipeline-run state — a single active governed SDLC run (docs/pipeline-run.md).
 * Mirrors state/packs.ts (module-singleton signal, `getClient().request` with a
 * typed `waitForResult`, a `_reset*ForTest` hook), with two differences dictated
 * by the wire contract:
 *
 *   1. There is NO push/broadcast for pipelines — connection.ts's broadcast
 *      router has no pipeline case — so progress + halts are reflected by a
 *      POLL LOOP on `pipeline.get` (~2s) that stops once the run is terminal.
 *
 *   2. `advance` / `answer` / `revise` block SERVER-SIDE for minutes (each phase
 *      is a real model turn, up to ~10 min), well past the default request
 *      timeout. They're fired fire-and-forget with a large timeout and are NOT
 *      relied on for progression — the poll loop drives the view. A client-side
 *      timeout on one of them is expected and is swallowed; only a real
 *      rejection (forbidden scope, disabled, invalid) surfaces as `error`.
 *
 * Every verb replies with a `pipeline.snapshot { pipeline }`; each reply just
 * replaces the slice. Errors are caught → set `error`; nothing throws.
 */

import { createSignal } from "solid-js";

import { getClient, newRequestId } from "./connection";
import type {
  ClientMessage,
  PipelineSnapshotMsg,
  PipelineWire,
} from "../protocol/types";

interface PipelinesState {
  /** The single pipeline being viewed (create → run → terminal). */
  pipeline: PipelineWire | null;
  /** A create / get read is settling (first paint / no pipeline yet). */
  loading: boolean;
  /** A steer (advance/answer/revise/abort) is in flight — a phase is running. */
  busy: boolean;
  /** Last fetch/steer error (e.g. "Pipeline is disabled" or a scope rejection). */
  error: string | null;
}

const EMPTY: PipelinesState = {
  pipeline: null,
  loading: false,
  busy: false,
  error: null,
};

const [state, setState] = createSignal<PipelinesState>(EMPTY);

export const pipelinesState = state;

/** Poll cadence for `pipeline.get` while a run is live. */
const POLL_INTERVAL_MS = 2_000;
/** `get` / `create` are cheap. */
const READ_TIMEOUT_MS = 15_000;
/** advance/answer/revise run a full model turn per phase — give them room past
 *  the point where the poll loop has already reflected the outcome. */
const STEER_TIMEOUT_MS = 15 * 60_000;

const TERMINAL: readonly PipelineWire["status"][] = [
  "merged",
  "done",
  "failed",
  "abandoned",
];

function isTerminal(status: PipelineWire["status"]): boolean {
  return TERMINAL.includes(status);
}

/** A `response.error` rejection is the raw wire object `{ error, code }`; a
 *  transport/timeout failure is an `Error`. Surface whichever human string. */
function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "error" in e) {
    const m = (e as { error?: unknown }).error;
    if (typeof m === "string") return m;
  }
  return e instanceof Error ? e.message : String(e);
}

/** A steer's client-side timeout is EXPECTED (the phase is still running
 *  server-side) — the poll loop drives the view, so don't surface it. */
function isClientTimeout(e: unknown): boolean {
  return e instanceof Error && /timed out/i.test(e.message);
}

function applySnapshot(snap: PipelineSnapshotMsg | undefined): void {
  if (!snap || !snap.pipeline) return;
  setState((s) => ({ ...s, pipeline: snap.pipeline, error: null }));
}

function currentPipelineId(): string | null {
  return state().pipeline?.id ?? null;
}

// ── Poll loop ────────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;

function stopPoll(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollOnce(pipelineId: string): Promise<void> {
  const id = newRequestId();
  try {
    const snap = await getClient().request<PipelineSnapshotMsg>(
      { type: "pipeline.get", id, pipelineId },
      {
        waitForResult: (m) =>
          m.type === "pipeline.snapshot" && m.requestId === id ? m : undefined,
        timeoutMs: READ_TIMEOUT_MS,
      },
    );
    applySnapshot(snap);
    if (snap?.pipeline && isTerminal(snap.pipeline.status)) stopPoll();
  } catch (e) {
    // A blip (socket reconnecting) — surface but keep polling; a later success
    // clears the error via applySnapshot.
    setState((s) => ({ ...s, error: errMessage(e) }));
  }
}

/** (Re)start the poll loop for `pipelineId`. Cleared on terminal / reset. */
function startPoll(pipelineId: string): void {
  stopPoll();
  pollTimer = setInterval(() => void pollOnce(pipelineId), POLL_INTERVAL_MS);
}

// ── Steering (fire-and-forget, poll-driven) ───────────────────────────────────

/**
 * Fire a steer verb (advance/answer/revise/abort) with a large timeout and do
 * NOT rely on its reply for progression. The poll loop reflects progress; this
 * only best-effort-applies the eventual snapshot and surfaces a *real* (non-
 * timeout) rejection. Marks `busy` while in flight and (re)starts the poll loop.
 */
function fireSteer(build: (id: string) => ClientMessage, pipelineId: string): void {
  const id = newRequestId();
  setState((s) => ({ ...s, busy: true, error: null }));
  getClient()
    .request<PipelineSnapshotMsg>(build(id), {
      waitForResult: (m) =>
        m.type === "pipeline.snapshot" && m.requestId === id ? m : undefined,
      timeoutMs: STEER_TIMEOUT_MS,
    })
    .then((snap) => applySnapshot(snap))
    .catch((e) => {
      if (!isClientTimeout(e)) setState((s) => ({ ...s, error: errMessage(e) }));
    })
    .finally(() => setState((s) => ({ ...s, busy: false })));
  // Reflect whatever the steer kicks off (the phase running → its next halt).
  startPoll(pipelineId);
}

function advance(pipelineId: string): void {
  fireSteer((id) => ({ type: "pipeline.advance", id, pipelineId }), pipelineId);
}

/** A short label from the goal for the pipeline's display name. */
function deriveName(goal: string): string {
  const firstLine = goal.trim().split("\n")[0]?.trim() ?? "";
  if (!firstLine) return "pipeline run";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a run from an installed pack with a goal, then drive it (advance) —
 * both fire-and-forget past the create. `create` is awaited only to learn the
 * pipeline id; everything after is poll-driven. A create rejection (e.g.
 * "Pipeline is disabled") surfaces as `error`.
 */
export async function runPipeline(opts: {
  pack: string;
  goal: string;
  workdir: string;
}): Promise<void> {
  stopPoll();
  setState(() => ({ ...EMPTY, loading: true }));
  const id = newRequestId();
  try {
    const snap = await getClient().request<PipelineSnapshotMsg>(
      {
        type: "pipeline.create",
        id,
        name: deriveName(opts.goal),
        pack: opts.pack,
        spec: opts.goal,
        workdir: opts.workdir,
      },
      {
        waitForResult: (m) =>
          m.type === "pipeline.snapshot" && m.requestId === id ? m : undefined,
        timeoutMs: READ_TIMEOUT_MS,
      },
    );
    applySnapshot(snap);
    if (snap?.pipeline) advance(snap.pipeline.id);
  } catch (e) {
    setState((s) => ({ ...s, error: errMessage(e) }));
  } finally {
    setState((s) => ({ ...s, loading: false }));
  }
}

/** Approve the halted phase (advances to the next halt / terminal). */
export function approve(requestId: string, value?: string): void {
  const pipelineId = currentPipelineId();
  if (!pipelineId) return;
  const v = value?.trim();
  fireSteer(
    (id) => ({
      type: "pipeline.answer",
      id,
      pipelineId,
      requestId,
      approved: true,
      ...(v ? { value: v } : {}),
    }),
    pipelineId,
  );
}

/** Reject the halted phase (hard-stops the run → terminal fail). */
export function reject(requestId: string, value?: string): void {
  const pipelineId = currentPipelineId();
  if (!pipelineId) return;
  const v = value?.trim();
  fireSteer(
    (id) => ({
      type: "pipeline.answer",
      id,
      pipelineId,
      requestId,
      approved: false,
      ...(v ? { value: v } : {}),
    }),
    pipelineId,
  );
}

/** Re-run the halted phase with human feedback (loops back to a halt). */
export function revise(requestId: string, feedback: string): void {
  const pipelineId = currentPipelineId();
  if (!pipelineId) return;
  fireSteer(
    (id) => ({ type: "pipeline.revise", id, pipelineId, requestId, feedback }),
    pipelineId,
  );
}

/** Abort the run (→ terminal abandoned). */
export function abort(): void {
  const pipelineId = currentPipelineId();
  if (!pipelineId) return;
  fireSteer((id) => ({ type: "pipeline.abort", id, pipelineId }), pipelineId);
}

/** Test-only: reset the module singleton (and stop the poll loop) between cases. */
export function _resetPipelinesForTest(): void {
  stopPoll();
  setState(EMPTY);
}
