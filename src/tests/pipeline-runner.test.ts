/**
 * Pipeline runtime integration — the REAL SessionManager driving a pipeline
 * phase through a worker turn, with a MockSessionProvider (no SDK subprocess).
 * Exercises PR4: skill phase → SessionPhaseRunner → runPhaseTurn → worker
 * session → mock backend → lastAssistantText → phase summary.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";

const tenant = { accountId: "acc", projectId: "proj", createdBy: "user:test" };

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
function errorTurn(): ProviderEvent[] {
  return [
    {
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
        isError: true,
        errorMessage: "backend blew up",
      },
    } as ProviderEvent,
  ];
}

function mkConfig(dbPath: string, pipelineEnabled: boolean): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath,
    transcriptDir: join(tmpdir(), "codeoid-pl-transcripts"),
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
    pipeline: { enabled: pipelineEnabled, defaultPack: null, packs: [] },
  };
}

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-pipeline-runner-"));
  mkdirSync(join(tmp, "repo"), { recursive: true });
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(join(tmp, "codeoid.db"), true),
    _testProviderFactory: () => new MockSessionProvider("mock", [sayTurn("phase complete: implemented X")]),
  });
});

afterEach(async () => {
  try {
    await manager.drain(3_000);
  } catch {}
  try {
    await transcript.flush();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

describe("pipeline runtime (real SessionManager + mock backend)", () => {
  test("a skill phase drives a worker turn and captures its final text as the summary", async () => {
    const pm = manager.pipelines;
    expect(pm).toBeDefined();
    if (!pm) return;
    pm.registries.skills.register({ id: "implement", kind: "slash", command: "/implement" });
    const p = pm.create({
      name: "REQ-1",
      workdir: join(tmp, "repo"),
      phases: [{ id: "impl", kind: "skill", skill: "implement" }],
      ...tenant,
    });
    const done = await pm.advance(p.id);
    expect(done.status).toBe("done");
    const st = done.phases[0].state;
    expect(st.status).toBe("passed");
    if (st.status === "passed") expect(st.summary).toContain("phase complete");
  });

  test("an errored backend turn fails the phase instead of passing it", async () => {
    const store2 = new Store(join(tmp, "codeoid-err.db"));
    const m2 = new SessionManager(store2, transcript, undefined, undefined, undefined, {
      config: mkConfig(join(tmp, "codeoid-err.db"), true),
      _testProviderFactory: () => new MockSessionProvider("mock", [errorTurn()]),
    });
    const pm = m2.pipelines;
    expect(pm).toBeDefined();
    if (!pm) return;
    pm.registries.skills.register({ id: "impl", kind: "slash", command: "/impl" });
    const p = pm.create({
      name: "R",
      workdir: join(tmp, "repo"),
      phases: [{ id: "impl", kind: "skill", skill: "impl", onFail: { action: "abort" } }],
      ...tenant,
    });
    const out = await pm.advance(p.id);
    expect(out.status).toBe("failed");
    const st = out.phases[0].state;
    expect(st.status).toBe("failed");
    if (st.status === "failed") expect(st.reason).toContain("error");
    await m2.drain(3_000);
  });

  test("get pipelines() is undefined when the pipeline is disabled", () => {
    const store2 = new Store(join(tmp, "codeoid2.db"));
    const m2 = new SessionManager(store2, transcript, undefined, undefined, undefined, {
      config: mkConfig(join(tmp, "codeoid2.db"), false),
    });
    expect(m2.pipelines).toBeUndefined();
  });
});
