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
  return {
    sessionId: "s1",
    workspaceId: "ws1",
    model: null,
    initialBackingId: "s1",
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

  it("default catalog registers claude, gemini, openai with claude as default", () => {
    const registry = createDefaultProviderRegistry();
    expect(registry.ids().sort()).toEqual(["claude", "gemini", "openai"]);
    expect(registry.defaultId).toBe("claude");
  });

  it("stateless factories construct providers with the right ids", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-registry-"));
    const store = new Store(join(tmp, "codeoid.db"));
    try {
      const registry = createDefaultProviderRegistry();
      const init = makeInit(store);

      const gemini = registry.getOrThrow("gemini").create(init);
      expect(gemini.id).toBe("gemini");
      expect(gemini.backingSessionId).toBe("s1");

      const openai = registry.getOrThrow("openai").create(init);
      expect(openai.id).toBe("openai");
    } finally {
      try { store.close(); } catch {}
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });
});
