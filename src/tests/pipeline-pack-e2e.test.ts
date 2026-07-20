/**
 * End-to-end: a declarative pack on disk → loaded via config at boot →
 * create-from-pack over the wire → advanced through a real worker turn (mock
 * backend). This is the full path a client uses to run a shared methodology
 * pack (e.g. ai-factory's aif-sdlc), exercised without an SDK subprocess.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, PipelineWire } from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:t",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc",
  projectId: "proj",
};
const CLIENT = { id: "c", auth: AUTH, send: () => {} };

function turnDone(): ProviderEvent {
  return {
    type: "turn_done",
    result: {
      providerId: "mock",
      model: "mock",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      durationMs: 1,
    },
  } as ProviderEvent;
}
function sayTurn(text: string): ProviderEvent[] {
  return [{ type: "text_done", content: text } as ProviderEvent, turnDone()];
}

const IMPLEMENTER_ROLE = `name: implementer
write: true
network: read-only
envelope: all
`;

/** Write a fixture pack whose single skill phase is gated by a command gate. */
function writeE2EPack(gateRun: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codeoid-e2e-pack-"));
  mkdirSync(join(dir, "roles"), { recursive: true });
  writeFileSync(join(dir, "roles", "implementer.yaml"), IMPLEMENTER_ROLE);
  writeFileSync(
    join(dir, "pack.yaml"),
    `schema: codeoid/pack@v1
id: e2e-pack
name: E2E Pack
version: 0.0.1
roles:
  - ./roles/implementer.yaml
skills:
  - { id: build, kind: slash, command: /build }
gates:
  - { id: gate, kind: command, run: "${gateRun}" }
phases:
  - { id: impl, skill: build, role: implementer, gate: gate }
`,
  );
  return dir;
}

function mkConfig(dbPath: string, packDir: string, trusted: boolean, defaultPack: string | null): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath,
    transcriptDir: join(tmpdir(), "codeoid-e2e-transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: {
      enabled: false,
      warnPct: 0.6,
      rotatePct: 0.8,
      hardRotatePct: 0.9,
      minTurnsBeforeRotate: 3,
      strategy: "task-anchor",
    },
    session: {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
    dispatch: {
      enabled: false,
      tickMs: 999_999,
      leaseMs: 60_000,
      failureLimit: 2,
      maxConcurrentWorkers: 2,
      workerToolBudget: 7,
      retryBaseMs: 0,
    },
    pipeline: { enabled: true, defaultPack, packs: [{ dir: packDir, trusted }] },
  };
}

function snapshot(m: DaemonMessage): PipelineWire {
  if (m.type !== "pipeline.snapshot") throw new Error(`expected pipeline.snapshot, got ${m.type}`);
  return m.pipeline;
}

let tmp: string;
let store: Store;
let transcript: TranscriptStore;

function makeManager(packDir: string, trusted: boolean, defaultPack: string | null): SessionManager {
  return new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(join(tmp, "codeoid.db"), packDir, trusted, defaultPack),
    _testProviderFactory: () => new MockSessionProvider("mock", [sayTurn("phase complete")]),
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-e2e-"));
  mkdirSync(join(tmp, "repo"), { recursive: true });
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("pack E2E (config → wire create-from-pack → advance)", () => {
  test("a trusted pack loaded from config runs to done over the wire, carrying the phase role", async () => {
    const packDir = writeE2EPack("true");
    const manager = makeManager(packDir, true, null);
    try {
      // Installed at boot from config.
      expect(manager.pipelines?.registries.packs.has("e2e-pack")).toBe(true);

      const created = snapshot(
        await manager.handle(
          { type: "pipeline.create", id: "1", name: "REQ-1", pack: "e2e-pack", workdir: join(tmp, "repo") },
          AUTH,
          CLIENT,
        ),
      );
      expect(created.status).toBe("draft");
      expect(created.phases.map((p) => p.id)).toEqual(["impl"]);
      // The pack's capability role is projected onto the wire.
      expect(created.phases[0].role).toBe("implementer");

      const done = snapshot(await manager.handle({ type: "pipeline.advance", id: "2", pipelineId: created.id }, AUTH, CLIENT));
      expect(done.status).toBe("done");
      expect(done.phases[0].status).toBe("passed");
      if (done.phases[0].status === "passed") expect(done.phases[0].summary).toContain("phase complete");
      rmSync(packDir, { recursive: true, force: true });
    } finally {
      await manager.drain(3_000);
    }
  });

  test("defaultPack: create with no phases/pack uses the configured default", async () => {
    const packDir = writeE2EPack("true");
    const manager = makeManager(packDir, true, "e2e-pack");
    try {
      const created = snapshot(
        await manager.handle(
          { type: "pipeline.create", id: "1", name: "REQ-1", workdir: join(tmp, "repo") },
          AUTH,
          CLIENT,
        ),
      );
      expect(created.phases.map((p) => p.id)).toEqual(["impl"]);
      const done = snapshot(await manager.handle({ type: "pipeline.advance", id: "2", pipelineId: created.id }, AUTH, CLIENT));
      expect(done.status).toBe("done");
      rmSync(packDir, { recursive: true, force: true });
    } finally {
      await manager.drain(3_000);
    }
  });

  test("an UNTRUSTED pack's command gate fails closed → the pipeline halts", async () => {
    const packDir = writeE2EPack("true"); // gate would pass IF it ran — but untrusted, so it must not run
    const manager = makeManager(packDir, false, null);
    try {
      const created = snapshot(
        await manager.handle(
          { type: "pipeline.create", id: "1", name: "R", pack: "e2e-pack", workdir: join(tmp, "repo") },
          AUTH,
          CLIENT,
        ),
      );
      const halted = snapshot(await manager.handle({ type: "pipeline.advance", id: "2", pipelineId: created.id }, AUTH, CLIENT));
      expect(halted.status).toBe("halted");
      if (halted.phases[0].status === "halted") expect(halted.phases[0].reason).toContain("trusted pack");
      rmSync(packDir, { recursive: true, force: true });
    } finally {
      await manager.drain(3_000);
    }
  });

  test("create with an unknown pack → invalid_request", async () => {
    const packDir = writeE2EPack("true");
    const manager = makeManager(packDir, true, null);
    try {
      const r = await manager.handle(
        { type: "pipeline.create", id: "1", name: "R", pack: "ghost", workdir: join(tmp, "repo") },
        AUTH,
        CLIENT,
      );
      expect(r.type).toBe("response.error");
      if (r.type === "response.error") {
        expect(r.code).toBe("invalid_request");
        expect(r.error).toContain("unknown pack");
      }
      rmSync(packDir, { recursive: true, force: true });
    } finally {
      await manager.drain(3_000);
    }
  });
});
