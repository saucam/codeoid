/**
 * Connection state — owns the singleton CodeoidClient and exposes a Solid
 * signal for current connection status.
 *
 * `bootstrap()` is the one-shot entrypoint App.tsx calls on mount. It
 * resolves the access token, instantiates the client, wires daemon
 * broadcasts into the message / session stores, and triggers an initial
 * `session.list`. Subsequent reconnects are handled inside the client.
 */

import { createSignal } from "solid-js";

import { resolveToken } from "../lib/auth";
import { CodeoidClient, type ClientStatus } from "../lib/ws";
import type {
  AuthOkMsg,
  ClientMessage,
  DaemonMessage,
  SessionInfo,
  SessionListResultMsg,
} from "../protocol/types";

import { ingestSessionList, mergeSession, setSessionStatus } from "./sessions";
import {
  applyDelta,
  applyMessage,
  replaceScrollback,
} from "./messages";

const DAEMON_URL =
  (import.meta.env.VITE_CODEOID_URL as string | undefined) ??
  "ws://127.0.0.1:7400";
// Empty default → auth.ts uses a same-origin /oauth2/token URL that
// Vite's dev proxy (or a prod ingress) forwards to ZeroID. Set
// VITE_ZEROID_URL only if you intentionally want a cross-origin
// exchange and ZeroID is sending CORS headers.
const ZEROID_URL =
  (import.meta.env.VITE_ZEROID_URL as string | undefined) ?? "";

const [status, setStatus] = createSignal<ClientStatus>({ kind: "idle" });
const [auth, setAuth] = createSignal<AuthOkMsg | null>(null);
const [bootError, setBootError] = createSignal<string | null>(null);

export const connectionStatus = status;
export const authIdentity = auth;
export const bootstrapError = bootError;

let client: CodeoidClient | null = null;

/** Public — every command verb funnels through one of these helpers so the
 * components don't reach into the WS client directly. */
export function getClient(): CodeoidClient {
  if (!client) throw new Error("client not bootstrapped — call bootstrap() first");
  return client;
}

/** Convenience: build a fresh request id. */
export function newRequestId(): string {
  return getClient().nextId();
}

/** Send a fire-and-forget message. */
export function send(msg: ClientMessage): void {
  getClient().send(msg);
}

/** Send a message and await `response.ok`. Throws on `response.error`. */
export function request(msg: ClientMessage, timeoutMs?: number): Promise<unknown> {
  return getClient().request(msg, { timeoutMs });
}

/** Fetch the current session list and merge into the store. */
export async function refreshSessions(): Promise<SessionInfo[]> {
  const c = getClient();
  const id = c.nextId();
  const result = await c.request<SessionListResultMsg>(
    { type: "session.list", id },
    {
      waitForResult: (m) =>
        m.type === "session.list.result" && m.requestId === id ? m : undefined,
    },
  );
  ingestSessionList(result.sessions);
  return result.sessions;
}

/**
 * Bootstrap: resolve token → instantiate client → connect → wire broadcasts
 * → hydrate sessions. Returns once the connection is live.
 */
export async function bootstrap(opts: { apiKey?: string; token?: string } = {}): Promise<void> {
  setBootError(null);
  // Tear down any prior client BEFORE creating a new one. Without
  // this, calling bootstrap twice (a stale key being replaced, the
  // user re-entering a different one, or a recovery retry) leaves the
  // old CodeoidClient running its own reconnect loop in parallel with
  // the new one — every broadcast double-fires and neither gets
  // garbage-collected.
  if (client) {
    try {
      client.shutdown();
    } catch {
      /* shutdown is best-effort */
    }
    client = null;
  }
  try {
    const resolved = await resolveToken({
      apiKey: opts.apiKey,
      token: opts.token,
      zeroidUrl: ZEROID_URL,
    });

    client = new CodeoidClient({
      url: DAEMON_URL,
      token: resolved.token,
      log: (level, msg, ctx) => {
        // Vite passes through to the browser console; keep the prefix
        // consistent so devtools filters work.
        const tag = `[codeoid:ws]`;
        if (level === "error") console.error(tag, msg, ctx);
        else if (level === "warn") console.warn(tag, msg, ctx);
        else console.debug(tag, msg, ctx);
      },
    });

    client.onStatus(setStatus);
    client.onMessage(routeBroadcast);

    const ok = await client.connect();
    setAuth(ok);

    // Initial population.
    await refreshSessions().catch((err) => {
      console.error("[codeoid:bootstrap] session.list failed:", err);
    });
    // Fetch the live model catalog (best-effort, non-blocking). Dynamic
    // import avoids a static connection<->models import cycle.
    void import("./models").then((m) => m.fetchModels()).catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setBootError(msg);
    throw err;
  }
}

/** Tear down the connection (sign-out / page hide / explicit disconnect). */
export function disconnect(): void {
  if (client) {
    client.shutdown();
    client = null;
  }
  setAuth(null);
}

// ---------- broadcast routing ----------

function routeBroadcast(msg: DaemonMessage): void {
  switch (msg.type) {
    case "session.message":
      applyMessage(msg);
      return;
    case "session.message.delta":
      applyDelta(msg);
      return;
    case "scrollback.replay":
      replaceScrollback(msg.sessionId, msg.messages);
      return;
    case "session.info_update":
      mergeSession(msg.session);
      return;
    case "session.status_change":
      setSessionStatus(msg.sessionId, msg.status);
      return;
    case "session.list.result":
      ingestSessionList(msg.sessions);
      return;
    // Solicited types resolve via the request registry; nothing to do here.
    case "auth.ok":
    case "response.ok":
    case "response.error":
    case "session.search.result":
      return;
  }
}

// Useful for testing without a real socket.
export function _setClientForTest(stub: CodeoidClient | null): void {
  client = stub;
}

declare global {
  interface ImportMetaEnv {
    readonly VITE_CODEOID_URL?: string;
    readonly VITE_ZEROID_URL?: string;
  }
}
