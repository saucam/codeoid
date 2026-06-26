import type { AgentProvider } from "./interface.js";

export class ProviderRegistry {
  readonly #providers = new Map<string, AgentProvider>();

  register(provider: AgentProvider): void {
    if (this.#providers.has(provider.id)) {
      throw new Error(`Provider "${provider.id}" is already registered`);
    }
    this.#providers.set(provider.id, provider);
  }

  get(id: string): AgentProvider | undefined {
    return this.#providers.get(id);
  }

  getOrThrow(id: string): AgentProvider {
    const p = this.#providers.get(id);
    if (!p) throw new Error(`Provider "${id}" not found. Registered: ${[...this.#providers.keys()].join(", ")}`);
    return p;
  }

  list(): AgentProvider[] {
    return [...this.#providers.values()];
  }
}
