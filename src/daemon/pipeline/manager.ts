/**
 * PipelineManager — owns pipeline lifecycle over a PipelineStore: create, look
 * up, advance, abort, and rehydrate (resume) non-terminal pipelines on
 * construction so a pipeline halted at phase N comes back halted at phase N
 * after a daemon restart (§5.2). Daemon boot, worker sessions, and frontend
 * halt-surfacing compose around this in a later slice.
 */

import { randomUUID } from "node:crypto";
import { registerBuiltins } from "./builtin";
import { PipelineEngine } from "./engine";
import type { PhaseDef, PipelineRegistries, PipelineState } from "./interface";
import { createRegistries } from "./registry";
import type { PipelineStore } from "./store";

export interface CreatePipelineOpts {
  name: string;
  phases: PhaseDef[];
  accountId: string;
  projectId: string;
  createdBy: string;
  spec?: string;
}

export class PipelineManager {
  #store: PipelineStore;
  #registries: PipelineRegistries;
  #engine: PipelineEngine;
  #cache = new Map<string, PipelineState>();

  constructor(store: PipelineStore, registries?: PipelineRegistries) {
    this.#store = store;
    this.#registries = registries ?? defaultRegistries();
    this.#engine = new PipelineEngine(this.#registries);
    this.resume();
  }

  get registries(): PipelineRegistries {
    return this.#registries;
  }

  /** Create a draft pipeline (all phases pending) and persist it. */
  create(opts: CreatePipelineOpts): PipelineState {
    const ts = Date.now();
    const state: PipelineState = {
      id: randomUUID(),
      name: opts.name,
      spec: opts.spec,
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
  async advance(id: string): Promise<PipelineState> {
    const start = this.get(id);
    if (!start) throw new Error(`pipeline "${id}" not found`);
    return this.#engine.run(start, (s) => {
      this.#store.save(s);
      this.#cache.set(s.id, s);
    });
  }

  /**
   * Resolve a halted phase with a human decision, then resume the pipeline.
   * `approved` marks the phase passed (its `value` becomes the summary) and
   * advances; otherwise the phase — and the pipeline — fail. This is the
   * daemon-side of the halt → answer-from-a-frontend → resume path (§4.1, §5.3):
   * a `ui_response` lands here to unblock a pipeline that a gate parked.
   */
  async answer(
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
    return next.status === "running" ? this.advance(id) : next;
  }

  /** Mark a pipeline abandoned (terminal). Returns undefined if unknown. */
  abort(id: string): PipelineState | undefined {
    const s = this.get(id);
    if (!s) return undefined;
    const next: PipelineState = { ...cloneState(s), status: "abandoned", updatedAt: Date.now() };
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
}

function defaultRegistries(): PipelineRegistries {
  const r = createRegistries();
  registerBuiltins(r);
  return r;
}

const cloneState = (s: PipelineState): PipelineState => JSON.parse(JSON.stringify(s)) as PipelineState;
