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
