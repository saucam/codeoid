/**
 * The pipeline advance logic.
 *
 * Pure over (PipelineState × registries): `step()` moves one phase forward
 * (promote → optional entry gate → run kind → exit gate → transition) and
 * returns a NEW state; `run()` loops `step()` until the pipeline is terminal or
 * halted, invoking `onProgress` after each step so the caller can persist.
 *
 * Persistence, identity, worker sessions, and frontend surfacing are NOT here —
 * they compose around this in PipelineManager (and later slices). Keeping the
 * transition rules side-effect-free is exactly what makes them unit-testable.
 */

import type {
  GateVerdict,
  PhaseDef,
  PhaseFailAction,
  PhaseRunResult,
  PipelinePhase,
  PipelineRegistries,
  PipelineState,
} from "./interface";
import { isTerminal } from "./interface";
import { errMessage } from "./errors";

/** Defensive cap against a mis-authored retry loop (each retry is one step). */
const MAX_STEPS = 10_000;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const now = (): number => Date.now();

export class PipelineEngine {
  #registries: PipelineRegistries;

  constructor(registries: PipelineRegistries) {
    this.#registries = registries;
  }

  /** Advance the active phase by one unit of work and return a new state. */
  async step(state: PipelineState): Promise<PipelineState> {
    if (isTerminal(state.status) || state.status === "halted") return state;
    const s = clone(state);
    if (s.status === "draft") s.status = "running";

    const phase = s.phases[s.cursor];
    if (!phase) {
      // cursor ran off the end — the pipeline is complete.
      s.status = "done";
      return touch(s);
    }

    if (phase.state.status === "pending") {
      phase.state = { status: "running", startedAt: now(), attempts: 0 };
    }
    if (phase.state.status !== "running") {
      // a passed / failed / halted phase sits under the cursor — nothing to run.
      return touch(s);
    }
    const attempts = phase.state.attempts;

    // Entry (grounding) gate — read-only probe before the phase acts (§5a.3).
    if (phase.def.entryGate) {
      const v = await this.#gate(phase.def.entryGate, s, phase.def, "entry");
      if (!v.pass) return applyFail(s, phase, v, attempts, "entry");
    }

    // Run the phase kind. A throwing plugin must not crash the run and leave
    // the pipeline stuck "running" in the store (→ a restart crash-loop); a
    // throw is treated as a phase failure, then handled by the onFail policy.
    const kind = this.#registries.phases.resolve(phase.def.kind);
    let res: PhaseRunResult;
    if (!kind) {
      res = { outcome: "failed", reason: `unknown phase kind "${phase.def.kind}"` };
    } else {
      try {
        res = await kind.run({ pipeline: s, phase: phase.def, registries: this.#registries });
      } catch (err) {
        res = { outcome: "failed", reason: `phase kind "${phase.def.kind}" threw: ${errMessage(err)}` };
      }
    }

    if (res.outcome === "halted") {
      phase.state = {
        status: "halted",
        requestId: res.requestId,
        reason: res.reason,
        questions: res.questions,
      };
      s.status = "halted";
      return touch(s);
    }
    if (res.outcome === "failed") {
      return applyFail(s, phase, { pass: false, reason: res.reason }, attempts, "kind");
    }

    // Exit gate — acceptance predicate on the phase output (§5, §5a.5).
    if (phase.def.gate) {
      const v = await this.#gate(phase.def.gate, s, phase.def, "exit");
      if (!v.pass) return applyFail(s, phase, v, attempts, "exit");
    }

    // Passed → record the result and advance the cursor.
    phase.state = { status: "passed", summary: res.summary, artifacts: res.artifacts };
    s.cursor += 1;
    s.status = s.cursor >= s.phases.length ? "done" : "running";
    return touch(s);
  }

  /** Drive the pipeline forward until it is terminal or halted. */
  async run(
    state: PipelineState,
    onProgress?: (s: PipelineState) => void | Promise<void>,
  ): Promise<PipelineState> {
    let s = state;
    let guard = 0;
    while ((s.status === "draft" || s.status === "running") && guard++ < MAX_STEPS) {
      s = await this.step(s);
      if (onProgress) await onProgress(s);
    }
    return s;
  }

  async #gate(
    id: string,
    pipeline: PipelineState,
    phase: PhaseDef,
    at: "entry" | "exit",
  ): Promise<GateVerdict> {
    const g = this.#registries.gates.resolve(id);
    if (!g) return { pass: false, reason: `unknown ${at} gate "${id}"` };
    try {
      return await g.evaluate({ pipeline, phase });
    } catch (err) {
      // A throwing gate is a failing verdict, not a crash — same reasoning as
      // the phase kind above: never leave the pipeline stuck mid-advance.
      return { pass: false, reason: `${at} gate "${id}" threw: ${errMessage(err)}` };
    }
  }
}

function touch(s: PipelineState): PipelineState {
  s.updatedAt = now();
  return s;
}

/**
 * Apply a phase failure per its `onFail` policy:
 *   retry (within budget) → re-run; halt (the default) → wait for a human;
 *   abort or retries-exhausted → fail the pipeline.
 * Mutates + returns the already-cloned state.
 */
function applyFail(
  s: PipelineState,
  phase: PipelinePhase,
  verdict: GateVerdict,
  attempts: number,
  source: "entry" | "exit" | "kind",
): PipelineState {
  const onFail: PhaseFailAction = phase.def.onFail ?? { action: "halt" };
  const reason = verdict.reason ?? "phase gate failed";
  const nextAttempts = attempts + 1;

  if (onFail.action === "retry" && nextAttempts < onFail.max) {
    phase.state = { status: "running", startedAt: now(), attempts: nextAttempts };
    s.status = "running";
    return touch(s);
  }
  if (onFail.action === "halt") {
    phase.state = {
      status: "halted",
      // Source-qualified so a phase with both an entry and an exit gate produces
      // distinct halt ids (no collision when answering).
      requestId: `${source}:${phase.def.id}`,
      reason,
      questions: verdict.questions,
    };
    s.status = "halted";
    return touch(s);
  }
  // abort, or a retry budget that has now been exhausted.
  phase.state = { status: "failed", reason, attempts: nextAttempts };
  s.status = "failed";
  return touch(s);
}
