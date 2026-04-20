/**
 * TUI WebSocket client — daemon connection + reducer dispatch.
 *
 * Separated from the React tree so the connection survives focus changes and
 * re-renders. Uses Bun's native WebSocket. Token exchange is identical to the
 * readline client (legacy terminal/client.ts) — we could refactor out the
 * shared logic later; for now correctness beats DRY.
 */

import { randomUUID } from "node:crypto";
import type {
  Attachment,
  ClientMessage,
  DaemonMessage,
  SessionMessage,
  ToolState,
} from "../protocol/types.js";
import { ALL_SCOPES_STRING } from "../protocol/scopes.js";
import type { CodeoidConfig } from "../config.js";
import type { Dispatch } from "react";
import type { TuiAction } from "./types.js";

export class TuiWsClient {
  #config: CodeoidConfig;
  #dispatch: Dispatch<TuiAction>;
  #ws: WebSocket | null = null;
  #pending = new Map<string, (msg: DaemonMessage) => void>();
  #reconnectDelay = 500;
  #stopped = false;

  constructor(config: CodeoidConfig, dispatch: Dispatch<TuiAction>) {
    this.#config = config;
    this.#dispatch = dispatch;
  }

  async start(): Promise<void> {
    await this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#ws?.close();
    this.#ws = null;
  }

  // ── Session operations ────────────────────────────────────────────────

  listSessions(): Promise<DaemonMessage> {
    return this.#request({ type: "session.list", id: randomUUID() });
  }

  createSession(name: string, workdir: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.create", id: randomUUID(), name, workdir });
  }

  attachSession(sessionId: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.attach", id: randomUUID(), sessionId });
  }

  detachSession(sessionId: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.detach", id: randomUUID(), sessionId });
  }

  send(
    sessionId: string,
    text: string,
    attachments?: readonly Attachment[],
  ): Promise<DaemonMessage> {
    return this.#request({
      type: "session.send",
      id: randomUUID(),
      sessionId,
      text,
      attachments:
        attachments && attachments.length > 0 ? [...attachments] : undefined,
    });
  }

  pin(sessionId: string, path: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.pin", id: randomUUID(), sessionId, path });
  }

  unpin(sessionId: string, path: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.unpin", id: randomUUID(), sessionId, path });
  }

  setMode(
    sessionId: string,
    mode: import("../protocol/types.js").SessionMode,
    maxTurns?: number,
  ): Promise<DaemonMessage> {
    return this.#request({
      type: "session.set_mode",
      id: randomUUID(),
      sessionId,
      mode,
      maxTurns,
    });
  }

  interrupt(sessionId: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.interrupt", id: randomUUID(), sessionId });
  }

  approve(sessionId: string, approvalId: string, approved: boolean): Promise<DaemonMessage> {
    return this.#request({
      type: "session.approve",
      id: randomUUID(),
      sessionId,
      approvalId,
      approved,
    });
  }

  destroy(sessionId: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.destroy", id: randomUUID(), sessionId });
  }

  // ── Internals ─────────────────────────────────────────────────────────

  async #connect(): Promise<void> {
    this.#dispatch({ type: "connection.change", state: "connecting" });
    try {
      const token = await this.#getToken();
      this.#ws = new WebSocket(this.#config.daemonUrl);

      this.#ws.onopen = () => {
        this.#ws!.send(JSON.stringify({ token }));
      };

      this.#ws.onmessage = (event) => {
        const raw =
          typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(raw) as DaemonMessage & { type: string; requestId?: string };
        this.#handleMessage(msg);
      };

      this.#ws.onclose = (event) => {
        if (this.#stopped) return;
        if (event.code === 4001 || event.code === 4003) {
          this.#dispatch({ type: "connection.change", state: "error" });
          this.#dispatch({ type: "error", message: `auth failed: ${event.reason}` });
          return;
        }
        this.#dispatch({ type: "connection.change", state: "reconnecting" });
        setTimeout(() => void this.#connect(), this.#reconnectDelay);
        this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 10_000);
      };

      this.#ws.onerror = () => {
        // onclose will fire after onerror; don't double-handle.
      };
    } catch (err) {
      this.#dispatch({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      this.#dispatch({ type: "connection.change", state: "error" });
    }
  }

  #handleMessage(msg: DaemonMessage & { type: string; requestId?: string }): void {
    if (msg.type === "auth.ok") {
      this.#dispatch({ type: "connection.change", state: "connected" });
      this.#reconnectDelay = 500;
      // Fetch session list on connect.
      void this.#refreshSessions();
      return;
    }

    // Responses — settle pending requests.
    if (msg.requestId && this.#pending.has(msg.requestId)) {
      const handler = this.#pending.get(msg.requestId)!;
      this.#pending.delete(msg.requestId);
      handler(msg as DaemonMessage);
      if (msg.type === "session.list.result") {
        const result = msg as Extract<DaemonMessage, { type: "session.list.result" }>;
        this.#dispatch({ type: "sessions.set", sessions: result.sessions });
      }
      return;
    }

    // Broadcast events — fan into the store.
    switch (msg.type) {
      case "session.message": {
        const m = msg as SessionMessage;
        this.#dispatch({ type: "session.message", sessionId: m.sessionId, message: m });
        break;
      }
      case "session.message.delta": {
        const d = msg as {
          sessionId: string;
          messageId: string;
          contentAppend?: string;
          toolStateUpdate?: ToolState;
        };
        this.#dispatch({
          type: "session.delta",
          sessionId: d.sessionId,
          messageId: d.messageId,
          contentAppend: d.contentAppend,
          toolStateUpdate: d.toolStateUpdate,
        });
        break;
      }
      case "session.status_change": {
        const s = msg as { sessionId: string; status: "idle" | "working" | "waiting_approval" | "error" };
        this.#dispatch({ type: "session.status", sessionId: s.sessionId, status: s.status });
        break;
      }
      case "session.info_update": {
        const s = msg as { session: import("../protocol/types.js").SessionInfo };
        this.#dispatch({ type: "session.info", session: s.session });
        break;
      }
      case "scrollback.replay": {
        const s = msg as { sessionId: string; messages: SessionMessage[] };
        this.#dispatch({ type: "session.scrollback", sessionId: s.sessionId, messages: s.messages });
        break;
      }
    }
  }

  async #refreshSessions(): Promise<void> {
    try {
      await this.listSessions();
    } catch {
      // Error already surfaced via dispatch.
    }
  }

  #request(msg: ClientMessage): Promise<DaemonMessage> {
    return new Promise((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }
      const timeout = setTimeout(() => {
        this.#pending.delete(msg.id);
        reject(new Error("Request timeout"));
      }, 30_000);
      this.#pending.set(msg.id, (resp) => {
        clearTimeout(timeout);
        resolve(resp);
      });
      this.#ws.send(JSON.stringify(msg));
    });
  }

  async #getToken(): Promise<string> {
    const token = this.#config.apiKey;
    if (!token) {
      throw new Error(
        "No API key configured. Set CODEOID_API_KEY or add apiKey to ~/.codeoid/config.json.",
      );
    }
    if (!token.startsWith("zid_sk_")) return token;

    const resp = await fetch(`${this.#config.zeroidUrl}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "api_key",
        api_key: token,
        scope: ALL_SCOPES_STRING,
      }),
    });
    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as {
        error?: string;
        error_description?: string;
      };
      throw new Error(
        `Token exchange failed (${resp.status}): ${body.error_description ?? body.error ?? "unknown"}`,
      );
    }
    const data = (await resp.json()) as { access_token: string };
    return data.access_token;
  }
}
