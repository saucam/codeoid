/**
 * ProviderRegistry — the daemon's catalog of session backends.
 *
 * Providers are SESSION-scoped (each session gets its own instance: warm
 * providers hold a live backing loop; stateless ones hold per-session
 * config), so the registry holds FACTORIES, not instances. The registry is
 * built once at daemon startup (`createDefaultProviderRegistry()`), shared
 * by the SessionManager, and consulted on every session construction —
 * replacing the hardcoded provider `switch` that used to live in Session.
 *
 * Adding a backend = one `ProviderFactory` + one `register()` call; nothing
 * in Session/SessionManager changes.
 */

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "../store.js";
import type { AgentIdentityManager } from "../agent-identity.js";
import type { MemoryEngine } from "../memory/index.js";
import type { CompressionRegistry } from "../compress/index.js";
import type { CodeoidConfig } from "../../config.js";
import type { SessionProvider } from "./interface.js";
import { ClaudeProvider } from "./claude/index.js";
import { GeminiProvider } from "./gemini/index.js";
import { OpenAIProvider } from "./openai/index.js";
import { StatelessSessionProvider } from "./stateless.js";

/**
 * Everything a factory may need to construct a provider for ONE session.
 * A superset across backends — each factory picks what it uses (the shape
 * mirrors `ClaudeProviderInit`, the most demanding consumer).
 */
export interface ProviderSessionInit {
  sessionId: string;
  /** Tenant-scoped memory workspace id (computed once by Session). */
  workspaceId: string;
  /** Resolved model id for this session, or null for the provider default. */
  model: string | null;
  /** Persisted backing id from Store, or the session id itself on first run. */
  initialBackingId: string;
  store: Store;
  identityManager?: AgentIdentityManager;
  memory?: MemoryEngine;
  /** codeoid_fleet MCP server — conductor sessions only. */
  fleet?: McpSdkServerConfigWithInstance;
  config?: CodeoidConfig;
  compressionRegistry?: CompressionRegistry;
  /** Live model-catalog report, already tagged with the factory's id by Session. */
  onModels?: (
    models: ReadonlyArray<{ value: string; displayName: string; description?: string }>,
  ) => void;
}

export interface ProviderFactory {
  /** Stable provider id ("claude" | "gemini" | "openai" | ...). */
  readonly id: string;
  readonly displayName: string;
  create(init: ProviderSessionInit): SessionProvider;
}

export class ProviderRegistry {
  readonly #factories = new Map<string, ProviderFactory>();
  /** Id used when a session doesn't carry a provider selection. */
  readonly defaultId: string;

  constructor(defaultId = "claude") {
    this.defaultId = defaultId;
  }

  register(factory: ProviderFactory): void {
    if (this.#factories.has(factory.id)) {
      throw new Error(`Provider "${factory.id}" is already registered`);
    }
    this.#factories.set(factory.id, factory);
  }

  has(id: string): boolean {
    return this.#factories.has(id);
  }

  get(id: string): ProviderFactory | undefined {
    return this.#factories.get(id);
  }

  getOrThrow(id: string): ProviderFactory {
    const f = this.#factories.get(id);
    if (!f) {
      throw new Error(
        `Provider "${id}" not found. Registered: ${[...this.#factories.keys()].join(", ")}`,
      );
    }
    return f;
  }

  list(): ProviderFactory[] {
    return [...this.#factories.values()];
  }

  ids(): string[] {
    return [...this.#factories.keys()];
  }

  /**
   * Resolve a session's provider selection to a factory. Unknown ids warn
   * and fall back to the default rather than throw — resume must survive a
   * session meta written by a newer codeoid that knew more providers.
   */
  resolve(id: string | undefined, logContext: string): ProviderFactory {
    const requested = id ?? this.defaultId;
    const factory = this.#factories.get(requested);
    if (factory) return factory;
    console.error(
      `[codeoid/${logContext}] unknown provider "${requested}" — falling back to ${this.defaultId}`,
    );
    return this.getOrThrow(this.defaultId);
  }
}

/** The built-in backends. Daemon startup builds exactly one of these. */
export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry("claude");
  registry.register({
    id: "claude",
    displayName: "Claude (Anthropic)",
    create: (init) =>
      new ClaudeProvider({
        sessionId: init.sessionId,
        initialBackingId: init.initialBackingId,
        workspaceId: init.workspaceId,
        store: init.store,
        identityManager: init.identityManager,
        memory: init.memory,
        fleet: init.fleet,
        config: init.config,
        compressionRegistry: init.compressionRegistry,
        onModels: init.onModels,
      }),
  });
  registry.register({
    id: "gemini",
    displayName: "Gemini (Google)",
    create: (init) =>
      new StatelessSessionProvider(
        new GeminiProvider({ defaultModel: init.model ?? undefined }),
        init.sessionId,
      ),
  });
  registry.register({
    id: "openai",
    displayName: "OpenAI",
    create: (init) =>
      new StatelessSessionProvider(
        new OpenAIProvider({ defaultModel: init.model ?? undefined }),
        init.sessionId,
      ),
  });
  return registry;
}
