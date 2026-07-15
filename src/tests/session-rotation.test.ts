/**
 * Session rotation tests — threshold logic, persistence, seed-prompt shape.
 *
 * The Session class is entangled with the Claude Agent SDK (spawns a
 * subprocess query), so unit-testing `send()` end-to-end is impractical.
 * Here we target the deterministic logic: shouldRotate thresholds,
 * rotation seed construction, Store persistence + counters.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../daemon/store.js";
import { renderRotationSeed } from "../daemon/providers/context-strategy.js";

let tmp: string;
let store: Store;
let sessionId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-rotate-"));
  store = new Store(join(tmp, "codeoid.db"));
  sessionId = `sess_${Math.random().toString(36).slice(2, 10)}`;
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

// ── Store persistence ───────────────────────────────────────────────────

describe("Store rotation columns", () => {
  it("initial state: no backing id, count=0, last=null", () => {
    expect(store.getClaudeCodeSessionId(sessionId)).toBeNull();
    const stats = store.getRotationStats(sessionId);
    expect(stats.count).toBe(0);
    expect(stats.lastRotatedAt).toBeNull();
  });

  it("setClaudeCodeSessionId without delta leaves count intact", () => {
    store.setClaudeCodeSessionId(sessionId, "backing-1");
    expect(store.getClaudeCodeSessionId(sessionId)).toBe("backing-1");
    expect(store.getRotationStats(sessionId).count).toBe(0);
  });

  it("setClaudeCodeSessionId with delta=1 increments count + stamps time", () => {
    const t = 1_700_000_000_000;
    store.setClaudeCodeSessionId(sessionId, "backing-2", 1, t);
    const s = store.getRotationStats(sessionId);
    expect(s.count).toBe(1);
    expect(s.lastRotatedAt).toBe(t);

    // Next rotation bumps count, updates timestamp.
    store.setClaudeCodeSessionId(sessionId, "backing-3", 1, t + 5000);
    const s2 = store.getRotationStats(sessionId);
    expect(s2.count).toBe(2);
    expect(s2.lastRotatedAt).toBe(t + 5000);
    expect(store.getClaudeCodeSessionId(sessionId)).toBe("backing-3");
  });

  it("migration is idempotent — reopening the DB reads persisted rotation state", () => {
    const t = 1_700_000_999_999;
    store.setClaudeCodeSessionId(sessionId, "backing-X", 3, t);
    store.close();

    // Simulate daemon restart — same file, fresh Store instance.
    const reopened = new Store(join(tmp, "codeoid.db"));
    expect(reopened.getClaudeCodeSessionId(sessionId)).toBe("backing-X");
    expect(reopened.getRotationStats(sessionId).count).toBe(3);
    expect(reopened.getRotationStats(sessionId).lastRotatedAt).toBe(t);
    reopened.close();
  });
});

// ── Threshold + seed logic (reimplemented on fresh module to avoid
//    needing a full Session instance just to poke private methods) ───────

import type { CodeoidConfig } from "../config.js";

function mkAutoRotate(
  overrides: Partial<CodeoidConfig["autoRotate"]> = {},
): CodeoidConfig["autoRotate"] {
  return {
    enabled: false,
    warnPct: 0.6,
    rotatePct: 0.8,
    hardRotatePct: 0.9,
    minTurnsBeforeRotate: 3,
    strategy: "task-anchor",
    ...overrides,
  };
}

/**
 * Mirror of Session#shouldRotate logic. Mirror rather than reach-in: the
 * private method is small + stable, and copying it here lets us test the
 * intent without the SDK dependency. If the real method changes,
 * intentionally break this test so the behavior is re-reviewed.
 */
function shouldRotate(
  ar: CodeoidConfig["autoRotate"],
  lastTurnInputTokens: number,
  numTurns: number,
  contextWindow = 1_000_000,
): boolean {
  if (lastTurnInputTokens <= 0) return false;
  const pct = lastTurnInputTokens / contextWindow;
  if (pct >= ar.hardRotatePct && numTurns >= ar.minTurnsBeforeRotate) return true;
  if (!ar.enabled) return false;
  if (numTurns < ar.minTurnsBeforeRotate) return false;
  return pct >= ar.rotatePct;
}

describe("shouldRotate threshold logic", () => {
  it("never rotates without any usage yet", () => {
    expect(shouldRotate(mkAutoRotate({ enabled: true }), 0, 5)).toBe(false);
  });

  it("respects min-turns guard", () => {
    const ar = mkAutoRotate({ enabled: true, rotatePct: 0.5, minTurnsBeforeRotate: 5 });
    // 70% occupancy, only 2 turns — too early to rotate.
    expect(shouldRotate(ar, 700_000, 2)).toBe(false);
    expect(shouldRotate(ar, 700_000, 5)).toBe(true);
  });

  it("auto-rotate disabled → no rotation even above soft threshold", () => {
    const ar = mkAutoRotate({ enabled: false, rotatePct: 0.5 });
    expect(shouldRotate(ar, 700_000, 10)).toBe(false);
  });

  it("hard ceiling rotates even when disabled (safety net)", () => {
    const ar = mkAutoRotate({ enabled: false, hardRotatePct: 0.9 });
    expect(shouldRotate(ar, 900_000, 10)).toBe(true);
    expect(shouldRotate(ar, 899_999, 10)).toBe(false);
  });

  it("hard ceiling still respects min-turns", () => {
    const ar = mkAutoRotate({
      enabled: false,
      hardRotatePct: 0.9,
      minTurnsBeforeRotate: 5,
    });
    expect(shouldRotate(ar, 950_000, 2)).toBe(false); // under min
    expect(shouldRotate(ar, 950_000, 5)).toBe(true);  // at min
  });

  it("rotatePct honored when enabled + over min", () => {
    const ar = mkAutoRotate({ enabled: true, rotatePct: 0.7, minTurnsBeforeRotate: 3 });
    expect(shouldRotate(ar, 699_999, 5)).toBe(false);
    expect(shouldRotate(ar, 700_000, 5)).toBe(true);
  });
});

// ── Seed prompt shape ───────────────────────────────────────────────────

// Exercises the REAL exported renderer (Session#buildRotationSeed delegates to
// it) — not a hand-mirrored copy — so the seed's actual shape is what's tested.
describe("rotation seed prompt", () => {
  it("advertises all four recall tools, including get_episode for by-id paging", () => {
    const seed = renderRotationSeed({
      workdir: "/Workspace/codeoid",
      sessionName: "test",
      rotationCount: 1,
      lastUserTurn: "refactor the auth module",
    });
    expect(seed).toContain("`recall(query)`");
    expect(seed).toContain("`recall_file(path)`");
    expect(seed).toContain("`timeline(offset?, limit?)`");
    expect(seed).toContain("`get_episode(episode_id)`");
  });

  it("includes the workspace path + rotation count", () => {
    const seed = renderRotationSeed({
      workdir: "/Workspace/codeoid",
      sessionName: "test",
      rotationCount: 7,
      lastUserTurn: null,
    });
    expect(seed).toContain("/Workspace/codeoid");
    expect(seed).toContain("Rotation #7");
  });

  it("truncates very long last-user-turn content", () => {
    const long = "x".repeat(5000);
    const seed = renderRotationSeed({
      workdir: "/tmp",
      sessionName: "test",
      rotationCount: 1,
      lastUserTurn: long,
    });
    expect(seed).toContain("…");
    expect(seed.length).toBeLessThan(5000);
  });

  it("degrades gracefully when memory is unavailable", () => {
    const seed = renderRotationSeed({
      workdir: "/tmp",
      sessionName: "test",
      rotationCount: 1,
      lastUserTurn: null,
    });
    expect(seed).toContain("memory disabled");
    expect(seed).toContain("<rotation_context>");
    expect(seed).toContain("</rotation_context>");
  });
});
