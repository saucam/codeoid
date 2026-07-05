/**
 * CodeoidClient reconnection state machine — the critical multi-frontend
 * reliability core. Driven against a controllable mock WebSocket so we can
 * assert the auth handshake (incl. capability declaration), send gating,
 * request correlation, reconnect-on-drop, heartbeat-triggered recovery, and
 * reconnect-now — without a real daemon.
 *
 * Uses REAL timers with injected tiny timings (the timing knobs exist on
 * ConnectOptions precisely so hosts and tests can tune them) — bun:test has
 * no fake-timer facility. Margins are generous to stay CI-stable.
 *
 * Runs without a DOM, so the browser resume listeners no-op; that path is
 * exercised indirectly via reconnectNow().
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { CodeoidClient } from "./client.js";
import type { ClientStatus, ConnectOptions } from "./client.js";

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
    if (!this.#listeners[type]) this.#listeners[type] = [];
    this.#listeners[type].push(fn);
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Tiny real-timer knobs — fast tests, generous assertion margins. */
const FAST: Partial<ConnectOptions> = {
  heartbeatMs: 40,
  heartbeatTimeoutMs: 25,
  minBackoffMs: 5,
  maxBackoffMs: 15,
};

function makeClient(overrides: Partial<ConnectOptions> = {}): CodeoidClient {
  return new CodeoidClient({ url: "ws://x", token: "t", ...FAST, ...overrides });
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

let savedWebSocket: unknown;
const clients: CodeoidClient[] = [];
function track(c: CodeoidClient): CodeoidClient {
  clients.push(c);
  return c;
}

describe("CodeoidClient", () => {
  beforeEach(() => {
    MockWS.instances = [];
    savedWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = MockWS;
  });
  afterEach(() => {
    // Shut down every client so surviving heartbeat/backoff timers can't
    // fire after the mock is restored and leak into the next test.
    for (const c of clients.splice(0)) {
      try {
        c.shutdown();
      } catch {
        /* ignore */
      }
    }
    (globalThis as Record<string, unknown>).WebSocket = savedWebSocket;
  });

  it("completes the auth handshake and reports connected", async () => {
    const statuses: ClientStatus["kind"][] = [];
    const c = track(makeClient({ token: "tok" }));
    c.onStatus((s) => statuses.push(s.kind));
    const ws = await connectClient(c);

    expect(ws.parsed[0]).toMatchObject({ type: "auth", token: "tok" });
    expect(statuses).toContain("connected");
  });

  it("declares protocol version + capabilities + client name when configured", async () => {
    const c = track(
      makeClient({ capabilities: ["parts", "replay.chunked"], clientName: "test-host/1.0" }),
    );
    const ws = await connectClient(c);
    expect(ws.parsed[0]).toMatchObject({
      type: "auth",
      capabilities: ["parts", "replay.chunked"],
      client: "test-host/1.0",
    });
    expect(typeof ws.parsed[0]?.protocolVersion).toBe("number");
  });

  it("omits capabilities/client for a legacy configuration", async () => {
    const c = track(makeClient());
    const ws = await connectClient(c);
    expect("capabilities" in ws.parsed[0]!).toBe(false);
    expect("client" in ws.parsed[0]!).toBe(false);
  });

  it("gates send() on the connection and writes once connected", async () => {
    const c = track(makeClient());
    expect(() => c.send({ type: "ping", id: "1" })).toThrow(); // not connected
    const ws = await connectClient(c);
    c.send({ type: "session.interrupt", id: "2", sessionId: "s" });
    expect(ws.parsed.some((m) => m.type === "session.interrupt")).toBe(true);
  });

  it("correlates request() responses and rejects on response.error", async () => {
    const c = track(makeClient());
    const ws = await connectClient(c);

    const ok = c.request({ type: "ping", id: "req-1" });
    ws.recv({ type: "response.ok", requestId: "req-1", data: { pong: true } });
    await expect(ok).resolves.toMatchObject({ requestId: "req-1" });

    const bad = c.request({ type: "session.attach", id: "req-2", sessionId: "s" });
    ws.recv({ type: "response.error", requestId: "req-2", error: "nope", code: "not_found" });
    await expect(bad).rejects.toThrow("nope");
  });

  it("resolves waitForResult requests on their typed result frame", async () => {
    const c = track(makeClient());
    const ws = await connectClient(c);
    const p = c.request(
      { type: "session.list", id: "req-3" },
      {
        waitForResult: (m) =>
          m.type === "session.list.result" && m.requestId === "req-3" ? m : undefined,
      },
    );
    // The plain ack must NOT resolve it; the typed result must.
    ws.recv({ type: "response.ok", requestId: "req-3" });
    ws.recv({ type: "session.list.result", requestId: "req-3", sessions: [] });
    const result = await p;
    expect(result).toMatchObject({ type: "session.list.result" });
  });

  it("reconnects automatically after an unexpected drop", async () => {
    const c = track(makeClient());
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
    const seen = { kind: "idle" as ClientStatus["kind"] };
    c.onStatus((s) => {
      seen.kind = s.kind;
    });
    expect(seen.kind).toBe("connected");
  });

  it("rejects in-flight requests when the socket drops (no 30s hang)", async () => {
    const c = track(makeClient());
    const ws = await connectClient(c);
    const p = c.request({ type: "ping", id: "req-4" });
    ws.drop();
    await expect(p).rejects.toThrow(/connection lost/);
  });

  it("detects a dead socket via heartbeat and force-reconnects", async () => {
    const c = track(makeClient());
    const ws1 = await connectClient(c);
    const before = MockWS.instances.length;

    // heartbeatMs(40) fires a ping; no pong → timeout(25) → force reconnect.
    await sleep(120);
    expect(ws1.parsed.some((m) => m.type === "ping")).toBe(true);
    expect(MockWS.instances.length).toBeGreaterThan(before);
  });

  it("reconnectNow() retries immediately instead of waiting out backoff", async () => {
    // Huge backoff floor so only reconnectNow (not the timer) can explain a
    // new attempt within the test window.
    const c = track(makeClient({ minBackoffMs: 60_000, maxBackoffMs: 60_000 }));
    await connectClient(c);
    MockWS.last().drop();
    await flush();
    const afterFirstRetry = MockWS.instances.length; // immediate retry socket
    MockWS.last().drop(); // retry fails too → now sleeping in long backoff
    await flush();

    c.reconnectNow();
    await flush();
    expect(MockWS.instances.length).toBeGreaterThan(afterFirstRetry);
  });

  it("re-exchanges the token via getToken on each (re)connect, with fallback", async () => {
    let n = 0;
    const c = track(
      makeClient({ token: "static-fallback", getToken: async () => `fresh-${++n}` }),
    );
    const ws1 = await connectClient(c);
    expect(ws1.parsed[0]).toMatchObject({ token: "fresh-1" });

    ws1.drop();
    await flush();
    const ws2 = MockWS.last();
    expect(ws2).not.toBe(ws1);
    ws2.open();
    await flush();
    expect(ws2.parsed[0]).toMatchObject({ token: "fresh-2" });
    ws2.recv(AUTH_OK);

    const failing = track(
      makeClient({
        token: "static-fallback",
        getToken: async () => {
          throw new Error("no stored key");
        },
      }),
    );
    const ws3 = await connectClient(failing);
    expect(ws3.parsed[0]).toMatchObject({ token: "static-fallback" });
  });

  it("shutdown() closes, rejects pending requests, and stops reconnecting", async () => {
    const c = track(makeClient());
    const ws = await connectClient(c);
    const p = c.request({ type: "ping", id: "req-5" });
    c.shutdown();
    await expect(p).rejects.toThrow(/shutdown/);
    // A post-shutdown drop must not spawn a new socket.
    const count = MockWS.instances.length;
    ws.drop();
    await sleep(30);
    expect(MockWS.instances.length).toBe(count);
  });
});
