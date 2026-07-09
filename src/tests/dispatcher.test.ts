/**
 * Dispatcher behavior (P4) — driven tick-by-tick against a real Store and a
 * fake DispatcherHost, so ordering, retries, crash recovery, the worker cap,
 * the approval wedge, and event delivery are all exercised deterministically
 * (no timers, no sessions, no SDK).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Dispatcher,
  NonRetryableDispatchError,
  type DispatcherHost,
} from "../daemon/dispatch.js";
import { Store, type DispatchEventRow, type DispatchTaskRow } from "../daemon/store.js";
import type { SessionStatus } from "../protocol/types.js";

const TENANT = { accountId: "acc-a", projectId: "proj-a" };

let tmp: string;
let store: Store;

/** Scriptable fake host recording every interaction. */
class FakeHost implements DispatcherHost {
  sent: DispatchTaskRow[] = [];
  spawned: DispatchTaskRow[] = [];
  continued: DispatchTaskRow[] = [];
  destroyed: Array<{ sessionId: string; reason: string }> = [];
  delivered: DispatchEventRow[][] = [];
  audits: string[] = [];
  /** Live worker statuses the host reports. */
  statuses = new Map<string, SessionStatus>();
  /** Behavior knobs. */
  sendError: Error | null = null;
  spawnError: Error | null = null;
  continueError: Error | null = null;
  continueSucceeds = true;
  conductorAcceptsEvents = true;
  #nextWorker = 0;

  async sendToSession(task: DispatchTaskRow): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push(task);
  }

  async spawnWorker(task: DispatchTaskRow): Promise<{ sessionId: string }> {
    if (this.spawnError) throw this.spawnError;
    this.spawned.push(task);
    const sessionId = `worker-${++this.#nextWorker}`;
    this.statuses.set(sessionId, "thinking");
    return { sessionId };
  }

  async continueWorker(task: DispatchTaskRow): Promise<boolean> {
    this.continued.push(task);
    if (this.continueError) throw this.continueError;
    if (this.continueSucceeds && task.workerSessionId) {
      this.statuses.set(task.workerSessionId, "thinking");
      return true;
    }
    return false;
  }

  workerStatus(sessionId: string): SessionStatus | null {
    return this.statuses.get(sessionId) ?? null;
  }

  buildWorkerDigest(task: DispatchTaskRow): string {
    return `digest for ${task.id}`;
  }

  async destroyWorker(sessionId: string, reason: string): Promise<void> {
    this.destroyed.push({ sessionId, reason });
    this.statuses.delete(sessionId);
  }

  async deliverEvents(
    _accountId: string,
    _projectId: string,
    events: DispatchEventRow[],
  ): Promise<boolean> {
    if (!this.conductorAcceptsEvents) return false;
    this.delivered.push(events);
    return true;
  }

  audit(action: string, detail: string): void {
    this.audits.push(`${action} ${detail}`);
  }
}

let host: FakeHost;
let dispatcher: Dispatcher;

function makeDispatcher(overrides?: Partial<ConstructorParameters<typeof Dispatcher>[2]>) {
  return new Dispatcher(store, host, {
    tickMs: 999_999, // never auto-ticks — tests drive tick() manually
    leaseMs: 60_000,
    failureLimit: 2,
    maxConcurrentWorkers: 2,
    workerToolBudget: 10,
    retryBaseMs: 0, // tests drive retries tick-by-tick; no wall-clock backoff
    ...overrides,
  });
}

function enqueueSend(prompt = "hello"): string {
  return dispatcher.enqueue({
    ...TENANT,
    kind: "send",
    shape: "ship",
    targetSession: "sess-target",
    prompt,
    createdBy: "wimse://test/conductor",
  });
}

function enqueueSpawn(prompt = "investigate", tenant = TENANT): string {
  return dispatcher.enqueue({
    ...tenant,
    kind: "spawn",
    shape: "scout",
    workdir: "/tmp/w",
    prompt,
    createdBy: "wimse://test/conductor",
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-dispatcher-"));
  store = new Store(join(tmp, "codeoid.db"));
  host = new FakeHost();
  dispatcher = makeDispatcher();
});

afterEach(() => {
  dispatcher.stop();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("dispatcher — send tasks", () => {
  test("a send task is delivered and completed in one tick", async () => {
    const id = enqueueSend();
    await dispatcher.tick();

    expect(host.sent.map((t) => t.id)).toEqual([id]);
    expect(store.dispatchGet(id)!.status).toBe("done");
  });

  test("a non-retryable send failure goes terminal and notifies the conductor", async () => {
    host.sendError = new NonRetryableDispatchError("target session gone");
    const id = enqueueSend();
    await dispatcher.tick();

    expect(store.dispatchGet(id)!.status).toBe("failed");
    // The failure event was emitted AND delivered (conductor idle).
    expect(host.delivered.flat().map((e) => e.type)).toContain("task_failed");
  });

  test("with backoff, a failed task is NOT re-claimed in the same tick (no budget fast-spin)", async () => {
    dispatcher.stop();
    dispatcher = makeDispatcher({ retryBaseMs: 60_000 });
    host.sendError = new Error("transient");
    const id = enqueueSend();
    await dispatcher.tick();

    const row = store.dispatchGet(id)!;
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1); // exactly ONE attempt this tick
    expect(row.notBefore).toBeGreaterThan(Date.now() - 1_000);
    expect(host.sent).toHaveLength(0);
  });

  test("a retryable send failure requeues and succeeds on the next tick", async () => {
    host.sendError = new Error("transient");
    const id = enqueueSend();
    await dispatcher.tick();
    expect(store.dispatchGet(id)!.status).toBe("queued");

    host.sendError = null;
    await dispatcher.tick();
    expect(store.dispatchGet(id)!.status).toBe("done");
  });
});

describe("dispatcher — spawn lifecycle", () => {
  test("spawn → running+watched; worker idle → digest, done, destroy, event delivered", async () => {
    const id = enqueueSpawn();
    await dispatcher.tick();

    const running = store.dispatchGet(id)!;
    expect(running.status).toBe("running");
    expect(running.workerSessionId).toBe("worker-1");
    expect(dispatcher.taskForWorker("worker-1")).toBe(id);

    // Worker finishes its turn.
    dispatcher.onSessionStatus("worker-1", "idle");
    await new Promise((r) => setTimeout(r, 0)); // let the async finisher run

    const done = store.dispatchGet(id)!;
    expect(done.status).toBe("done");
    expect(done.resultDigest).toBe(`digest for ${id}`);
    expect(host.destroyed.map((d) => d.sessionId)).toEqual(["worker-1"]);
    expect(host.delivered.flat().map((e) => e.type)).toEqual(["task_done"]);
    expect(dispatcher.taskForWorker("worker-1")).toBeUndefined();
  });

  test("worker error → retryable requeue keeping the worker, continued next tick", async () => {
    const id = enqueueSpawn();
    await dispatcher.tick();

    dispatcher.onSessionStatus("worker-1", "error");
    await new Promise((r) => setTimeout(r, 0));

    const failed = store.dispatchGet(id)!;
    expect(failed.status).toBe("queued");
    expect(failed.workerSessionId).toBe("worker-1"); // kept for continuation
    expect(host.destroyed).toHaveLength(0);

    await dispatcher.tick();
    expect(host.continued.map((t) => t.id)).toEqual([id]);
    expect(store.dispatchGet(id)!.status).toBe("running");
  });

  test("second worker error blocks the task (failure limit) and notifies", async () => {
    const id = enqueueSpawn();
    await dispatcher.tick();
    dispatcher.onSessionStatus("worker-1", "error");
    await new Promise((r) => setTimeout(r, 0));
    await dispatcher.tick(); // continues in worker-1
    dispatcher.onSessionStatus("worker-1", "error");
    await new Promise((r) => setTimeout(r, 0));

    expect(store.dispatchGet(id)!.status).toBe("blocked");
    expect(host.delivered.flat().map((e) => e.type)).toContain("task_blocked");
    expect(host.destroyed.map((d) => d.sessionId)).toEqual(["worker-1"]);
  });

  test("worker cap defers extra spawns without burning attempts, sends still flow", async () => {
    dispatcher.stop();
    dispatcher = makeDispatcher({ maxConcurrentWorkers: 1 });

    const first = enqueueSpawn("first");
    const second = enqueueSpawn("second");
    const send = enqueueSend();
    await dispatcher.tick();

    expect(store.dispatchGet(first)!.status).toBe("running");
    const deferred = store.dispatchGet(second)!;
    expect(deferred.status).toBe("queued");
    expect(deferred.attempts).toBe(0); // scheduling deferral ≠ failure
    expect(store.dispatchGet(send)!.status).toBe("done"); // no starvation

    // First worker finishes → capacity frees → second spawns next tick.
    dispatcher.onSessionStatus("worker-1", "idle");
    await new Promise((r) => setTimeout(r, 0));
    await dispatcher.tick();
    expect(store.dispatchGet(second)!.status).toBe("running");
  });

  test("one capped tenant never starves another tenant's spawns (per-task deferral)", async () => {
    dispatcher.stop();
    dispatcher = makeDispatcher({ maxConcurrentWorkers: 1 });
    const OTHER = { accountId: "acc-b", projectId: "proj-b" };

    // Tenant A saturates its cap, then queues another spawn (oldest queued).
    const a1 = enqueueSpawn("a1");
    await dispatcher.tick();
    expect(store.dispatchGet(a1)!.status).toBe("running");
    const a2 = enqueueSpawn("a2");
    // Tenant B's spawn sits BEHIND tenant A's deferred task in the queue.
    const b1 = enqueueSpawn("b1", OTHER);

    await dispatcher.tick();
    expect(store.dispatchGet(a2)!.status).toBe("queued"); // deferred, no attempt burned
    expect(store.dispatchGet(a2)!.attempts).toBe(0);
    expect(store.dispatchGet(b1)!.status).toBe("running"); // NOT starved
  });

  test("a terminal spawn failure never orphans a surviving worker session", async () => {
    dispatcher.stop();
    dispatcher = makeDispatcher({ failureLimit: 1 });
    const id = enqueueSpawn();
    await dispatcher.tick();
    expect(store.dispatchGet(id)!.status).toBe("running");

    // Crash → new boot reclaims (attempts=1 → will block at limit on next
    // failure) and the continuation THROWS instead of returning false.
    dispatcher.stop();
    dispatcher = makeDispatcher({ failureLimit: 1 });
    host.continueError = new Error("continuation exploded");
    await dispatcher.tick();

    const row = store.dispatchGet(id)!;
    expect(row.status).toBe("blocked");
    // The surviving worker was torn down, not orphaned.
    expect(host.destroyed.map((d) => d.sessionId)).toEqual(["worker-1"]);
  });
});

describe("dispatcher — crash recovery (boot reclaim)", () => {
  test("a task claimed by a dead boot is reclaimed and continued in its surviving worker", async () => {
    const id = enqueueSpawn();
    await dispatcher.tick();
    expect(store.dispatchGet(id)!.status).toBe("running");

    // Simulate a daemon crash: a NEW dispatcher (new boot id) on the same store.
    dispatcher.stop();
    dispatcher = makeDispatcher();
    await dispatcher.tick();

    const row = store.dispatchGet(id)!;
    expect(row.attempts).toBe(1); // the reclaim cost an attempt
    expect(row.status).toBe("running"); // continued in the surviving worker
    expect(host.continued.map((t) => t.id)).toEqual([id]);
  });

  test("when the worker did not survive, the reclaimed task respawns fresh", async () => {
    const id = enqueueSpawn();
    await dispatcher.tick();

    dispatcher.stop();
    dispatcher = makeDispatcher();
    host.continueSucceeds = false; // worker session is gone after restart
    await dispatcher.tick();

    expect(host.continued).toHaveLength(1);
    expect(host.spawned).toHaveLength(2); // original + fresh respawn
    expect(store.dispatchGet(id)!.status).toBe("running");
  });
});

describe("dispatcher — approval wedge + lease", () => {
  test("a wedged worker (waiting_approval) surfaces an event and stops renewing its lease", async () => {
    dispatcher.stop();
    dispatcher = makeDispatcher({ leaseMs: 10_000 });
    const id = enqueueSpawn();
    await dispatcher.tick();

    // Worker wedges on approval — event emitted but delivery deferred to the
    // pump (keepPending), and the lease is no longer renewed.
    host.statuses.set("worker-1", "waiting_approval");
    dispatcher.onSessionStatus("worker-1", "waiting_approval");

    const pending = store.dispatchEventsPending(TENANT.accountId, TENANT.projectId);
    expect(pending.some((e) => e.digest.includes("WAITING FOR APPROVAL"))).toBe(true);
    // Task itself is untouched — the owner can still attach and approve.
    expect(store.dispatchGet(id)!.status).toBe("running");
  });

  test("events held while the conductor is busy deliver on a later tick", async () => {
    host.conductorAcceptsEvents = false;
    const id = enqueueSpawn();
    await dispatcher.tick();
    dispatcher.onSessionStatus("worker-1", "idle");
    await new Promise((r) => setTimeout(r, 0));

    expect(store.dispatchGet(id)!.status).toBe("done");
    expect(host.delivered).toHaveLength(0); // held
    expect(
      store.dispatchEventsPending(TENANT.accountId, TENANT.projectId),
    ).toHaveLength(1);

    host.conductorAcceptsEvents = true;
    await dispatcher.tick();
    expect(host.delivered.flat()).toHaveLength(1);
    expect(
      store.dispatchEventsPending(TENANT.accountId, TENANT.projectId),
    ).toHaveLength(0);
  });
});
