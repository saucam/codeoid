/**
 * The generic in-memory registry behind every pipeline extension point, plus a
 * factory for the four-registry set (§3a.1). Content-free: built-in plugins are
 * registered separately by registerBuiltins() (builtin.ts) so the registry
 * machinery never marries any particular methodology.
 */

import type {
  GatePlugin,
  Pack,
  PhaseKind,
  PipelineRegistries,
  Registry,
  SkillPlugin,
} from "./interface";

/**
 * A `Map`-backed registry: register / unregister / resolve / list / has.
 * `register` is idempotent with last-wins semantics and warns on a duplicate id,
 * matching how providers and frontends are registered elsewhere in the daemon.
 */
export class MapRegistry<T extends { id: string }> implements Registry<T> {
  #items = new Map<string, T>();
  #label: string;

  constructor(label: string) {
    this.#label = label;
  }

  register(item: T): void {
    if (this.#items.has(item.id)) {
      console.warn(`[pipeline] ${this.#label} "${item.id}" already registered — overwriting (last wins)`);
    }
    this.#items.set(item.id, item);
  }

  unregister(id: string): void {
    this.#items.delete(id);
  }

  resolve(id: string): T | undefined {
    return this.#items.get(id);
  }

  list(): T[] {
    return [...this.#items.values()];
  }

  has(id: string): boolean {
    return this.#items.has(id);
  }
}

/** Build a fresh, empty set of the four pipeline registries. */
export function createRegistries(): PipelineRegistries {
  return {
    phases: new MapRegistry<PhaseKind>("phase-kind"),
    gates: new MapRegistry<GatePlugin>("gate"),
    skills: new MapRegistry<SkillPlugin>("skill"),
    packs: new MapRegistry<Pack>("pack"),
  };
}
