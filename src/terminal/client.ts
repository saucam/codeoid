/**
 * Terminal client — connects to the daemon over WebSocket.
 *
 * Uses Bun's native WebSocket (no ws dependency).
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { CodeoidConfig } from "../config.js";
import type { ClientMessage, DaemonMessage, SessionInfo } from "../protocol/types.js";
import { ALL_SCOPES_STRING } from "../protocol/scopes.js";

export class TerminalClient {
  #config: CodeoidConfig;
  #ws: WebSocket | null = null;
  #pending = new Map<string, (msg: DaemonMessage) => void>();
  #streamHandler: ((msg: DaemonMessage) => void) | null = null;

  constructor(config: CodeoidConfig) {
    this.#config = config;
  }

  async connect(): Promise<void> {
    const token = await this.#getToken();

    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(this.#config.daemonUrl);

      this.#ws.onopen = () => {
        this.#ws!.send(JSON.stringify({ token }));
      };

      this.#ws.onmessage = (event) => {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)) as DaemonMessage & { type: string; requestId?: string };

        if (msg.type === "auth.ok") {
          resolve();
          return;
        }

        if (msg.requestId && this.#pending.has(msg.requestId)) {
          const handler = this.#pending.get(msg.requestId)!;
          this.#pending.delete(msg.requestId);
          handler(msg as DaemonMessage);
          return;
        }

        if (this.#streamHandler) {
          this.#streamHandler(msg as DaemonMessage);
        }
      };

      this.#ws.onerror = (event) => reject(new Error("WebSocket error"));
      this.#ws.onclose = (event) => {
        if (event.code === 4001 || event.code === 4003) {
          reject(new Error(`Auth failed: ${event.reason}`));
        }
      };
    });
  }

  disconnect(): void {
    this.#ws?.close();
    this.#ws = null;
  }

  // ── Commands ──────────────────────────────────────────────────────────

  async listSessions(): Promise<void> {
    const resp = await this.#request({ type: "session.list", id: randomUUID() });

    if (resp.type === "session.list.result") {
      if (resp.sessions.length === 0) {
        console.log("No active sessions.");
        return;
      }
      console.log("\n  Sessions:\n");
      for (const s of resp.sessions) {
        const status = this.#formatStatus(s.status);
        console.log(`  ${s.name.padEnd(20)} ${status.padEnd(20)} ${s.workdir}`);
        console.log(`  ${"".padEnd(20)} id: ${s.id}  clients: ${s.attachedClients}`);
        console.log();
      }
    } else {
      this.#printError(resp);
    }
  }

  async createSession(name: string, workdir: string): Promise<void> {
    const resp = await this.#request({
      type: "session.create",
      id: randomUUID(),
      name,
      workdir,
    });

    if (resp.type === "response.ok") {
      const data = resp.data as SessionInfo;
      console.log(`Session created: ${data.name} (${data.id})`);
    } else {
      this.#printError(resp);
    }
  }

  async attachSession(sessionIdOrName: string): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;

    const resp = await this.#request({
      type: "session.attach",
      id: randomUUID(),
      sessionId,
    });

    if (resp.type !== "response.ok") {
      this.#printError(resp);
      return;
    }

    console.log(`\nAttached to session. Type messages below. Ctrl+C to detach.\n`);

    // Track the latest approval ID for quick yes/no responses
    let latestApprovalId: string | null = null;

    this.#streamHandler = (msg) => {
      switch (msg.type) {
        case "scrollback.replay":
          console.log(`\n--- scrollback (${msg.messages.length} messages) ---`);
          for (const m of msg.messages) {
            if (m.type === "agent.output") process.stdout.write(m.content);
            if (m.type === "agent.tool_call") console.log(`\n[tool] ${m.tool}`);
          }
          console.log(`--- end scrollback ---\n`);
          break;
        case "agent.output":
          process.stdout.write(msg.content);
          break;
        case "agent.tool_call":
          console.log(`\n[tool] ${msg.tool}`);
          break;
        case "agent.approval_request":
          latestApprovalId = msg.approvalId;
          console.log(`\n[approval needed] ${msg.tool}: ${msg.description ?? msg.input}`);
          console.log(`  Type 'yes' to approve, 'no' to deny (id: ${msg.approvalId.slice(0, 8)})`);
          break;
        case "agent.status_change":
          console.log(`\n[status] ${msg.status}`);
          break;
      }
    };

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const cleanup = () => {
      this.#streamHandler = null;
      rl.close();
      this.#request({ type: "session.detach", id: randomUUID(), sessionId }).catch(() => {});
      console.log("\nDetached.");
      this.disconnect();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed === "/detach" || trimmed === "/quit") {
        cleanup();
        break;
      }

      if (trimmed === "/interrupt") {
        await this.#request({ type: "session.interrupt", id: randomUUID(), sessionId });
        continue;
      }

      if ((trimmed === "yes" || trimmed === "no") && latestApprovalId) {
        await this.#request({
          type: "session.approve",
          id: randomUUID(),
          sessionId,
          requestId: latestApprovalId,
          approved: trimmed === "yes",
        });
        latestApprovalId = null;
        continue;
      }

      await this.#request({
        type: "session.send",
        id: randomUUID(),
        sessionId,
        text: trimmed,
      });
    }
  }

  async sendMessage(sessionIdOrName: string, message: string): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;

    const resp = await this.#request({
      type: "session.send",
      id: randomUUID(),
      sessionId,
      text: message,
    });

    if (resp.type === "response.ok") {
      console.log("Message sent.");
    } else {
      this.#printError(resp);
    }
  }

  async interruptSession(sessionIdOrName: string): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;

    const resp = await this.#request({
      type: "session.interrupt",
      id: randomUUID(),
      sessionId,
    });

    if (resp.type === "response.ok") {
      console.log("Session interrupted.");
    } else {
      this.#printError(resp);
    }
  }

  async approveSession(sessionIdOrName: string, approved: boolean): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;

    const resp = await this.#request({
      type: "session.approve",
      id: randomUUID(),
      sessionId,
      requestId: "", // Will fall back to first pending
      approved,
    });

    if (resp.type === "response.ok") {
      console.log(approved ? "Approved." : "Denied.");
    } else {
      this.#printError(resp);
    }
  }

  async destroySession(sessionIdOrName: string): Promise<void> {
    const sessionId = await this.#resolveSession(sessionIdOrName);
    if (!sessionId) return;

    const resp = await this.#request({
      type: "session.destroy",
      id: randomUUID(),
      sessionId,
    });

    if (resp.type === "response.ok") {
      console.log("Session destroyed.");
    } else {
      this.#printError(resp);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  async #resolveSession(nameOrId: string): Promise<string | null> {
    if (nameOrId.includes("-") && nameOrId.length > 30) {
      return nameOrId;
    }

    const resp = await this.#request({ type: "session.list", id: randomUUID() });
    if (resp.type === "session.list.result") {
      const match = resp.sessions.find((s) => s.name === nameOrId);
      if (match) return match.id;
      console.error(`Session not found: ${nameOrId}`);
    } else {
      this.#printError(resp);
    }
    return null;
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
        "No API key configured. Set CODEOID_API_KEY or add apiKey to ~/.codeoid/config.json",
      );
    }

    if (token.startsWith("zid_sk_")) {
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
        throw new Error(`Token exchange failed: ${resp.status}`);
      }

      const data = (await resp.json()) as { access_token: string };
      return data.access_token;
    }

    return token;
  }

  #formatStatus(status: string): string {
    switch (status) {
      case "idle":
        return "\x1b[32midle\x1b[0m";
      case "working":
        return "\x1b[33mworking\x1b[0m";
      case "waiting_approval":
        return "\x1b[31mwaiting approval\x1b[0m";
      case "error":
        return "\x1b[31merror\x1b[0m";
      default:
        return status;
    }
  }

  #printError(resp: DaemonMessage): void {
    if (resp.type === "response.error") {
      console.error(`Error: ${resp.error} (${resp.code})`);
    }
  }
}
