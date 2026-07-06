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
import { sanitizeTerminalOutput } from "../tui/ansi/codes.js";

// ── Stream rendering (pure, exported for tests) ───────────────────────────────

/** SGR framing codes the client emits around content. These are trusted
 *  constants; only the interpolated (untrusted) values are sanitized. */
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Strip terminal-control escapes from an untrusted field before it reaches
 *  the TTY (OSC 52 clipboard, cursor moves, DCS, etc. — see #91/#92). */
const S = (s: string | undefined): string => sanitizeTerminalOutput(s ?? "");

/** Streaming/approval bookkeeping carried across messages by the attach loop. */
export interface StreamRenderState {
  /** messageId last seen via a delta, so the committed assistant message that
   *  follows doesn't double-print content already streamed chunk-by-chunk. */
  streamingAssistantMsgId: string | null;
  /** approvalId of the most recent waiting_confirmation tool call, so a typed
   *  yes/no can be routed to it. */
  latestApprovalId: string | null;
}

export function newStreamRenderState(): StreamRenderState {
  return { streamingAssistantMsgId: null, latestApprovalId: null };
}

/**
 * Render one daemon stream message to the exact bytes the legacy readline
 * client writes to stdout, with every untrusted field (`content`,
 * `identity.name`, `tool.name`, `tool.state.description`, `contentAppend`)
 * run through `sanitizeTerminalOutput`. Mutates `state` for the streaming /
 * approval bookkeeping the caller carries between messages. Pure otherwise —
 * no I/O — so a test can drive it and assert escapes are stripped.
 *
 * A prior `console.log(x)` becomes `x + "\n"`; a prior `process.stdout.write(x)`
 * becomes `x` — byte-for-byte identical to the previous inline rendering.
 */
export function renderStreamMessage(msg: DaemonMessage, state: StreamRenderState): string {
  switch (msg.type) {
    case "scrollback.replay": {
      const m = msg as { messages?: Array<{ type: string; role?: string; content?: string; tool?: { name?: string }; identity?: { name?: string } }> };
      const list = m.messages ?? [];
      let out = `\n--- scrollback (${list.length} messages) ---\n`;
      for (const e of list) {
        if (e.type !== "session.message") continue;
        const id = e.identity?.name ? `${DIM}${S(e.identity.name)}${RESET} ` : "";
        switch (e.role) {
          case "user": out += `\n${id}${CYAN}> ${S(e.content)}${RESET}\n`; break;
          case "assistant": if (e.content) out += `${S(e.content)}\n`; break;
          case "tool_call": out += `\n${id}${YELLOW}⚡ ${S(e.tool?.name ?? e.content)}${RESET}\n`; break;
          case "system": out += `${RED}${S(e.content)}${RESET}\n`; break;
          case "info": out += `${DIM}${S(e.content)}${RESET}\n`; break;
        }
      }
      out += "\n--- end scrollback ---\n\n";
      return out;
    }

    case "session.message": {
      const sm = msg as { role?: string; content?: string; messageId?: string; tool?: { name?: string; state?: { phase?: string; approvalId?: string; description?: string } }; identity?: { name?: string; type?: string } };
      const id = sm.identity?.name ? `${DIM}${S(sm.identity.name)}${RESET} ` : "";
      switch (sm.role) {
        case "user":
          return `\n${id}${CYAN}> ${S(sm.content)}${RESET}\n`;
        case "assistant": {
          const msgId = sm.messageId;
          if (msgId && msgId === state.streamingAssistantMsgId) {
            state.streamingAssistantMsgId = null;
            return "\n";
          }
          if (sm.content) return `${S(sm.content)}\n`;
          return "";
        }
        case "thinking":
          return `${DIM}${S(sm.content)}${RESET}`;
        case "tool_call": {
          const phase = sm.tool?.state?.phase ?? "executing";
          const name = S(sm.tool?.name ?? sm.content);
          if (phase === "waiting_confirmation") {
            state.latestApprovalId = sm.tool?.state?.approvalId ?? null;
            return `\n${id}${RED}⚡ ${name}: ${S(sm.tool?.state?.description)}${RESET}\n  Type 'yes' to approve, 'no' to deny\n`;
          }
          return `\n${id}${YELLOW}⚡ ${name} [${phase}]${RESET}\n`;
        }
        case "system":
          return `\n${RED}${S(sm.content)}${RESET}\n`;
        case "info":
          return `${DIM}${S(sm.content)}${RESET}\n`;
      }
      return "";
    }

    case "session.message.delta": {
      const delta = msg as { contentAppend?: string; messageId?: string; toolStateUpdate?: { phase?: string } };
      if (delta.messageId) state.streamingAssistantMsgId = delta.messageId;
      let out = "";
      if (delta.contentAppend) out += S(delta.contentAppend);
      if (delta.toolStateUpdate) out += `${YELLOW}  → ${delta.toolStateUpdate.phase}${RESET}\n`;
      return out;
    }

    case "session.status_change": {
      const sc = msg as { status?: string };
      return `\n[status] ${sc.status}\n`;
    }
  }
  return "";
}

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

    return new Promise((resolve, _reject) => {
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

      this.#ws.onerror = () => {
        console.error(`Cannot connect to Codeoid daemon at ${this.#config.daemonUrl}`);
        console.error("  Is the daemon running? Try: codeoid start\n");
        process.exit(1);
      };
      this.#ws.onclose = (event) => {
        if (event.code === 4001) {
          console.error("Authentication timeout — daemon did not accept credentials.\n");
          process.exit(1);
        }
        if (event.code === 4003) {
          console.error("Authentication failed — token is invalid or expired.");
          console.error(`  ${event.reason}`);
          console.error("  Try logging in again or check your API key.\n");
          process.exit(1);
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

    console.log("\nAttached to session. Type messages below. Ctrl+C to detach.\n");

    // Streaming/approval bookkeeping, carried across messages. `latestApprovalId`
    // is read below to route a typed yes/no; both fields are mutated by
    // renderStreamMessage, which also sanitizes every untrusted field before it
    // reaches the TTY (OSC/CSI/DCS escapes — see #91/#92).
    const renderState = newStreamRenderState();

    this.#streamHandler = (msg) => {
      const out = renderStreamMessage(msg, renderState);
      if (out) process.stdout.write(out);
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

      if ((trimmed === "yes" || trimmed === "no") && renderState.latestApprovalId) {
        await this.#request({
          type: "session.approve",
          id: randomUUID(),
          sessionId,
          approvalId: renderState.latestApprovalId,
          approved: trimmed === "yes",
        });
        renderState.latestApprovalId = null;
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
      approvalId: "", // Will fall back to first pending
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
      console.error("No API key configured.\n");
      console.error("  Set CODEOID_API_KEY environment variable");
      console.error("  Or add apiKey to ~/.codeoid/config.json");
      console.error("  Or run: codeoid login\n");
      process.exit(1);
    }

    if (token.startsWith("zid_sk_")) {
      let resp: Response;
      try {
        resp = await fetch(`${this.#config.zeroidUrl}/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "api_key",
            api_key: token,
            scope: ALL_SCOPES_STRING,
          }),
        });
      } catch (err) {
        console.error(`Cannot reach ZeroID at ${this.#config.zeroidUrl}`);
        console.error(`  Is ZeroID running? Try: curl ${this.#config.zeroidUrl}/health\n`);
        process.exit(1);
      }

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as { error?: string; error_description?: string };
        if (resp.status === 400 || resp.status === 401) {
          console.error("Authentication failed — API key is invalid or expired.\n");
          if (body.error_description) console.error(`  ${body.error_description}`);
          console.error("  Re-register your agent in ZeroID or check CODEOID_API_KEY\n");
        } else {
          console.error(`Token exchange failed (${resp.status}): ${body.error_description ?? body.error ?? "unknown"}`);
        }
        process.exit(1);
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
