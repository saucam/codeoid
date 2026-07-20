/**
 * Boot wiring for the SDLC pipeline. Builds a PipelineManager from config,
 * returning `undefined` when the feature is disabled (the default) so the daemon
 * stays dark. Kept a pure factory so the enable/disable + share-the-daemon-DB
 * behavior is unit-testable without standing up a full SessionManager.
 */

import type { Database } from "bun:sqlite";
import { PipelineManager } from "./manager";
import type { PhaseRunner } from "./runner";
import { PipelineStore } from "./store";

/** The minimal structural slice of CodeoidConfig this factory needs — kept
 *  narrow so the pipeline package doesn't depend on the full config type. */
export interface PipelineWiringConfig {
  dbPath: string;
  pipeline?: { enabled: boolean };
}

export interface PipelineWiringOptions {
  /** Backend seam for prompt/slash skills. Omit for noop/fn-only pipelines. */
  runner?: PhaseRunner;
  /** Share this DB handle (the daemon Store's) instead of opening a second
   *  connection to `config.dbPath`. */
  db?: Database;
}

/**
 * Construct a PipelineManager when the pipeline is enabled. Returns `undefined`
 * when disabled — the daemon then holds no pipeline manager at all. Shares the
 * daemon's DB handle when `opts.db` is given (else opens `config.dbPath`).
 */
export function createPipelineManagerFromConfig(
  config: PipelineWiringConfig | undefined,
  opts: PipelineWiringOptions = {},
): PipelineManager | undefined {
  if (!config?.pipeline?.enabled) return undefined;
  const store = opts.db ? new PipelineStore(opts.db) : new PipelineStore(config.dbPath);
  return new PipelineManager(store, { runner: opts.runner });
}
