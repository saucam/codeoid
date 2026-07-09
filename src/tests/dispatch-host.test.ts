/**
 * Dispatch host integration (P4) — the REAL SessionManager host behind the
 * Dispatcher, with MockSessionProviders injected via _testProviderFactory so
 * no SDK subprocess runs. Covers what dispatcher.test.ts fakes: worker
 * sessions actually spawn (role, mode, brief), digests read the real session
 * + memory, events inject into a real conductor session, and the fleet
 * dispatch deps close over real manager state.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../daemon/session-manager.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import type { AuthContext, SessionInfo } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";

const AUTH: AuthContext = {
  sub: "user:host-test",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-h",
  projectId: "proj-h",
};
const CLIENT = { id: "client-h", auth: AUTH, send: () => {} };

function mkConfig(): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: "/tmp/codeoid.db",
    transcriptDir: "/tmp/transcripts",
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    conductor: { enabled: true, name: "conductor", provider: "claude" },
    dispatch: {
      enabled: true,
      tickMs: 999_999, // manual ticks only
      leaseMs: 60_000,
      failureLimit: 2,
      maxConcurrentWorkers: 2,
      workerToolBudget: 7,
    },
  };
}

function turnDone(): ProviderEvent {
  return {
    type: "turn_done",
    result: {
      providerId: "mock",
      model: "mock-model",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      durationMs: 1,
    },
  } as ProviderEvent;
}

/** A scripted turn that says something, then finishes. */
function sayTurn(text: string): ProviderEvent[] {
  return [{ type: "text_done", content: text } as ProviderEvent, turnDone()];
}

let tmp: string;
let workdir: string;
let store: Store;
let transcript: TranscriptStore;
let providers: MockSessionProvider[];
let manager: SessionManager;

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function listSessions(): Promise<SessionInfo[]> {
  const resp = await manager.handle({ type: "session.list", id: "req" }, AUTH, CLIENT);
  return (resp as { sessions: SessionInfo[] }).sessions;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-dispatch-host-"));
  workdir = join(tmp, "repo");
  rmSync(workdir, { recursive: true, force: true });
  require("node:fs").mkdirSync(workdir, { recursive: true });
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  providers = [];
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(),
    _testProviderFactory: () => {
      // Every session (conductor, targets, workers) speaks in scripted turns.
      const p = new MockSessionProvider("mock", [
        sayTurn("scouted: the bug is in auth.ts line 42"),
        sayTurn("second turn"),
        sayTurn("third turn"),
      ]);
      providers.push(p);
      return p;
    },
  });
});

afterEach(async () => {
  manager.stopDispatcher();
  // Sessions may still be mid-mock-turn (e.g. the conductor processing an
  // injected event) with fire-and-forget meta writes in flight — drain them
  // to idle, then flush the write chains, THEN remove the temp dir. Without
  // this, a pending atomic rename lands after rmSync and surfaces as an
  // unhandled ENOENT in unrelated test files.
  try { await manager.drain(3_000); } catch {}
  try { await transcript.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("dispatch host — spawn end-to-end", () => {
  test("spawn runs a real worker session: brief, budget, digest, teardown, conductor injection", async () => {
    // A real conductor session to receive the event injection.
    const created = await manager.handle(
      { type: "session.create", id: "req", name: "x", workdir: ".", role: "conductor" },
      AUTH,
      CLIENT,
    );
    const conductorId = (created as { data: SessionInfo }).data.id;
    const conductorProvider = providers[0]!;

    const taskId = manager.dispatcher.enqueue({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      kind: "spawn",
      shape: "scout",
      workdir,
      prompt: "find the auth bug",
      createdBy: "wimse://test/conductor",
    });
    await manager.dispatcher.tick();

    // A real worker session exists with the right shape.
    const sessions = await listSessions();
    const worker = sessions.find((s) => s.role === "worker");
    expect(worker).toBeDefined();
    expect(worker!.name).toStartWith("worker-scout-");
    expect(worker!.mode).toBe("autonomous");
    expect(worker!.turnsRemaining).toBe(7); // config.dispatch.workerToolBudget

    // The worker got a complete, sentinel-marked brief with the scout contract.
    const workerProvider = providers.find((p) => p !== conductorProvider)!;
    const brief = workerProvider.capturedOpts[0]!.userMessage;
    expect(brief).toContain('<fleet_dispatch task="');
    expect(brief).toContain("Do NOT modify files");
    expect(brief).toContain("find the auth bug");

    // Worker's scripted turn finishes → digest, done, teardown, injection.
    await until(() => store.dispatchGet(taskId)?.status === "done");
    const task = store.dispatchGet(taskId)!;
    expect(task.resultDigest).toContain("scouted: the bug is in auth.ts line 42");

    {
      // Teardown is fired from the async finisher — poll until the worker
      // session is gone from the tenant's list.
      const deadline = Date.now() + 3_000;
      while ((await listSessions()).some((s) => s.role === "worker")) {
        if (Date.now() > deadline) throw new Error("worker not torn down");
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    expect((await listSessions()).some((s) => s.role === "worker")).toBe(false);

    // The conductor received ONE daemon-injected <fleet_events> turn.
    await until(() => conductorProvider.capturedOpts.length >= 1);
    const injected = conductorProvider.capturedOpts[0]!.userMessage;
    expect(injected).toContain("<fleet_events>");
    expect(injected).toContain("task_done");
    expect(injected).toContain("scouted: the bug is in auth.ts line 42");
    expect(store.dispatchEventsPending(AUTH.accountId, AUTH.projectId)).toHaveLength(0);
  });

  test("spawn with a vanished workdir fails terminally", async () => {
    const gone = join(tmp, "vanished");
    const taskId = manager.dispatcher.enqueue({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      kind: "spawn",
      shape: "ship",
      workdir: gone,
      prompt: "x",
      createdBy: "c",
    });
    await manager.dispatcher.tick();
    expect(store.dispatchGet(taskId)!.status).toBe("failed");
    expect(store.dispatchGet(taskId)!.error).toContain("workdir not usable");
  });
});

describe("dispatch host — send end-to-end", () => {
  test("send delivers a conductor-attributed, prefixed prompt to the real target session", async () => {
    const created = await manager.handle(
      { type: "session.create", id: "req", name: "target", workdir: tmp },
      AUTH,
      CLIENT,
    );
    const targetId = (created as { data: SessionInfo }).data.id;
    const targetProvider = providers[0]!;

    const taskId = manager.dispatcher.enqueue({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      kind: "send",
      shape: "ship",
      targetSession: targetId,
      prompt: "continue the latest_only fix",
      createdBy: "wimse://test/conductor",
    });
    await manager.dispatcher.tick();

    expect(store.dispatchGet(taskId)!.status).toBe("done");
    const delivered = targetProvider.capturedOpts[0]!.userMessage;
    expect(delivered).toContain("[conductor dispatch");
    expect(delivered).toContain("owner-approved");
    expect(delivered).toContain("continue the latest_only fix");
    // Attribution: the send audits under the conductor principal.
    expect(targetProvider.capturedOpts[0]!.sender?.sub).toBe("wimse://test/conductor");
  });

  test("send to a session of ANOTHER tenant fails terminally (tenancy wall)", async () => {
    const created = await manager.handle(
      { type: "session.create", id: "req", name: "target", workdir: tmp },
      AUTH,
      CLIENT,
    );
    const targetId = (created as { data: SessionInfo }).data.id;

    const taskId = manager.dispatcher.enqueue({
      accountId: "acc-OTHER",
      projectId: "proj-OTHER",
      kind: "send",
      shape: "ship",
      targetSession: targetId, // exists, but belongs to acc-h
      prompt: "x",
      createdBy: "c",
    });
    await manager.dispatcher.tick();
    expect(store.dispatchGet(taskId)!.status).toBe("failed");
  });
});

describe("dispatch host — fleet dispatch deps (real closures)", () => {
  test("enqueue stamps tenant + conductor lineage; listTasks maps the board", async () => {
    const deps = manager._fleetDispatchDeps(AUTH.accountId, AUTH.projectId);
    const taskId = deps.enqueue({
      kind: "spawn",
      shape: "scout",
      workdir,
      prompt: "look around",
    });

    const row = store.dispatchGet(taskId)!;
    expect(row.accountId).toBe(AUTH.accountId);
    expect(row.createdBy).toContain("conductor:acc-h/proj-h"); // no identity manager → fallback lineage

    const board = deps.listTasks(10);
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ id: taskId, kind: "spawn", shape: "scout", status: "queued", target: workdir });
  });

  test("checkWorkdir normalizes real dirs and rejects missing ones", () => {
    const deps = manager._fleetDispatchDeps(AUTH.accountId, AUTH.projectId);
    expect(deps.checkWorkdir(workdir)).toBe(workdir);
    expect(deps.checkWorkdir(join(tmp, "nope"))).toBeNull();
  });

  test("interrupt refuses cross-tenant and missing sessions", async () => {
    const created = await manager.handle(
      { type: "session.create", id: "req", name: "t", workdir: tmp },
      AUTH,
      CLIENT,
    );
    const id = (created as { data: SessionInfo }).data.id;

    const foreign = manager._fleetDispatchDeps("acc-OTHER", "proj-OTHER");
    expect(foreign.interrupt(id)).rejects.toThrow("no longer exists");

    const mine = manager._fleetDispatchDeps(AUTH.accountId, AUTH.projectId);
    await mine.interrupt(id); // idle session — harmless no-op interrupt
  });
});
