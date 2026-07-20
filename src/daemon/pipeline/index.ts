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
export { type CreatePipelineOpts, PipelineManager } from "./manager";
export { createPipelineManagerFromConfig, type PipelineWiringConfig } from "./wiring";
export { makeSkillPhaseKind } from "./skill-kind";
export type { PhaseRunner, PhaseRunRequest, PhaseRunOutput } from "./runner";
