/**
 * Memory index tests — exercise the three pieces that make Layer C work:
 *   1. SqliteEpisodeStore aggregate queries (workspaceStats, hotFiles, sessionSummaries)
 *   2. buildWorkspaceIndex — markdown output shape + truncation
 *   3. IndexScheduler — hybrid trigger (hard / timed / debounce)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SqliteEpisodeStore,
  buildWorkspaceIndex,
  IndexScheduler,
  MAX_INDEX_BYTES,
} from "../daemon/memory/index.js";

let tmp: string;
let dbPath: string;
let store: SqliteEpisodeStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-index-"));
  dbPath = join(tmp, "memory.db");
  store = new SqliteEpisodeStore(dbPath);
});

afterEach(() => {
  try {
    store.close();
  } catch {}
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

const WS = "ws_test";

function insertEpisode(
  overrides: Partial<{
    sessionId: string;
    kind: "user_turn" | "assistant_turn" | "tool_call";
    toolName: string;
    summary: string;
    content: string;
    filePaths: string[];
    createdAt: number;
  }> = {},
): void {
  store.insert({
    workspaceId: WS,
    sessionId: overrides.sessionId ?? "sess1",
    kind: overrides.kind ?? "tool_call",
    toolName: overrides.toolName ?? "Read",
    summary: overrides.summary ?? "Read src/foo.ts",
    content: overrides.content ?? "contents",
    filePaths: overrides.filePaths ?? ["src/foo.ts"],
    tokenEstimate: 50,
    createdAt: overrides.createdAt ?? Date.now(),
    createdBy: "user:test",
  });
}

describe("SqliteEpisodeStore aggregate queries", () => {
  it("workspaceStats returns counts + min/max timestamps", () => {
    const empty = store.workspaceStats(WS);
    expect(empty.episodeCount).toBe(0);
    expect(empty.sessionCount).toBe(0);
    expect(empty.firstCreatedAt).toBeNull();

    const t0 = 1_000_000;
    insertEpisode({ sessionId: "s1", createdAt: t0 });
    insertEpisode({ sessionId: "s1", createdAt: t0 + 100 });
    insertEpisode({ sessionId: "s2", createdAt: t0 + 200 });

    const stats = store.workspaceStats(WS);
    expect(stats.episodeCount).toBe(3);
    expect(stats.sessionCount).toBe(2);
    expect(stats.firstCreatedAt).toBe(t0);
    expect(stats.lastCreatedAt).toBe(t0 + 200);
  });

  it("hotFiles aggregates file_paths across episodes via json_each", () => {
    // file A touched 3 times, file B twice, file C once.
    insertEpisode({ filePaths: ["src/a.ts"] });
    insertEpisode({ filePaths: ["src/a.ts"] });
    insertEpisode({ filePaths: ["src/a.ts", "src/b.ts"] });
    insertEpisode({ filePaths: ["src/b.ts"] });
    insertEpisode({ filePaths: ["src/c.ts"] });

    const hot = store.hotFiles(WS, 10);
    expect(hot.length).toBe(3);
    expect(hot[0]!.path).toBe("src/a.ts");
    expect(hot[0]!.touches).toBe(3);
    expect(hot[1]!.path).toBe("src/b.ts");
    expect(hot[1]!.touches).toBe(2);
    expect(hot[2]!.path).toBe("src/c.ts");
    expect(hot[2]!.touches).toBe(1);
  });

  it("hotFiles honors the limit", () => {
    insertEpisode({ filePaths: ["a"] });
    insertEpisode({ filePaths: ["b"] });
    insertEpisode({ filePaths: ["c"] });
    expect(store.hotFiles(WS, 2).length).toBe(2);
  });

  it("sessionSummaries prefers the first user_turn summary per session", () => {
    const t = Date.now();
    insertEpisode({
      sessionId: "s1",
      kind: "tool_call",
      summary: "Read src/foo.ts",
      createdAt: t,
    });
    insertEpisode({
      sessionId: "s1",
      kind: "user_turn",
      summary: "fix the auth bug",
      createdAt: t + 100, // Later chronologically, but user_turn wins
    });
    insertEpisode({
      sessionId: "s2",
      kind: "assistant_turn",
      summary: "something else",
      createdAt: t + 200,
    });

    const summaries = store.sessionSummaries(WS, 10);
    expect(summaries.length).toBe(2);
    // Most-recent session first (s2).
    expect(summaries[0]!.sessionId).toBe("s2");
    // s1's first_summary is its user_turn (by preference), not the tool_call.
    const s1 = summaries.find((s) => s.sessionId === "s1")!;
    expect(s1.firstSummary).toBe("fix the auth bug");
  });

  it("sessionSummaries falls back when no user_turn exists", () => {
    insertEpisode({
      sessionId: "s1",
      kind: "tool_call",
      summary: "first tool call",
      createdAt: 1_000,
    });
    insertEpisode({
      sessionId: "s1",
      kind: "tool_call",
      summary: "second tool call",
      createdAt: 2_000,
    });
    const summaries = store.sessionSummaries(WS, 10);
    expect(summaries[0]!.firstSummary).toBe("first tool call");
  });
});

describe("buildWorkspaceIndex", () => {
  it("returns an empty string for empty workspaces", () => {
    const out = buildWorkspaceIndex({
      store,
      workspaceId: WS,
      currentSessionId: "sess1",
    });
    expect(out).toBe("");
  });

  it("renders a header with fingerprint counts", () => {
    insertEpisode({ sessionId: "s1", filePaths: ["a.ts"] });
    insertEpisode({ sessionId: "s2", filePaths: ["b.ts"] });
    const out = buildWorkspaceIndex({
      store,
      workspaceId: WS,
      workdir: "/Workspace/codeoid",
      currentSessionId: "s1",
    });
    expect(out).toContain("# Memory Index — /Workspace/codeoid");
    expect(out).toContain("2 episodes across 2 sessions");
  });

  it("includes hot-files section with counts + recall_file guidance", () => {
    insertEpisode({ filePaths: ["src/foo.ts"] });
    insertEpisode({ filePaths: ["src/foo.ts"] });
    insertEpisode({ filePaths: ["src/bar.ts"] });
    const out = buildWorkspaceIndex({
      store,
      workspaceId: WS,
      currentSessionId: "s1",
    });
    expect(out).toContain("## Hot files");
    expect(out).toContain("recall_file");
    expect(out).toContain("src/foo.ts — 2 touches");
    expect(out).toContain("src/bar.ts — 1 touch");
  });

  it("marks the current session with [current] tag", () => {
    insertEpisode({ sessionId: "s1", kind: "user_turn", summary: "task A" });
    insertEpisode({ sessionId: "s2", kind: "user_turn", summary: "task B" });
    const out = buildWorkspaceIndex({
      store,
      workspaceId: WS,
      currentSessionId: "s2",
    });
    // s2 is most recent AND the current session.
    expect(out).toMatch(/\[current\] task B/);
  });

  it("includes the recall shortcuts section verbatim (stable text)", () => {
    insertEpisode({});
    const out = buildWorkspaceIndex({
      store,
      workspaceId: WS,
      currentSessionId: "s1",
    });
    expect(out).toContain("## Recall shortcuts");
    expect(out).toContain('`recall("<topic>")`');
    expect(out).toContain('`recall_file("<path>")`');
    expect(out).toContain("`timeline()`");
  });

  it("truncates when output exceeds maxBytes", () => {
    // Insert many distinct files so the hot-files block balloons.
    for (let i = 0; i < 60; i++) {
      insertEpisode({ filePaths: [`src/deep/nested/path/file-${i}.ts`] });
    }
    const out = buildWorkspaceIndex(
      {
        store,
        workspaceId: WS,
        currentSessionId: "s1",
      },
      { hotFiles: 60, maxBytes: 500 },
    );
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain("(index truncated)");
  });

  it("default budget is ≤ MAX_INDEX_BYTES on modest workspaces", () => {
    for (let i = 0; i < 30; i++) {
      insertEpisode({ sessionId: `s${i % 5}`, filePaths: [`src/f${i}.ts`] });
    }
    const out = buildWorkspaceIndex({
      store,
      workspaceId: WS,
      currentSessionId: "s1",
    });
    expect(out.length).toBeLessThanOrEqual(MAX_INDEX_BYTES);
  });
});

describe("IndexScheduler triggers", () => {
  function makeScheduler(clock: { t: number }, overrides: Partial<{
    episodeThreshold: number;
    timeThresholdMs: number;
    debounceMs: number;
  }> = {}): IndexScheduler {
    insertEpisode({ sessionId: "s1" });
    return new IndexScheduler({
      store,
      workspaceId: WS,
      currentSessionId: "s1",
      now: () => clock.t,
      episodeThreshold: overrides.episodeThreshold ?? 5,
      timeThresholdMs: overrides.timeThresholdMs ?? 60_000,
      debounceMs: overrides.debounceMs ?? 15_000,
    });
  }

  it("builds on first access (cold cache)", () => {
    const clock = { t: 1_000_000 };
    const sched = makeScheduler(clock);
    expect(sched.isStale).toBe(true);
    const first = sched.get();
    expect(first).toContain("# Memory Index");
    expect(sched.isStale).toBe(false); // cache is warm
  });

  it("hard trigger fires after EPISODE_THRESHOLD new episodes", () => {
    const clock = { t: 1_000_000 };
    const sched = makeScheduler(clock, { episodeThreshold: 3 });
    sched.get(); // prime cache

    // Advance past debounce so the only gate is pending episodes.
    clock.t += 20_000;

    sched.onEpisode(); // 1
    sched.onEpisode(); // 2
    expect(sched.isStale).toBe(false); // below threshold
    sched.onEpisode(); // 3 — threshold hit
    expect(sched.isStale).toBe(true);
  });

  it("timed trigger fires after TIME_THRESHOLD_MS with ≥1 pending", () => {
    const clock = { t: 1_000_000 };
    const sched = makeScheduler(clock, { timeThresholdMs: 30_000 });
    sched.get();

    sched.onEpisode();
    clock.t += 20_000;
    expect(sched.isStale).toBe(false); // below time threshold

    clock.t += 15_000; // total 35s > 30s
    expect(sched.isStale).toBe(true);
  });

  it("timed trigger does NOT fire without any pending episodes", () => {
    const clock = { t: 1_000_000 };
    const sched = makeScheduler(clock, { timeThresholdMs: 10_000 });
    sched.get();

    clock.t += 60_000; // far past time threshold
    // No onEpisode() called → still not stale.
    expect(sched.isStale).toBe(false);
  });

  it("debounce prevents rebuild within floor even if triggers say yes", () => {
    const clock = { t: 1_000_000 };
    const sched = makeScheduler(clock, {
      episodeThreshold: 1, // trivially easy to hit
      debounceMs: 20_000,
    });
    sched.get();

    clock.t += 5_000; // within debounce floor
    sched.onEpisode();
    expect(sched.isStale).toBe(false); // debounce wins

    clock.t += 20_000; // past debounce
    expect(sched.isStale).toBe(true);
  });

  it("forceRebuild ignores all gates", () => {
    const clock = { t: 1_000_000 };
    const sched = makeScheduler(clock, { debounceMs: 999_999 });
    sched.get();
    // Insert a new episode so the built output would differ.
    insertEpisode({ filePaths: ["new-hot-file.ts"] });
    // Normal get() is blocked by debounce.
    expect(sched.isStale).toBe(false);
    // forceRebuild bypasses it.
    const rebuilt = sched.forceRebuild();
    expect(rebuilt).toContain("new-hot-file.ts");
  });
});
