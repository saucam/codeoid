/**
 * Fleet MCP handler tests (P3) — the conductor's read-only view of the
 * fleet. Drives createFleetHandlers directly with a fake dependency set
 * (plus a real StubEmbedder-backed MemoryEngine for the find/recall/summary
 * paths), so behavior is exercised without an MCP transport or the SDK.
 *
 * The load-bearing properties: read-only surface, the conductor excludes
 * itself from find, summaries are episode digests (not raw scrollback), and
 * every tool audits.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFleetHandlers,
  FLEET_TOOL_NAMES,
  type FleetDeps,
  type FleetSessionView,
} from "../daemon/fleet.js";
import { MemoryEngine, SqliteEpisodeStore } from "../daemon/memory/index.js";
import type { Embedder } from "../daemon/memory/embedder.js";

class StubEmbedder implements Embedder {
  readonly modelName = "stub";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (let i = 0; i < t.length; i++) v[i % this.dimensions]! += t.charCodeAt(i) / 1000;
      let norm = 0;
      for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
      return v;
    });
  }
  async close(): Promise<void> {}
}

let tmp: string;
let episodeStore: SqliteEpisodeStore;
let memory: MemoryEngine;
let audits: Array<{ action: string; detail: string }>;

/** A small fleet: two normal sessions + the conductor itself. */
function fleet(): FleetSessionView[] {
  return [
    {
      id: "sess-authz-0001",
      name: "authz-fix",
      workdir: join(tmp, "highflame-authz"),
      workspaceId: "ws-authz",
      status: "idle",
      providerId: "claude",
      model: "claude-opus-4-8",
      attachedClients: 1,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
    {
      id: "sess-migr-0002",
      name: "migration-work",
      workdir: join(tmp, "highflame-admin"),
      workspaceId: "ws-admin",
      status: "thinking",
      providerId: "gemini",
      attachedClients: 0,
      createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    },
    {
      id: "sess-cond-9999",
      name: "conductor",
      workdir: join(tmp, ".codeoid-conductor"),
      workspaceId: "ws-conductor",
      status: "idle",
      role: "conductor",
      providerId: "claude",
      attachedClients: 1,
      createdAt: new Date().toISOString(),
    },
  ];
}

function makeDeps(overrides?: Partial<FleetDeps>): FleetDeps {
  return {
    listSessions: () => fleet(),
    memory,
    audit: (action, detail) => audits.push({ action, detail }),
    conductorSessionId: () => "sess-cond-9999",
    ...overrides,
  };
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-fleet-"));
  episodeStore = new SqliteEpisodeStore(join(tmp, "memory.db"));
  memory = new MemoryEngine({ store: episodeStore, embedder: new StubEmbedder() });
  await memory.init();
  audits = [];
  // Distinct episodes per session so find/recall/summary have signal.
  memory.ingest({
    workspaceId: "ws-authz",
    sessionId: "sess-authz-0001",
    kind: "user_turn",
    summary: "fix the authz latest_only tenant scoping bug",
    content: "the authz policy latest_only query dropped account and project scope",
    filePaths: ["internal/authz/policy.go"],
    tokenEstimate: 20,
    createdAt: Date.now() - 3_600_000,
    createdBy: "user:owner",
  });
  memory.ingest({
    workspaceId: "ws-admin",
    sessionId: "sess-migr-0002",
    kind: "tool_call",
    toolName: "Bash",
    summary: "run the admin schema migration",
    content: "golang-migrate up on the admin database, add quota columns",
    filePaths: ["migrations/003_quota.sql"],
    tokenEstimate: 20,
    createdAt: Date.now() - 7_200_000,
    createdBy: "user:owner",
  });
});

afterEach(async () => {
  try { await memory.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("fleet handlers — read surface", () => {
  test("the fleet MCP tool set is exactly the read-only five", () => {
    // A guardrail: no send-class tool leaks into P3. Dispatch arrives in P4.
    expect([...FLEET_TOOL_NAMES]).toEqual([
      "fleet_list",
      "fleet_find",
      "fleet_summary",
      "fleet_recall",
      "machine_map",
    ]);
  });

  test("fleet_list groups sessions by workspace and marks the conductor", async () => {
    const out = await createFleetHandlers(makeDeps()).fleet_list();
    expect(out).toContain("authz-fix");
    expect(out).toContain("migration-work");
    expect(out).toContain("[conductor — you]");
    expect(out).toContain("provider=gemini");
    expect(audits.some((a) => a.action === "fleet.list")).toBe(true);
  });

  test("fleet_list on an empty fleet says so", async () => {
    const out = await createFleetHandlers(
      makeDeps({ listSessions: () => [] }),
    ).fleet_list();
    expect(out).toBe("No sessions in the fleet.");
  });

  test("fleet_find resolves a natural-language reference and excludes the conductor", async () => {
    const out = await createFleetHandlers(makeDeps()).fleet_find({
      query: "the authz latest_only fix",
    });
    expect(out).toContain("authz-fix");
    expect(out).not.toContain("conductor");
    expect(audits.some((a) => a.action === "fleet.find")).toBe(true);
  });

  test("fleet_find degrades gracefully when memory is disabled", async () => {
    const out = await createFleetHandlers(
      makeDeps({ memory: undefined }),
    ).fleet_find({ query: "anything" });
    expect(out).toContain("Memory is disabled");
  });

  test("fleet_summary returns a compressed episode digest for one session", async () => {
    const out = await createFleetHandlers(makeDeps()).fleet_summary({
      session: "authz-fix",
    });
    expect(out).toContain("authz-fix");
    expect(out).toContain("latest_only"); // from the episode summary, not raw scrollback
    expect(audits.some((a) => a.action === "fleet.summary")).toBe(true);
  });

  test("fleet_summary resolves by id prefix and reports unknown refs", async () => {
    const handlers = createFleetHandlers(makeDeps());
    expect(await handlers.fleet_summary({ session: "sess-migr" })).toContain(
      "migration-work",
    );
    expect(await handlers.fleet_summary({ session: "nope" })).toContain(
      "No session matches",
    );
  });

  test("fleet_recall pulls episode summaries across the whole fleet", async () => {
    const out = await createFleetHandlers(makeDeps()).fleet_recall({
      query: "migration quota columns",
    });
    expect(out).toContain("migration-work");
    expect(audits.some((a) => a.action === "fleet.recall")).toBe(true);
  });

  test("machine_map lists workspaces with git state (non-repo dirs → 'not a git repo')", async () => {
    const out = await createFleetHandlers(makeDeps()).machine_map();
    expect(out).toContain("highflame-authz");
    expect(out).toContain("not a git repo"); // temp dirs aren't git repos
    expect(out).toContain("authz-fix");
    expect(audits.some((a) => a.action === "fleet.machine_map")).toBe(true);
  });
});
