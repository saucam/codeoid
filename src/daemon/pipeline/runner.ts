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

/**
 * The minimal daemon capability a SessionPhaseRunner needs: run one turn on a
 * disposable worker session and return the assistant's final text. Defined here
 * (not imported from the daemon) so the pipeline package stays free of a
 * SessionManager dependency; SessionManager satisfies it structurally.
 */
export interface PhaseTurnHost {
  runPhaseTurn(req: {
    prompt: string;
    provider?: string;
    model?: string;
    workdir: string;
    accountId: string;
    projectId: string;
    createdBy: string;
  }): Promise<string>;
}

/**
 * The real PhaseRunner: drives a phase's prompt on a worker session via the
 * daemon host and returns its final text as the phase summary. The host is a
 * thunk so it can be constructed before the SessionManager it points at exists
 * (the manager builds the pipeline manager in its own constructor) — the thunk
 * is only dereferenced at run time, long after construction.
 */
export class SessionPhaseRunner implements PhaseRunner {
  #host: () => PhaseTurnHost;

  constructor(host: () => PhaseTurnHost) {
    this.#host = host;
  }

  async runPrompt(req: PhaseRunRequest): Promise<PhaseRunOutput> {
    const summary = await this.#host().runPhaseTurn({
      prompt: req.prompt,
      provider: req.provider,
      model: req.model,
      workdir: req.pipeline.workdir ?? process.cwd(),
      accountId: req.pipeline.accountId,
      projectId: req.pipeline.projectId,
      createdBy: req.pipeline.createdBy,
    });
    return { summary };
  }
}
