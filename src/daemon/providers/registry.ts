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
import { PiProvider } from "./pi/index.js";
import { PI_INSTALL_HINT, resolvePiCommand } from "./pi/resolve.js";
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
  /**
   * Backends codeoid supports but could not activate at startup (binary
   * missing, etc.) — id → actionable hint. Lets `session.set_provider`
   * answer "supported but not installed, here's how" instead of a bare
   * "unknown provider".
   */
  readonly #unavailable = new Map<string, string>();
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

  /** Record a supported-but-unactivatable backend with an actionable hint. */
  markUnavailable(id: string, hint: string): void {
    this.#unavailable.set(id, hint);
  }

  /** Hint for a supported backend that isn't activated, if any. */
  unavailableHint(id: string): string | undefined {
    return this.#unavailable.get(id);
  }

  /** All supported-but-unactivated backends (startup diagnostics). */
  unavailableEntries(): Array<{ id: string; hint: string }> {
    return [...this.#unavailable.entries()].map(([id, hint]) => ({ id, hint }));
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
    console.warn(
      `[codeoid/${logContext}] unknown provider "${requested}" — falling back to ${this.defaultId}`,
    );
    return this.getOrThrow(this.defaultId);
  }
}

/**
 * The built-in backends. Daemon startup builds exactly one of these.
 * `config` gates optional backends (pi can be disabled) and carries their
 * settings (binary path); absent = every backend with defaults.
 */
export function createDefaultProviderRegistry(config?: CodeoidConfig): ProviderRegistry {
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
  if (config?.providers?.pi?.enabled !== false) {
    // Resolve once at startup: explicit config command → system PATH →
    // the bundled optionalDependency (see pi/resolve.ts). A verified
    // resolution means picking pi can't fail on a missing binary; no
    // resolution means the catalog says "not installed" with the fix.
    const configured = config?.providers?.pi?.command;
    const resolution = resolvePiCommand(configured === "pi" ? undefined : configured);
    if (resolution) {
      registry.register({
        id: "pi",
        displayName: "pi (pi.dev)",
        create: (init) =>
          new PiProvider({
            sessionId: init.sessionId,
            initialBackingId: init.initialBackingId,
            command: resolution.command,
            argsPrefix: resolution.argsPrefix,
            store: init.store,
            onModels: init.onModels,
          }),
      });
    } else {
      registry.markUnavailable(
        "pi",
        configured !== undefined && configured !== "pi"
          ? `providers.pi.command (${JSON.stringify(configured)}) does not exist or is not on PATH`
          : PI_INSTALL_HINT,
      );
    }
  }
  return registry;
}
