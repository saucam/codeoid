/**
 * CodeoidClient reconnection state machine — the critical multi-frontend
 * reliability core. Driven against a controllable mock WebSocket so we can
 * assert auth handshake, send gating, reconnect-on-drop, heartbeat-triggered
 * recovery from a dead socket, and reconnect-now — without a real daemon.
 *
 * Runs in the `node` test env (no DOM), so the resume listeners no-op; those
 * are exercised indirectly via reconnectNow().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodeoidClient } from "./ws";
import type { ClientStatus } from "./ws";

// ── Controllable mock WebSocket ───────────────────────────────────────────

type Listener = (ev: unknown) => void;

class MockWS {
  static instances: MockWS[] = [];
  static last(): MockWS {
    const w = MockWS.instances[MockWS.instances.length - 1];
    if (!w) throw new Error("no MockWS instance");
    return w;
  }

  readyState = 0;
  sent: string[] = [];
  #listeners: Record<string, Listener[]> = {};

  constructor(public url: string) {
    MockWS.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    (this.#listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.#listeners[type] = (this.#listeners[type] ?? []).filter((f) => f !== fn);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", { code, reason });
  }

  // ── test drivers ──
  open(): void {
    this.readyState = 1;
    this.#emit("open", {});
  }
  recv(obj: unknown): void {
    this.#emit("message", { data: JSON.stringify(obj) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.#emit("close", { code, reason: "dropped" });
  }
  get parsed(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
  #emit(type: string, ev: unknown): void {
    for (const f of this.#listeners[type] ?? []) f(ev);
  }
}

const AUTH_OK = { type: "auth.ok", identity: { sub: "u" }, scopes: [] };

async function flush(): Promise<void> {
  // Let queued microtasks (promise continuations) run.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Drive a client to `connected` against the freshest mock socket. */
async function connectClient(c: CodeoidClient): Promise<MockWS> {
  const p = c.connect();
  await flush();
  const ws = MockWS.last();
  ws.open();
  await flush();
  ws.recv(AUTH_OK);
  await p;
  return ws;
}

describe("CodeoidClient", () => {
  beforeEach(() => {
    MockWS.instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWS;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes the auth handshake and reports connected", async () => {
    const statuses: ClientStatus["kind"][] = [];
    const c = new CodeoidClient({ url: "ws://x", token: "tok" });
    c.onStatus((s) => statuses.push(s.kind));
    const ws = await connectClient(c);

    expect(ws.parsed[0]).toMatchObject({ token: "tok" }); // auth frame first
    expect(statuses).toContain("connected");
  });

  it("gates send() on the connection and writes once connected", async () => {
    const c = new CodeoidClient({ url: "ws://x", token: "t" });
    expect(() => c.send({ type: "ping", id: "1" })).toThrow(); // not connected
    const ws = await connectClient(c);
    c.send({ type: "session.interrupt", id: "2", sessionId: "s" });
    expect(ws.parsed.some((m) => m.type === "session.interrupt")).toBe(true);
  });

  it("reconnects automatically after an unexpected drop", async () => {
    const c = new CodeoidClient({ url: "ws://x", token: "t" });
    await connectClient(c);
    expect(MockWS.instances.length).toBe(1);

    MockWS.last().drop(); // socket dies
    await flush();
    // First reconnect attempt opens a new socket immediately (no pre-backoff).
    expect(MockWS.instances.length).toBe(2);

    const ws2 = MockWS.last();
    ws2.open();
    await flush();
    ws2.recv(AUTH_OK);
    await flush();
    let kind: ClientStatus["kind"] = "idle";
    c.onStatus((s) => (kind = s.kind));
    expect(kind).toBe("connected");
  });

  it("detects a dead socket via heartbeat and force-reconnects", async () => {
    const c = new CodeoidClient({ url: "ws://x", token: "t" });
    const ws1 = await connectClient(c);
    const before = MockWS.instances.length;

    // Heartbeat interval fires → a ping is sent.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws1.parsed.some((m) => m.type === "ping")).toBe(true);

    // No pong → the request times out → forceReconnect opens a new socket.
    await vi.advanceTimersByTimeAsync(8_000);
    await flush();
    expect(MockWS.instances.length).toBeGreaterThan(before);
  });

  it("reconnectNow() retries immediately instead of waiting out backoff", async () => {
    const c = new CodeoidClient({ url: "ws://x", token: "t" });
    await connectClient(c);
    // Drop, let the first immediate retry happen and fail so we enter backoff.
    MockWS.last().drop();
    await flush();
    const afterFirstRetry = MockWS.instances.length; // 2 (retry socket opened)
    MockWS.last().drop(); // retry socket also fails → now sleeping in backoff
    await flush();

    // Without advancing timers, reconnectNow wakes the sleep → new attempt.
    c.reconnectNow();
    await flush();
    expect(MockWS.instances.length).toBeGreaterThan(afterFirstRetry);
  });

  it("does not spawn duplicate reconnect loops on force-reconnect", async () => {
    const c = new CodeoidClient({ url: "ws://x", token: "t" });
    const ws1 = await connectClient(c);
    await vi.advanceTimersByTimeAsync(20_000); // heartbeat ping
    await vi.advanceTimersByTimeAsync(8_000); // timeout → forceReconnect
    await flush();
    // Exactly one new socket from the single forceReconnect (not two).
    expect(MockWS.instances.length).toBe(2);
    void ws1;
  });
});
