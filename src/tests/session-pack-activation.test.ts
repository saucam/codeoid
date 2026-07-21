/**
 * Ambient pack activation via session.create (docs/pack-loading.md) — routed
 * through the real SessionManager.handle() with a mock provider (no Claude SDK).
 * Covers: an installed pack + capability role sets SessionInfo.profile, and the
 * fail-closed branches (unknown pack, packRole without pack).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, ClientMessage, DaemonMessage, SessionInfo } from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:t",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc",
  projectId: "proj",
};

/** A pack dir declaring an implementer (write) + reviewer (read-only) role. */
function writePack(dir: string, id: string): void {
  mkdirSync(join(dir, "roles"), { recursive: true });
  writeFileSync(join(dir, "ETHOS.md"), "Ship carefully.");
  writeFileSync(join(dir, "roles", "implementer.yaml"), "name: implementer\nwrite: true\nnetwork: read-only\nenvelope: all\n");
  writeFileSync(
    join(dir, "roles", "reviewer.yaml"),
    "name: reviewer\nwrite: false\nnetwork: read-only\nenvelope: [read, grep, glob, bash]\n",
  );
  writeFileSync(
    join(dir, "pack.yaml"),
    `schema: codeoid/pack@v1\nid: ${id}\nname: Pack ${id}\nversion: 1.0.0\nconstitution: ./ETHOS.md\nroles: [./roles/implementer.yaml, ./roles/reviewer.yaml]\nskills:\n  - { id: build, kind: prompt, template: "x" }\nphases:\n  - { id: impl, kind: skill, skill: build, role: implementer }\n`,
  );
}

function mkConfig(dbPath: string, packDir: string): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath,
    transcriptDir: join(tmpdir(), "codeoid-spa-transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
    dispatch: { enabled: false, tickMs: 999_999, leaseMs: 60_000, failureLimit: 2, maxConcurrentWorkers: 2, workerToolBudget: 7, retryBaseMs: 0 },
    // pipeline runtime OFF — ambient pack activation works independently of it.
    pipeline: { enabled: false, defaultPack: null, packs: [{ dir: packDir, trusted: false }], registries: [] },
  };
}

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;

function run(msg: ClientMessage, a: AuthContext = AUTH): Promise<DaemonMessage> {
  return manager.handle(msg, a, { id: "c", auth: a, send: () => {} });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-spa-"));
  mkdirSync(join(tmp, "repo"), { recursive: true });
  writePack(join(tmp, "loc"), "loc");
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(join(tmp, "codeoid.db"), join(tmp, "loc")),
    _testProviderFactory: () => new MockSessionProvider("mock", []),
  });
});

afterEach(async () => {
  try {
    await manager.drain(3_000);
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

describe("session.create --pack", () => {
  test("activating a pack + role sets SessionInfo.profile", async () => {
    const resp = await run({ type: "session.create", id: "1", name: "s1", workdir: join(tmp, "repo"), pack: "loc", packRole: "reviewer" });
    expect(resp.type).toBe("response.ok");
    if (resp.type === "response.ok") {
      expect((resp.data as SessionInfo).profile).toBe("loc (reviewer)");
    }
  });

  test("pack without a role shows just the pack id", async () => {
    const resp = await run({ type: "session.create", id: "2", name: "s2", workdir: join(tmp, "repo"), pack: "loc" });
    expect(resp.type).toBe("response.ok");
    if (resp.type === "response.ok") expect((resp.data as SessionInfo).profile).toBe("loc");
  });

  test("no pack → no profile (normal freestyle session)", async () => {
    const resp = await run({ type: "session.create", id: "3", name: "s3", workdir: join(tmp, "repo") });
    expect(resp.type).toBe("response.ok");
    if (resp.type === "response.ok") expect((resp.data as SessionInfo).profile).toBeUndefined();
  });
});

describe("fail-closed", () => {
  test("unknown pack is rejected", async () => {
    const resp = await run({ type: "session.create", id: "4", name: "s4", workdir: join(tmp, "repo"), pack: "ghost" });
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") expect(resp.code).toBe("invalid_request");
  });

  test("unknown role on a real pack is rejected", async () => {
    const resp = await run({ type: "session.create", id: "5", name: "s5", workdir: join(tmp, "repo"), pack: "loc", packRole: "wizard" });
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") expect(resp.error).toMatch(/no role "wizard"/);
  });

  test("packRole without pack is rejected", async () => {
    const resp = await run({ type: "session.create", id: "6", name: "s6", workdir: join(tmp, "repo"), packRole: "reviewer" });
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") expect(resp.error).toMatch(/requires pack/);
  });
});
