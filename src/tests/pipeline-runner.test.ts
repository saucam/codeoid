/**
 * Pipeline runtime integration — the REAL SessionManager driving a pipeline
 * phase through a turn on the run's BOUND session, with a MockSessionProvider
 * (no SDK subprocess). Exercises: pipeline.create binds a session → advance →
 * SessionPhaseRunner → runPhaseOnSession → bound session → mock backend →
 * lastAssistantText → phase summary. (No headless worker; the run drives a real
 * attachable session — see docs/pipeline-run.md.)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { PHASE_COMPLETE_MARKER } from "../daemon/pipeline/phase-completion.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext } from "../protocol/types.js";

const tenant = { accountId: "acc", projectId: "proj", createdBy: "user:test" };
const AUTH: AuthContext = {
  sub: tenant.createdBy,
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: tenant.accountId,
  projectId: tenant.projectId,
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
    _testProviderFactory: () =>
      new MockSessionProvider("mock", [sayTurn(`phase complete: implemented X\n${PHASE_COMPLETE_MARKER}`)]),
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
  test("a skill phase drives a turn on the bound session and captures its final text as the summary", async () => {
    const pm = manager.pipelines;
    expect(pm).toBeDefined();
    if (!pm) return;
    pm.registries.skills.register({ id: "implement", kind: "slash", command: "/implement" });
    // Go through the wire handler so a run-session is created + bound (the real
    // path); driving pm.create directly would leave the run session-less.
    const created = await manager.handle(
      {
        type: "pipeline.create",
        id: "1",
        name: "REQ-1",
        workdir: join(tmp, "repo"),
        phases: [{ id: "impl", kind: "skill", skill: "implement" }],
      },
      AUTH,
      CLIENT,
    );
    if (created.type !== "pipeline.snapshot") throw new Error(`create failed: ${JSON.stringify(created)}`);
    expect(created.pipeline.sessionId).toBeTruthy();
    // The phase runs a turn on the bound session, then halts for review with its
    // produced text surfaced.
    const halted = await manager.handle({ type: "pipeline.advance", id: "2", pipelineId: created.pipeline.id }, AUTH, CLIENT);
    if (halted.type !== "pipeline.snapshot") throw new Error(`advance failed: ${JSON.stringify(halted)}`);
    expect(halted.pipeline.status).toBe("halted");
    const halt = halted.pipeline.phases[0];
    expect(halt.status).toBe("halted");
    expect(halt.summary).toContain("phase complete");
    if (halt.status !== "halted" || !halt.requestId) throw new Error("expected halt with requestId");
    // Approve → the run's captured summary is the phase's output.
    const done = await manager.handle(
      { type: "pipeline.answer", id: "3", pipelineId: created.pipeline.id, requestId: halt.requestId, approved: true },
      AUTH,
      CLIENT,
    );
    if (done.type !== "pipeline.snapshot") throw new Error(`answer failed: ${JSON.stringify(done)}`);
    expect(done.pipeline.status).toBe("done");
    const ph = done.pipeline.phases[0];
    expect(ph.status).toBe("passed");
    expect(ph.summary).toContain("phase complete");
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
    const created = await m2.handle(
      {
        type: "pipeline.create",
        id: "1",
        name: "R",
        workdir: join(tmp, "repo"),
        phases: [{ id: "impl", kind: "skill", skill: "impl", onFail: { action: "abort" } }],
      },
      AUTH,
      CLIENT,
    );
    if (created.type !== "pipeline.snapshot") throw new Error(`create failed: ${JSON.stringify(created)}`);
    const out = await m2.handle({ type: "pipeline.advance", id: "2", pipelineId: created.pipeline.id }, AUTH, CLIENT);
    if (out.type !== "pipeline.snapshot") throw new Error(`advance failed: ${JSON.stringify(out)}`);
    expect(out.pipeline.status).toBe("failed");
    const ph = out.pipeline.phases[0];
    expect(ph.status).toBe("failed");
    if (ph.status === "failed") expect(ph.reason).toContain("error");
    await m2.drain(3_000);
  });

  test("a phase that rests WITHOUT the completion marker is nudged to continue, not halted mid-work", async () => {
    const store2 = new Store(join(tmp, "codeoid-nudge.db"));
    const m2 = new SessionManager(store2, transcript, undefined, undefined, undefined, {
      config: mkConfig(join(tmp, "codeoid-nudge.db"), true),
      // Turn 1 rests with NO marker (the model paused mid-work) — the phase must
      // NOT halt here. It gets nudged; turn 2 finishes and emits the marker.
      _testProviderFactory: () =>
        new MockSessionProvider("mock", [
          sayTurn("Here's my plan — I'll start implementing now."),
          sayTurn(`implemented the feature\n${PHASE_COMPLETE_MARKER}`),
        ]),
    });
    const pm = m2.pipelines;
    expect(pm).toBeDefined();
    if (!pm) return;
    pm.registries.skills.register({ id: "impl", kind: "slash", command: "/impl" });
    const created = await m2.handle(
      {
        type: "pipeline.create",
        id: "1",
        name: "R",
        workdir: join(tmp, "repo"),
        phases: [{ id: "impl", kind: "skill", skill: "impl" }],
      },
      AUTH,
      CLIENT,
    );
    if (created.type !== "pipeline.snapshot") throw new Error(`create failed: ${JSON.stringify(created)}`);
    const out = await m2.handle({ type: "pipeline.advance", id: "2", pipelineId: created.pipeline.id }, AUTH, CLIENT);
    if (out.type !== "pipeline.snapshot") throw new Error(`advance failed: ${JSON.stringify(out)}`);
    // Only halts AFTER the marker turn — and the summary is the completed
    // turn's text, with the marker stripped.
    expect(out.pipeline.status).toBe("halted");
    const ph = out.pipeline.phases[0];
    expect(ph.status).toBe("halted");
    expect(ph.summary).toContain("implemented the feature");
    expect(ph.summary ?? "").not.toContain(PHASE_COMPLETE_MARKER);
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
