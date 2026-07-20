/**
 * The seam between a phase and a backend. A `PhaseRunner` runs a phase's prompt
 * on a (worker) session and returns its result. The concrete SessionManager-
 * backed adapter lands in a later slice; abstracting it here keeps the pipeline
 * package free of Session dependencies and lets the skill phase kind be tested
 * with a fake runner.
 */

import type { PhaseDef, PipelineState } from "./interface";

export interface PhaseRunRequest {
  /** the resolved prompt / slash command to run for this phase. */
  prompt: string;
  /** per-phase backend override — enables cross-provider-per-phase routing. */
  provider?: string;
  /** per-phase model override. */
  model?: string;
  pipeline: PipelineState;
  phase: PhaseDef;
}

export interface PhaseRunOutput {
  summary?: string;
  artifacts?: string[];
}

export interface PhaseRunner {
  runPrompt(req: PhaseRunRequest): Promise<PhaseRunOutput>;
}
