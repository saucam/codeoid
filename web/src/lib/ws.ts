/**
 * Codeoid daemon WebSocket client.
 *
 * Owns the entire transport lifecycle — connect, auth handshake, request /
 * response correlation, broadcast subscription, exponential-backoff reconnect.
 * Components subscribe to `onMessage` and call typed verb wrappers; they
 * never touch the raw socket.
 *
 * Auth flow on connect: client sends `auth.hello { token }` immediately, then
 * waits for `auth.ok` before resolving the connect promise. Mirrors the Rust
 * client.
 */

import type {
  AuthOkMsg,
  ClientMessage,
  DaemonMessage,
  ResponseErrorMsg,
  ResponseOkMsg,
} from "../protocol/types";

export type ClientStatus =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "connected"; auth: AuthOkMsg }
  | { kind: "reconnecting"; attempt: number; nextInMs: number; reason: string }
  | { kind: "failed"; reason: string };

export interface ConnectOptions {
  url: string; // ws://host:port — daemon's WS endpoint
  token: string;
  /** Bounded reconnect attempts; once exhausted we land in `failed`. */
  maxAttempts?: number;
  /** Logger for transport-level diagnostics. */
  log?: (level: "debug" | "info" | "warn" | "error", msg: string, ctx?: unknown) => void;
}

type StatusHandler = (status: ClientStatus) => void;
type MessageHandler = (msg: DaemonMessage) => void;

interface PendingRequest {
  resolve: (ok: ResponseOkMsg) => void;
  reject: (err: ResponseErrorMsg | Error) => void;
  /** When true, ResponseOk/Error doesn't resolve — we wait for a typed result message. */
  waitForResult?: (msg: DaemonMessage) => DaemonMessage | undefined;
  /** Aborts auto-reject after timeoutMs. */
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** Decorrelated jitter envelope: pick uniformly in [min, computed * factor]. */
const JITTER_FACTOR = 1.5;
/** Liveness heartbeat — detects a half-open socket the browser never closed. */
const HEARTBEAT_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 8_000;

export class CodeoidClient {
  #opts: ConnectOptions;
  #ws: WebSocket | null = null;
  #pending = new Map<string, PendingRequest>();
  #statusHandlers = new Set<StatusHandler>();
  #messageHandlers = new Set<MessageHandler>();
  #status: ClientStatus = { kind: "idle" };
  #reqCounter = 0;
  #shutdown = false;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Resolver that interrupts the current backoff sleep (reconnect-now). */
  #wake: (() => void) | null = null;
  /** True while a connect loop is running (prevents concurrent loops). */
  #connecting = false;
  #resumeWired = false;
  #onResume: (() => void) | null = null;

  constructor(opts: ConnectOptions) {
    this.#opts = opts;
  }

  /** Subscribe to status changes. Returns an unsubscribe fn. */
  onStatus(handler: StatusHandler): () => void {
    this.#statusHandlers.add(handler);
    handler(this.#status);
    return () => this.#statusHandlers.delete(handler);
  }

  /** Subscribe to incoming daemon messages. Returns an unsubscribe fn. */
  onMessage(handler: MessageHandler): () => void {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  /** Connect and complete the auth handshake. Resolves on `auth.ok`. */
  async connect(): Promise<AuthOkMsg> {
    this.#wireResumeListeners();
    if (this.#status.kind === "connected") return this.#status.auth;
    return this.#connectWithBackoff(1);
  }

  /**
   * Reconnect immediately — used on resume (tab focus / network online /
   * webview unsuspend). If a backoff sleep is in progress, wake it so we
   * retry now instead of waiting out the timer; if no loop is running and
   * we're not connected, start one.
   */
  reconnectNow(): void {
    if (this.#shutdown || this.#status.kind === "connected") return;
    if (this.#wake) {
      this.#wake();
    } else if (!this.#connecting) {
      void this.#connectWithBackoff(1).catch((e) =>
        this.#log("error", "reconnect failed", { e }),
      );
    }
  }

  /** Send a fire-and-forget client message. */
  send(msg: ClientMessage): void {
    if (this.#status.kind !== "connected") {
      throw new Error(`cannot send while ${this.#status.kind}`);
    }
    this.#ws!.send(JSON.stringify(msg));
  }

  /**
   * Send a request and resolve with the daemon's response. By default the
   * `response.ok`/`response.error` for the request id resolves the promise;
   * pass `waitForResult` to instead resolve on a typed broadcast (e.g.
   * `session.list.result`) that carries `requestId`.
   */
  request<T extends DaemonMessage = ResponseOkMsg>(
    msg: ClientMessage,
    options: { timeoutMs?: number; waitForResult?: (m: DaemonMessage) => T | undefined } = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.#status.kind !== "connected") {
        reject(new Error(`cannot request while ${this.#status.kind}`));
        return;
      }
      const id = msg.id;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`request ${id} timed out`));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      this.#pending.set(id, {
        resolve: (ok) => resolve(ok as unknown as T),
        reject: (e) => reject(e instanceof Error ? e : new Error(e.error)),
        waitForResult: options.waitForResult,
        timer,
      });
      this.#ws!.send(JSON.stringify(msg));
    });
  }

  /** Generate a unique request id. Monotonic + random suffix for safety across reconnects. */
  nextId(): string {
    this.#reqCounter += 1;
    return `${Date.now().toString(36)}-${this.#reqCounter}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Close the connection. No further reconnects after this. */
  shutdown(): void {
    this.#shutdown = true;
    this.#stopHeartbeat();
    this.#unwireResumeListeners();
    this.#wake?.();
    if (this.#ws) {
      try {
        this.#ws.close(1000, "client shutdown");
      } catch {
        /* ignore */
      }
      this.#ws = null;
    }
    for (const [, p] of this.#pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("client shutdown"));
    }
    this.#pending.clear();
    this.#setStatus({ kind: "idle" });
  }

  // ---------- internals ----------

  #setStatus(next: ClientStatus): void {
    this.#status = next;
    for (const h of this.#statusHandlers) h(next);
  }

  #log(level: "debug" | "info" | "warn" | "error", msg: string, ctx?: unknown): void {
    this.#opts.log?.(level, msg, ctx);
  }

  async #connectWithBackoff(attempt: number): Promise<AuthOkMsg> {
    // `maxAttempts: 0` (or undefined) means "never give up" — the
    // common case is a laptop lid closing for an hour, the daemon
    // bouncing during dev, or a flaky home wifi. Capping at 5
    // attempts used to leave the user staring at "failed" until
    // they refreshed; that's worse than waiting longer between
    // attempts. Callers that explicitly want a bound can still set
    // `maxAttempts` to a positive number.
    const max = this.#opts.maxAttempts ?? 0;
    const isBounded = max > 0;
    if (this.#connecting) {
      // A loop is already running — don't start a second.
      throw new Error("connect already in progress");
    }
    this.#connecting = true;
    try {
      while (!this.#shutdown && (!isBounded || attempt <= max)) {
        try {
          this.#setStatus({ kind: "connecting", attempt });
          const auth = await this.#connectOnce();
          this.#setStatus({ kind: "connected", auth });
          this.#startHeartbeat();
          return auth;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (isBounded && attempt >= max) {
            this.#setStatus({ kind: "failed", reason });
            throw err;
          }
          // Exponential backoff with full jitter — picks uniformly in
          // [MIN_BACKOFF_MS, computed * JITTER_FACTOR] to break thundering
          // herds when many clients reconnect at once (post-restart) and
          // to avoid the "wakes up exactly on the second" pattern.
          const ceiling = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (attempt - 1));
          const upper = Math.min(MAX_BACKOFF_MS, Math.floor(ceiling * JITTER_FACTOR));
          const backoff = MIN_BACKOFF_MS + Math.floor(Math.random() * (upper - MIN_BACKOFF_MS));
          this.#log("warn", `connect attempt ${attempt} failed: ${reason}; retry in ${backoff}ms`);
          this.#setStatus({ kind: "reconnecting", attempt, nextInMs: backoff, reason });
          await this.#sleep(backoff);
          attempt += 1;
        }
      }
    } finally {
      this.#connecting = false;
    }
    throw new Error("shutdown during reconnect");
  }

  /** Backoff sleep that `reconnectNow()` can interrupt via `#wake`. */
  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, ms);
      this.#wake = () => {
        clearTimeout(t);
        this.#wake = null;
        resolve();
      };
    });
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      void this.#heartbeat();
    }, HEARTBEAT_MS);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  /** Ping the daemon; a missed pong means the socket is dead → reconnect. */
  async #heartbeat(): Promise<void> {
    if (this.#status.kind !== "connected") return;
    try {
      await this.request(
        { type: "ping", id: this.nextId() },
        { timeoutMs: HEARTBEAT_TIMEOUT_MS },
      );
    } catch {
      this.#log("warn", "heartbeat failed — socket is dead, forcing reconnect");
      this.#forceReconnect();
    }
  }

  /** Tear down a presumed-dead socket and reconnect from attempt 1. */
  #forceReconnect(): void {
    if (this.#shutdown) return;
    this.#stopHeartbeat();
    const ws = this.#ws;
    this.#ws = null; // so onClose for this socket short-circuits (no double kick)
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    for (const [, p] of this.#pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("connection reset"));
    }
    this.#pending.clear();
    if (!this.#connecting) {
      void this.#connectWithBackoff(1).catch((e) =>
        this.#log("error", "reconnect failed", { e }),
      );
    }
  }

  /**
   * Reconnect/revalidate on resume — tab focus, network online, or a
   * suspended webview waking. Mobile webviews (Telegram Mini App) freeze the
   * socket without a close event, so on resume we either reconnect (if down)
   * or fire an immediate heartbeat to detect a zombie socket.
   */
  #wireResumeListeners(): void {
    if (this.#resumeWired || typeof window === "undefined") return;
    this.#resumeWired = true;
    const onResume = () => {
      if (this.#shutdown) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      if (this.#status.kind === "connected") {
        void this.#heartbeat();
      } else {
        this.reconnectNow();
      }
    };
    this.#onResume = onResume;
    window.addEventListener("online", onResume);
    window.addEventListener("focus", onResume);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onResume);
    }
  }

  #unwireResumeListeners(): void {
    if (!this.#onResume || typeof window === "undefined") return;
    window.removeEventListener("online", this.#onResume);
    window.removeEventListener("focus", this.#onResume);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.#onResume);
    }
    this.#onResume = null;
    this.#resumeWired = false;
  }

  #connectOnce(): Promise<AuthOkMsg> {
    return new Promise<AuthOkMsg>((resolve, reject) => {
      const ws = new WebSocket(this.#opts.url);
      this.#ws = ws;

      let authResolved = false;
      const onOpen = () => {
        // Daemon requires the first frame to carry an auth token. Shape
        // matches the existing Rust client: `{ type: "auth", token }`.
        // (Daemon only checks the `token` field; `type` is ignored.)
        ws.send(JSON.stringify({ type: "auth", token: this.#opts.token }));
      };
      const onMessage = (ev: MessageEvent<string>) => {
        let msg: DaemonMessage;
        try {
          msg = JSON.parse(ev.data) as DaemonMessage;
        } catch (err) {
          this.#log("error", "non-JSON frame from daemon", { err });
          return;
        }
        if (!authResolved && msg.type === "auth.ok") {
          authResolved = true;
          resolve(msg);
          // From here on, dispatch normally.
          this.#routeMessage(msg);
          return;
        }
        if (!authResolved && msg.type === "response.error") {
          authResolved = true;
          reject(new Error(`auth rejected: ${msg.error}`));
          return;
        }
        this.#routeMessage(msg);
      };
      const onClose = (ev: CloseEvent) => {
        const reason = ev.reason || `socket closed (code ${ev.code})`;
        if (!authResolved) {
          reject(new Error(reason));
          return;
        }
        if (this.#shutdown) return;
        // If this isn't the current socket, a forceReconnect/newer connect
        // already took over — don't kick a second reconnect loop.
        if (this.#ws !== ws) return;
        this.#stopHeartbeat();
        // Reject any in-flight requests so the UI doesn't hang on a
        // dead socket waiting for the 30s default timeout — drawers
        // and modals freeze otherwise. Reconnect kicks off below; the
        // caller can simply retry once `connected` returns.
        for (const [, p] of this.#pending) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(new Error(`connection lost (${reason})`));
        }
        this.#pending.clear();
        this.#log("warn", "connection dropped, attempting reconnect", { code: ev.code });
        // Asynchronously kick off reconnect — caller already moved on.
        if (!this.#connecting) {
          void this.#connectWithBackoff(1).catch((e) => {
            this.#log("error", "reconnect exhausted", { e });
          });
        }
      };
      const onError = (ev: Event) => {
        if (!authResolved) reject(new Error("websocket error during connect"));
        this.#log("error", "websocket error", { ev });
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    });
  }

  #routeMessage(msg: DaemonMessage): void {
    // Request/response correlation first.
    if (msg.type === "response.ok" || msg.type === "response.error") {
      const pending = this.#pending.get(msg.requestId);
      if (pending) {
        if (msg.type === "response.ok" && !pending.waitForResult) {
          if (pending.timer) clearTimeout(pending.timer);
          this.#pending.delete(msg.requestId);
          pending.resolve(msg);
          return;
        }
        if (msg.type === "response.error") {
          if (pending.timer) clearTimeout(pending.timer);
          this.#pending.delete(msg.requestId);
          pending.reject(msg);
          return;
        }
      }
    }
    // Typed result correlation: list/search/etc carry their own requestId.
    for (const [id, pending] of this.#pending) {
      if (pending.waitForResult) {
        const matched = pending.waitForResult(msg);
        if (matched) {
          if (pending.timer) clearTimeout(pending.timer);
          this.#pending.delete(id);
          pending.resolve(matched as ResponseOkMsg);
          break;
        }
      }
    }
    for (const h of this.#messageHandlers) h(msg);
  }
}
