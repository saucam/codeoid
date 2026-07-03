/**
 * Model catalog + resolver tests — the layer everything else sits on.
 * Also covers Store persistence of session.model / fallback_model so the
 * choice survives daemon restart.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_CATALOG,
  findModel,
  resolveModelId,
  DEFAULT_MODEL_ALIAS,
  fallbackModelInfos,
  resolveAgainstList,
} from "../daemon/models.js";
import { Store } from "../daemon/store.js";
import { SessionManager } from "../daemon/session-manager.js";
import { TranscriptStore } from "../daemon/transcript.js";

describe("resolveAgainstList (live-backend resolution)", () => {
  const live = [
    { value: "default", displayName: "Default (recommended)", isDefault: true },
    { value: "opus[1m]", displayName: "Opus" },
    { value: "sonnet", displayName: "Sonnet" },
  ];

  it("matches an exact value", () => {
    expect(resolveAgainstList("opus[1m]", live)).toBe("opus[1m]");
  });
  it("matches a display name case-insensitively (alias-like)", () => {
    expect(resolveAgainstList("opus", live)).toBe("opus[1m]");
    expect(resolveAgainstList("OPUS", live)).toBe("opus[1m]");
  });
  it("passes through a full claude-* id", () => {
    expect(resolveAgainstList("claude-fable-5[1m]", live)).toBe("claude-fable-5[1m]");
  });
  it("returns null for an unknown value", () => {
    expect(resolveAgainstList("o", live)).toBeNull();
    expect(resolveAgainstList("", live)).toBeNull();
  });
});

describe("fallbackModelInfos", () => {
  it("renders the built-in catalog as ModelInfo with a default", () => {
    const infos = fallbackModelInfos();
    expect(infos.length).toBe(MODEL_CATALOG.length);
    expect(infos.some((m) => m.isDefault)).toBe(true);
    expect(infos.every((m) => m.value && m.displayName)).toBe(true);
  });
});

describe("MODEL_CATALOG shape", () => {
  it("covers the three canonical tiers", () => {
    expect(MODEL_CATALOG.length).toBeGreaterThanOrEqual(3);
    const tiers = new Set(MODEL_CATALOG.map((m) => m.tier));
    expect(tiers.has("premium")).toBe(true);
    expect(tiers.has("balanced")).toBe(true);
    expect(tiers.has("fast")).toBe(true);
  });

  it("all entries have distinct aliases + ids", () => {
    const aliases = new Set(MODEL_CATALOG.map((m) => m.alias));
    const ids = new Set(MODEL_CATALOG.map((m) => m.id));
    expect(aliases.size).toBe(MODEL_CATALOG.length);
    expect(ids.size).toBe(MODEL_CATALOG.length);
  });

  it("default alias resolves to a real model", () => {
    expect(findModel(DEFAULT_MODEL_ALIAS)).not.toBeNull();
  });
});

describe("findModel + resolveModelId", () => {
  it("resolves known aliases case-insensitively", () => {
    expect(findModel("opus")?.id).toMatch(/^claude-opus-/);
    expect(findModel("OPUS")?.id).toMatch(/^claude-opus-/);
    expect(findModel("Opus")?.id).toMatch(/^claude-opus-/);
  });

  it("resolves full ids to themselves", () => {
    const known = MODEL_CATALOG[0]!;
    expect(findModel(known.id)?.id).toBe(known.id);
    expect(resolveModelId(known.id)).toBe(known.id);
  });

  it("returns null only for empty input; otherwise passes through", () => {
    // resolveModelId no longer gatekeeps unknown values — the daemon validates
    // against the live backend catalog (resolveAgainstList) instead. Unknown
    // non-empty input passes through; the SDK is the final validator.
    expect(findModel("gpt-5")).toBeNull(); // still not in the built-in catalog
    expect(resolveModelId("gpt-5")).toBe("gpt-5");
    expect(resolveModelId("")).toBeNull();
    expect(resolveModelId("   ")).toBeNull();
  });

  it("passthrough accepts any claude-* id not in our catalog", () => {
    // Hypothetical future model — don't gatekeep.
    expect(resolveModelId("claude-opus-4-9-hypothetical")).toBe(
      "claude-opus-4-9-hypothetical",
    );
    expect(findModel("claude-opus-4-9-hypothetical")).toBeNull(); // but not in catalog
  });

  it("handles empty / whitespace input", () => {
    expect(resolveModelId("")).toBeNull();
    expect(resolveModelId("   ")).toBeNull();
    expect(findModel("")).toBeNull();
  });

  it("trims whitespace around aliases", () => {
    expect(resolveModelId("  sonnet  ")).toMatch(/^claude-sonnet-/);
  });
});

describe("Store session.model persistence", () => {
  let tmp: string;
  let store: Store;
  const sessionId = "sess_model_test";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-model-"));
    store = new Store(join(tmp, "codeoid.db"));
    store.createSession({
      id: sessionId,
      name: "test",
      workdir: "/tmp",
      status: "idle",
      createdBy: "user",
      createdAt: new Date().toISOString(),
      attachedClients: 0,
      accountId: "acc",
      projectId: "proj",
    });
  });

  afterEach(() => {
    try { store.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("initial state: both null", () => {
    const { model, fallbackModel } = store.getSessionModel(sessionId);
    expect(model).toBeNull();
    expect(fallbackModel).toBeNull();
  });

  it("setSessionModel(id, model) leaves fallback untouched", () => {
    store.setSessionModel(sessionId, "claude-opus-4-7", "claude-sonnet-4-6");
    expect(store.getSessionModel(sessionId).fallbackModel).toBe("claude-sonnet-4-6");
    // Update ONLY the primary — fallback preserved.
    store.setSessionModel(sessionId, "claude-haiku-4-5-20251001");
    const after = store.getSessionModel(sessionId);
    expect(after.model).toBe("claude-haiku-4-5-20251001");
    expect(after.fallbackModel).toBe("claude-sonnet-4-6");
  });

  it("setSessionModel(id, model, null) clears fallback", () => {
    store.setSessionModel(sessionId, "claude-opus-4-7", "claude-sonnet-4-6");
    store.setSessionModel(sessionId, "claude-opus-4-7", null);
    expect(store.getSessionModel(sessionId).fallbackModel).toBeNull();
  });

  it("setSessionModel(id, null) clears the primary model", () => {
    store.setSessionModel(sessionId, "claude-opus-4-7");
    store.setSessionModel(sessionId, null);
    expect(store.getSessionModel(sessionId).model).toBeNull();
  });

  it("survives daemon restart (reopen = same state)", () => {
    store.setSessionModel(sessionId, "claude-opus-4-7", "claude-sonnet-4-6");
    store.close();

    const reopened = new Store(join(tmp, "codeoid.db"));
    const got = reopened.getSessionModel(sessionId);
    expect(got.model).toBe("claude-opus-4-7");
    expect(got.fallbackModel).toBe("claude-sonnet-4-6");
    reopened.close();
  });
});

// ── Persisted live model catalog (models.list fallback tiering) ──────────────

describe("model catalog persistence (Store)", () => {
  let tmp: string;
  let store: Store;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-modelcat-"));
    store = new Store(join(tmp, "codeoid.db"));
  });

  afterEach(() => {
    try { store.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("returns null before any catalog was saved", () => {
    expect(store.getModelCatalog()).toBeNull();
  });

  it("round-trips a saved catalog", () => {
    const models = [
      { value: "default", displayName: "Default (recommended)", isDefault: true },
      { value: "fable", displayName: "Fable 5", isDefault: false },
    ];
    store.saveModelCatalog(models);
    expect(store.getModelCatalog()).toEqual(models);
  });

  it("upserts — the latest save wins", () => {
    store.saveModelCatalog([{ value: "a", displayName: "A", isDefault: false }]);
    store.saveModelCatalog([{ value: "b", displayName: "B", isDefault: true }]);
    const got = store.getModelCatalog();
    expect(got).toHaveLength(1);
    expect(got?.[0]?.value).toBe("b");
  });

  it("survives a store reopen (new daemon lifetime)", () => {
    store.saveModelCatalog([{ value: "opus", displayName: "Opus 4.8", isDefault: true }]);
    store.close();
    const reopened = new Store(join(tmp, "codeoid.db"));
    expect(reopened.getModelCatalog()?.[0]?.displayName).toBe("Opus 4.8");
    reopened.close();
  });
});

describe("models.list serves live → persisted → baked-in fallback", () => {
  let tmp: string;
  let store: Store;

  const AUTH = {
    sub: "user:models-test",
    scopes: [],
    delegationDepth: 0,
    accountId: "acc",
    projectId: "proj",
  };

  const LIVE = [
    { value: "default", displayName: "Default (recommended)" },
    { value: "fable", displayName: "Fable 5" },
    { value: "opus", displayName: "Opus 4.8" },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-modeltier-"));
    store = new Store(join(tmp, "codeoid.db"));
  });

  afterEach(() => {
    try { store.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  async function listModels(manager: SessionManager) {
    const client = { id: "client-models-test", auth: AUTH, send: () => {} };
    const res = (await manager.handle(
      { type: "models.list", id: "req-models" },
      AUTH,
      client,
    )) as { type: string; models: { value: string; displayName: string }[]; live: boolean };
    expect(res.type).toBe("models.list.result");
    return res;
  }

  it("first-ever boot: baked-in fallback, live=false", async () => {
    const manager = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    const res = await listModels(manager);
    expect(res.live).toBe(false);
    expect(res.models.map((m) => m.value)).toEqual(
      fallbackModelInfos().map((m) => m.value),
    );
  });

  it("after a session reports models: live=true and the list is persisted", async () => {
    const manager = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    (manager as unknown as { _cacheModels(m: typeof LIVE): void })._cacheModels(LIVE);

    const res = await listModels(manager);
    expect(res.live).toBe(true);
    expect(res.models.map((m) => m.value)).toEqual(["default", "fable", "opus"]);
    expect(store.getModelCatalog()?.map((m) => m.value)).toEqual([
      "default",
      "fable",
      "opus",
    ]);
  });

  it("next boot before any turn: persisted list served, live=false", async () => {
    const first = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    (first as unknown as { _cacheModels(m: typeof LIVE): void })._cacheModels(LIVE);

    // Fresh manager = fresh daemon lifetime, same store.
    const second = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    const res = await listModels(second);
    expect(res.live).toBe(false); // clients keep refetching until live
    expect(res.models.map((m) => m.value)).toEqual(["default", "fable", "opus"]);
  });

  it("first live report wins for the lifetime; empty reports are ignored", async () => {
    const manager = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    const cache = manager as unknown as { _cacheModels(m: unknown[]): void };
    cache._cacheModels([]);
    expect((await listModels(manager)).live).toBe(false);
    cache._cacheModels(LIVE);
    cache._cacheModels([{ value: "other", displayName: "Other" }]);
    const res = await listModels(manager);
    expect(res.models.map((m) => m.value)).toEqual(["default", "fable", "opus"]);
  });
});
