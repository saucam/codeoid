/**
 * Built-in, content-free plugins — the minimum needed to prove the primitive
 * runs, persists, and survives restart without a real backend. Methodology
 * content (the ADLC pack, `skill` / `panel` phase kinds, command/review gates)
 * ships as separate packs in later slices; nothing here encodes an SDLC.
 */

import type { GatePlugin, PhaseKind, PipelineRegistries } from "./interface";

/** A phase kind that does nothing and immediately passes — the minimal runnable
 *  phase. Lets a pipeline advance end to end so the engine, store, and restart
 *  path are exercisable before any backend-driven kind exists. */
export const noopPhaseKind: PhaseKind = {
  id: "noop",
  async run() {
    return { outcome: "passed" };
  },
};

/** An exit gate that always passes. */
export const alwaysGate: GatePlugin = {
  id: "always",
  at: "exit",
  async evaluate() {
    return { pass: true };
  },
};

/** A gate that never auto-passes — it always returns a failing verdict so the
 *  phase's `onFail` policy applies (a phase that must wait for a human sets
 *  `onFail: { action: "halt" }`, which is also the default). */
export const manualGate: GatePlugin = {
  id: "manual",
  at: "exit",
  async evaluate() {
    return { pass: false, reason: "manual gate — awaiting human decision" };
  },
};

/** Register the built-in plugins into a set of registries. */
export function registerBuiltins(r: PipelineRegistries): void {
  r.phases.register(noopPhaseKind);
  r.gates.register(alwaysGate);
  r.gates.register(manualGate);
}
