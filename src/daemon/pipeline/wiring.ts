/**
 * Boot wiring for the SDLC pipeline. Builds a PipelineManager from config,
 * returning `undefined` when the feature is disabled (the default) so the daemon
 * stays dark. Kept a pure factory so the enable/disable + share-the-daemon-DB
 * behavior is unit-testable without standing up a full SessionManager.
 */

import { PipelineManager } from "./manager";
import { PipelineStore } from "./store";

/** The minimal structural slice of CodeoidConfig this factory needs — kept
 *  narrow so the pipeline package doesn't depend on the full config type. */
export interface PipelineWiringConfig {
  dbPath: string;
  pipeline?: { enabled: boolean };
}

/**
 * Construct a PipelineManager when the pipeline is enabled, sharing the daemon
 * DB file so pipeline state persists and resumes alongside sessions. Returns
 * `undefined` when disabled — the daemon then holds no pipeline manager at all.
 */
export function createPipelineManagerFromConfig(
  config: PipelineWiringConfig | undefined,
): PipelineManager | undefined {
  if (!config?.pipeline?.enabled) return undefined;
  return new PipelineManager(new PipelineStore(config.dbPath));
}
