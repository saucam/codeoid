/**
 * SDLC pipeline primitive — public surface.
 *
 * The generic, methodology-agnostic pipeline engine (docs/sdlc-pipeline.md).
 * This slice ships the core primitive dark: types, registries, a trivial
 * built-in phase kind + gates, the advance engine, durable state, and the
 * lifecycle manager. No daemon wiring, no methodology content, no behavior
 * change until a manager is instantiated by the daemon in a later slice.
 */

export * from "./interface";
export { MapRegistry, createRegistries } from "./registry";
export { alwaysGate, manualGate, noopPhaseKind, registerBuiltins } from "./builtin";
export { PipelineEngine } from "./engine";
export { PipelineStore } from "./store";
export { type CreatePipelineOpts, type PipelineManagerOptions, PipelineManager } from "./manager";
export { makeSkillPhaseKind } from "./skill-kind";
export {
  loadPack,
  packManifestSchema,
  roleSchema,
  type LoadedPack,
  type PackManifest,
  type RoleDef,
} from "./pack";
export {
  SessionPhaseRunner,
  type PhaseRunner,
  type PhaseRunRequest,
  type PhaseRunOutput,
  type PhaseTurnHost,
} from "./runner";
export {
  createPipelineManagerFromConfig,
  type PipelineWiringConfig,
  type PipelineWiringOptions,
} from "./wiring";
