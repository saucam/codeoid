/**
 * PipelineManager — owns pipeline lifecycle over a PipelineStore: create, look
 * up, advance, answer (halt→resume), abort, and rehydrate non-terminal pipelines
 * on construction so a pipeline halted at phase N comes back halted at phase N
 * after a daemon restart (§5.2).
 *
 * Mutating operations for a given pipeline are serialized through a per-id
 * promise chain, so an `advance` awaiting a real backend turn can't interleave
 * with another `advance`/`answer` and clobber persisted state (lost update).
 */

import { randomUUID } from "node:crypto";
import { registerBuiltins } from "./builtin";
import { PipelineEngine } from "./engine";
import type { PhaseDef, PipelineRegistries, PipelineState } from "./interface";
import { isTerminal } from "./interface";
import { createRegistries } from "./registry";
import type { PhaseRunner } from "./runner";
import { makeSkillPhaseKind } from "./skill-kind";
import type { PipelineStore } from "./store";

export interface CreatePipelineOpts {
  name: string;
  phases: PhaseDef[];
  accountId: string;
  projectId: string;
  createdBy: string;
  spec?: string;
  workdir?: string;
}

export interface PipelineManagerOptions {
  /** Override the plugin registries (tests / custom packs). */
  registries?: PipelineRegistries;
  /** Backend seam for prompt/slash skills — enables the "skill" phase kind to
   *  drive a real session turn. Omit for pure `noop`/`fn`-skill pipelines. */
  runner?: PhaseRunner;
}

export class PipelineManager {
  #store: PipelineStore;
  #registries: PipelineRegistries;
  #engine: PipelineEngine;
  #cache = new Map<string, PipelineState>();
  /** Per-pipeline mutation serialization (id → tail of its op chain). */
  #chains = new Map<string, Promise<unknown>>();

  constructor(store: PipelineStore, options: PipelineManagerOptions = {}) {
    this.#store = store;
    this.#registries = options.registries ?? defaultRegistries(options.runner);
    this.#engine = new PipelineEngine(this.#registries);
    this.resume();
  }

  get registries(): PipelineRegistries {
    return this.#registries;
  }

  /** Create a draft pipeline (all phases pending) and persist it. Throws if a
   *  phase references a kind/gate/skill that isn't registered (fail fast). */
  create(opts: CreatePipelineOpts): PipelineState {
    this.#validate(opts.phases);
    const ts = Date.now();
    const state: PipelineState = {
      id: randomUUID(),
      name: opts.name,
      spec: opts.spec,
      workdir: opts.workdir,
      phases: opts.phases.map((def) => ({ def, state: { status: "pending" } })),
      cursor: 0,
      status: "draft",
      accountId: opts.accountId,
      projectId: opts.projectId,
      createdBy: opts.createdBy,
      createdAt: ts,
      updatedAt: ts,
    };
    this.#store.save(state);
    this.#cache.set(state.id, state);
    return state;
  }

  get(id: string): PipelineState | undefined {
    return this.#cache.get(id) ?? this.#store.get(id);
  }

  list(accountId: string, projectId: string): PipelineState[] {
    return this.#store.listByTenant(accountId, projectId);
  }

  /** Drive the pipeline until it is terminal or halted, persisting each step. */
  advance(id: string): Promise<PipelineState> {
    return this.#serialize(id, () => this.#advanceInner(id));
  }

  /**
   * Resolve a halted phase with a human decision, then resume the pipeline.
   * `approved` marks the phase passed (its `value` becomes the summary) and
   * advances; otherwise the phase — and the pipeline — fail. Approving is a
   * deliberate human **override** (even of a deterministic gate); use
   * `onFail:"abort"` for failures that must be final. This is the daemon side of
   * halt → answer-from-a-frontend → resume (§4.1, §5.3).
   */
  answer(id: string, requestId: string, opts: { approved: boolean; value?: string }): Promise<PipelineState> {
    return this.#serialize(id, () => this.#answerInner(id, requestId, opts));
  }

  /** Mark a pipeline abandoned (terminal). No-op if unknown or already terminal;
   *  the active phase (if unresolved) is failed so the record isn't left mid-run. */
  abort(id: string): PipelineState | undefined {
    const s = this.get(id);
    if (!s) return undefined;
    if (isTerminal(s.status)) return s;
    const next = cloneState(s);
    const cur = next.phases[next.cursor];
    if (cur && cur.state.status !== "passed" && cur.state.status !== "failed") {
      cur.state = { status: "failed", reason: "pipeline aborted", attempts: 0 };
    }
    next.status = "abandoned";
    next.updatedAt = Date.now();
    this.#store.save(next);
    this.#cache.set(id, next);
    return next;
  }

  /** Rehydrate non-terminal pipelines from the store into the in-memory cache.
   *  Returns the number resumed. Called once on construction. */
  resume(): number {
    const active = this.#store.listActive();
    for (const s of active) this.#cache.set(s.id, s);
    return active.length;
  }

  /**
   * Re-drive pipelines that were interrupted mid-run at a restart (status
   * `draft`/`running`). Halted pipelines are intentionally left parked for a
   * human answer. Call once after construction on daemon boot. Note: a phase
   * interrupted while executing re-runs (at-least-once — same as the dispatcher).
   */
  async driveResumable(): Promise<PipelineState[]> {
    const resumable = [...this.#cache.values()].filter(
      (s) => s.status === "draft" || s.status === "running",
    );
    return Promise.all(resumable.map((s) => this.advance(s.id)));
  }

  // ── internals ────────────────────────────────────────────────────────────

  async #advanceInner(id: string): Promise<PipelineState> {
    const start = this.get(id);
    if (!start) throw new Error(`pipeline "${id}" not found`);
    return this.#engine.run(start, (s) => {
      this.#store.save(s);
      this.#cache.set(s.id, s);
    });
  }

  async #answerInner(
    id: string,
    requestId: string,
    opts: { approved: boolean; value?: string },
  ): Promise<PipelineState> {
    const s = this.get(id);
    if (!s) throw new Error(`pipeline "${id}" not found`);
    if (s.status !== "halted") throw new Error(`pipeline "${id}" is not halted (status: ${s.status})`);
    const current = s.phases[s.cursor];
    if (!current || current.state.status !== "halted") {
      throw new Error(`pipeline "${id}" has no halted phase at the cursor`);
    }
    if (current.state.requestId !== requestId) {
      throw new Error(`stale requestId "${requestId}" for pipeline "${id}"`);
    }

    const next = cloneState(s);
    const phase = next.phases[next.cursor];
    if (opts.approved) {
      phase.state = { status: "passed", summary: opts.value ?? "approved" };
      next.cursor += 1;
      next.status = next.cursor >= next.phases.length ? "done" : "running";
    } else {
      phase.state = { status: "failed", reason: opts.value ?? "rejected by human", attempts: 1 };
      next.status = "failed";
    }
    next.updatedAt = Date.now();
    this.#store.save(next);
    this.#cache.set(id, next);

    // Approving a non-final phase resumes the run to the next halt / terminal.
    // Call the inner advance directly — we already hold this id's chain slot.
    return next.status === "running" ? this.#advanceInner(id) : next;
  }

  #validate(phases: PhaseDef[]): void {
    if (phases.length === 0) throw new Error("pipeline must declare at least one phase");
    for (const p of phases) {
      if (!this.#registries.phases.has(p.kind)) {
        throw new Error(`phase "${p.id}": unknown kind "${p.kind}"`);
      }
      if (p.gate && !this.#registries.gates.has(p.gate)) {
        throw new Error(`phase "${p.id}": unknown gate "${p.gate}"`);
      }
      if (p.entryGate && !this.#registries.gates.has(p.entryGate)) {
        throw new Error(`phase "${p.id}": unknown entry gate "${p.entryGate}"`);
      }
      if (p.kind === "skill" && p.skill && !this.#registries.skills.has(p.skill)) {
        throw new Error(`phase "${p.id}": unknown skill "${p.skill}"`);
      }
    }
  }

  /** Serialize mutating ops per pipeline id so awaited work can't interleave and
   *  clobber persisted state. The chain swallows errors so one failed op doesn't
   *  break the next; entries are dropped once the tail settles. */
  #serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.#chains.get(id) ?? Promise.resolve()).catch(() => undefined);
    const result = prev.then(() => fn());
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#chains.set(id, settled);
    void settled.then(() => {
      if (this.#chains.get(id) === settled) this.#chains.delete(id);
    });
    return result;
  }
}

function defaultRegistries(runner?: PhaseRunner): PipelineRegistries {
  const r = createRegistries();
  registerBuiltins(r);
  // The "skill" phase kind drives prompt/slash skills through the runner (fn
  // skills run natively); registered here so a default manager can run them.
  r.phases.register(makeSkillPhaseKind(runner));
  return r;
}

const cloneState = (s: PipelineState): PipelineState => JSON.parse(JSON.stringify(s)) as PipelineState;
