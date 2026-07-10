/**
 * ProviderRegistry — the daemon's provider catalog (factories, not
 * instances). Covers registration invariants, resolve() fallback semantics
 * (resume must survive unknown provider ids from a newer codeoid), and the
 * default catalog's stateless factories. The claude factory is registered
 * but not exercised here — constructing ClaudeProvider is covered by
 * provider-claude.test.ts; these tests stay SDK-free.
 */

import { describe, expect, it } from "bun:test";
import {
  createDefaultProviderRegistry,
  ProviderRegistry,
  type ProviderFactory,
  type ProviderSessionInit,
} from "../daemon/providers/registry.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { Store } from "../daemon/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mockFactory(id: string): ProviderFactory {
  return {
    id,
    displayName: `Mock ${id}`,
    create: () => new MockSessionProvider(id),
  };
}

function makeInit(store: Store): ProviderSessionInit {
  // sessionId and initialBackingId deliberately differ so assertions prove
  // WHICH field feeds each provider surface (stateless providers label
  // themselves with the codeoid session id, not the backing id).
  return {
    sessionId: "s1",
    workspaceId: "ws1",
    model: null,
    initialBackingId: "backing-9",
    store,
  };
}

describe("ProviderRegistry", () => {
  it("registers, lists, and resolves factories", () => {
    const registry = new ProviderRegistry("alpha");
    registry.register(mockFactory("alpha"));
    registry.register(mockFactory("beta"));

    expect(registry.ids().sort()).toEqual(["alpha", "beta"]);
    expect(registry.has("beta")).toBe(true);
    expect(registry.get("beta")?.displayName).toBe("Mock beta");
    expect(registry.getOrThrow("alpha").id).toBe("alpha");
    expect(registry.list()).toHaveLength(2);
  });

  it("rejects duplicate registration", () => {
    const registry = new ProviderRegistry();
    registry.register(mockFactory("claude"));
    expect(() => registry.register(mockFactory("claude"))).toThrow(/already registered/);
  });

  it("getOrThrow names the registered ids on a miss", () => {
    const registry = new ProviderRegistry();
    registry.register(mockFactory("alpha"));
    expect(() => registry.getOrThrow("nope")).toThrow(/alpha/);
  });

  it("resolve() falls back to the default for unknown ids (resume forward-compat)", () => {
    const registry = new ProviderRegistry("alpha");
    registry.register(mockFactory("alpha"));
    registry.register(mockFactory("beta"));

    expect(registry.resolve("beta", "test").id).toBe("beta");
    expect(registry.resolve(undefined, "test").id).toBe("alpha");
    // Unknown → warn + default, never throw.
    expect(registry.resolve("pi-from-the-future", "test").id).toBe("alpha");
  });

  it("default catalog registers claude, gemini, openai, pi, gemini-cli with claude as default", () => {
    const registry = createDefaultProviderRegistry();
    // pi + gemini-cli are BUNDLED (always activate); codex is PATH-dependent,
    // so assert membership rather than the exact machine-dependent set.
    for (const id of ["claude", "gemini", "openai", "pi", "gemini-cli"]) {
      expect(registry.has(id)).toBe(true);
    }
    expect(registry.defaultId).toBe("claude");
  });

  it("config can disable the pi backend", () => {
    const registry = createDefaultProviderRegistry({
      providers: { pi: { enabled: false, command: "pi" } },
    } as unknown as Parameters<typeof createDefaultProviderRegistry>[0]);
    expect(registry.has("pi")).toBe(false);
    for (const id of ["claude", "gemini", "openai"]) {
      expect(registry.has(id)).toBe(true);
    }
  });

  it("the pi factory constructs a provider labeled with the codeoid session id", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-registry-pi-"));
    const store = new Store(join(tmp, "codeoid.db"));
    try {
      const registry = createDefaultProviderRegistry();
      const pi = registry.getOrThrow("pi").create(makeInit(store));
      expect(pi.id).toBe("pi");
      // No pi session file yet — the backing id starts as the init value
      // and is replaced by the real file on first spawn.
      expect(pi.backingSessionId).toBe("backing-9");
    } finally {
      try { store.close(); } catch {}
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });

  it("stateless factories construct providers with the right ids", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-registry-"));
    const store = new Store(join(tmp, "codeoid.db"));
    try {
      const registry = createDefaultProviderRegistry();
      const init = makeInit(store);

      const gemini = registry.getOrThrow("gemini").create(init);
      expect(gemini.id).toBe("gemini");
      // Stateless providers use the codeoid session id as their display
      // label — NOT initialBackingId (that's for warm providers).
      expect(gemini.backingSessionId).toBe("s1");

      const openai = registry.getOrThrow("openai").create(init);
      expect(openai.id).toBe("openai");
    } finally {
      try { store.close(); } catch {}
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });
});
