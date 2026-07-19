/**
 * SDLC pipeline — core types + the four plugin-interface seams.
 *
 * See docs/sdlc-pipeline.md (§3a plugin architecture, §5 the primitive, §5a
 * refinements). This module is pure data + interfaces: it imports nothing from
 * the daemon runtime, so the primitive is unit-testable in isolation and the
 * feature lands dark — nothing runs until a manager is wired into the daemon in
 * a later slice.
 */

// ── Phase definition (the static plan) ────────────────────────────────────

/** Per-phase tool scope, enforced at the tool fence — the hard tier (§5a.1). */
export interface ToolPolicy {
  /** tool / file globs allowed in this phase, e.g. ["Read","Write(**\/*_test.*)"]. */
  allow?: string[];
  /** hard block — wins over `allow` and over the session mode, e.g. ["Edit"]. */
  deny?: string[];
}

/** What to do when a phase's exit gate (or its kind) fails. */
export type PhaseFailAction =
  | { action: "halt" } // wait for a human decision (the default)
  | { action: "retry"; max: number } // re-run up to `max` attempts, then fail
  | { action: "abort" }; // fail the pipeline immediately

/** One phase in a pipeline's plan. `kind` selects the PhaseKind that runs it;
 *  everything else is optional content resolved through the registries. */
export interface PhaseDef {
  id: string;
  name?: string;
  /** id of the PhaseKind that runs this phase (resolved via the phase registry). */
  kind: string; // "noop" | "skill" | "panel" | "gate-only" | custom
  /** id of the SkillPlugin this phase drives (for kind:"skill"). */
  skill?: string;
  /** per-phase backend override (any registered provider id) — enables
   *  cross-provider-per-phase routing (§2a.3). */
  provider?: string;
  /** per-phase model override. */
  model?: string;
  /** exit-gate id — the acceptance predicate evaluated on phase output (§5a.5). */
  gate?: string;
  /** entry (grounding) gate id — a read-only probe before the phase acts (§5a.3). */
  entryGate?: string;
  /** per-phase tool scope, enforced at the `canUseTool` fence (§5a.1). */
  tools?: ToolPolicy;
  /** typed artifact ids this phase consumes (§5a.2). */
  reads?: string[];
  /** typed artifact id this phase produces (§5a.2). */
  writes?: string;
  /** failure policy for this phase. Defaults to `{ action: "halt" }`. */
  onFail?: PhaseFailAction;
}

// ── Phase + pipeline runtime state ────────────────────────────────────────

export type PhaseState =
  | { status: "pending" }
  | { status: "running"; startedAt: number; attempts: number; workerSessionId?: string }
  | { status: "halted"; requestId: string; reason: string; questions?: string[] }
  | { status: "passed"; summary?: string; artifacts?: string[] }
  | { status: "failed"; reason: string; attempts: number };

export type PipelineStatus =
  | "draft"
  | "running"
  | "halted"
  | "merged" // terminal success (SDLC framing)
  | "done" // terminal success (generic framing)
  | "failed"
  | "abandoned";

/** Terminal statuses — a pipeline in one of these never advances again. */
export const TERMINAL_STATUSES: readonly PipelineStatus[] = ["merged", "done", "failed", "abandoned"];

export function isTerminal(status: PipelineStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface PipelinePhase {
  def: PhaseDef;
  state: PhaseState;
}

/** The full, daemon-owned pipeline state — the source of truth persisted per
 *  transition so a halted pipeline survives a daemon restart (§5.2). */
export interface PipelineState {
  id: string;
  name: string;
  spec?: string;
  phases: PipelinePhase[];
  /** index of the active phase. */
  cursor: number;
  /** the pipeline's own durable session (set when wired to a conductor — a
   *  later slice; optional here so the primitive is session-free). */
  conductorSessionId?: string;
  status: PipelineStatus;
  accountId: string;
  projectId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

// ── Plugin seams (§3a.2) ──────────────────────────────────────────────────

/** A generic, idempotent, drop-in registry — the shape every extension point
 *  shares (phase kinds, gates, skills, packs). Mirrors the ProviderRegistry /
 *  Frontend registration ergonomics. */
export interface Registry<T extends { id: string }> {
  register(item: T): void;
  unregister(id: string): void;
  resolve(id: string): T | undefined;
  list(): T[];
  has(id: string): boolean;
}

export interface PipelineRegistries {
  phases: Registry<PhaseKind>;
  gates: Registry<GatePlugin>;
  skills: Registry<SkillPlugin>;
  packs: Registry<Pack>;
}

/** Context handed to a PhaseKind.run — minimal here (no worker sessions yet). */
export interface PhaseCtx {
  pipeline: PipelineState;
  phase: PhaseDef;
  registries: PipelineRegistries;
}

export type PhaseRunResult =
  | { outcome: "passed"; summary?: string; artifacts?: string[] }
  | { outcome: "halted"; requestId: string; reason: string; questions?: string[] }
  | { outcome: "failed"; reason: string };

/** A phase kind knows how to execute one phase and report its result. (Slice 1
 *  returns a Promise; a streaming `AsyncIterable<PhaseEvent>` can be added
 *  additively when phases drive real backends.) */
export interface PhaseKind {
  id: string;
  run(ctx: PhaseCtx): Promise<PhaseRunResult>;
}

export interface GateCtx {
  pipeline: PipelineState;
  phase: PhaseDef;
}

export interface GateVerdict {
  pass: boolean;
  reason?: string;
  questions?: string[];
}

/** A gate: a pass/fail predicate positioned at phase entry (grounding) or exit
 *  (acceptance) — §5a.3, §5a.5. `at` is advisory metadata used for authoring /
 *  validation; the engine resolves a gate by id wherever a phase references it. */
export interface GatePlugin {
  id: string;
  at: "entry" | "exit";
  evaluate(ctx: GateCtx): Promise<GateVerdict>;
}

export interface SkillResult {
  summary?: string;
  artifacts?: string[];
}

/** A runnable content unit a phase drives — three equal flavors (§3a.2). */
export type SkillPlugin =
  | { id: string; kind: "slash"; command: string }
  | { id: string; kind: "prompt"; template: string }
  | { id: string; kind: "fn"; run: (ctx: PhaseCtx) => Promise<SkillResult> };

/** A named bundle that registers phases/gates/skills and declares a default
 *  phase sequence — enable/disable a whole methodology at once (§3a.2, §7). */
export interface Pack {
  id: string;
  register(r: PipelineRegistries): void;
  pipeline: PhaseDef[];
}
