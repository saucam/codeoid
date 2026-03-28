/**
 * Session — wraps a single Claude Agent SDK query (one agent working in one repo).
 *
 * Manages the agent lifecycle, streams output to all attached clients, and
 * routes permission requests to clients for approval.
 */

import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type {
  AuthContext,
  SessionInfo,
  SessionStatus,
  DaemonMessage,
} from "../protocol/types.js";
import type { Store } from "./store.js";

/** A connected client that can receive messages from this session. */
export interface AttachedClient {
  id: string;
  auth: AuthContext;
  send(msg: DaemonMessage): void;
}

export interface SessionCreateOptions {
  name: string;
  workdir: string;
  auth: AuthContext;
  store: Store;
}

export class Session {
  readonly id: string;
  readonly name: string;
  readonly workdir: string;
  readonly createdBy: string;
  readonly createdAt: string;

  #status: SessionStatus = "idle";
  #clients = new Map<string, AttachedClient>();
  #store: Store;
  #query: Query | null = null;
  #abortController: AbortController | null = null;

  constructor(opts: SessionCreateOptions) {
    this.id = randomUUID();
    this.name = opts.name;
    this.workdir = opts.workdir;
    this.createdBy = opts.auth.sub;
    this.createdAt = new Date().toISOString();
    this.#store = opts.store;

    this.#store.createSession({
      ...this.toInfo(),
      accountId: opts.auth.accountId,
      projectId: opts.auth.projectId,
    });
    this.#store.audit(opts.auth.sub, "session.create", this.id, `name=${this.name}`);
  }

  get status(): SessionStatus {
    return this.#status;
  }

  get attachedClientCount(): number {
    return this.#clients.size;
  }

  // ── Client management ─────────────────────────────────────────────────

  attach(client: AttachedClient): void {
    this.#clients.set(client.id, client);
    this.#store.audit(client.auth.sub, "session.attach", this.id);
  }

  detach(clientId: string): void {
    const client = this.#clients.get(clientId);
    if (client) {
      this.#store.audit(client.auth.sub, "session.detach", this.id);
      this.#clients.delete(clientId);
    }
  }

  // ── Agent interaction ─────────────────────────────────────────────────

  /**
   * Send a prompt to the agent and stream output to all attached clients.
   */
  async send(text: string, sender: AuthContext): Promise<void> {
    this.#store.audit(sender.sub, "session.send", this.id);
    this.#setStatus("working");

    this.#abortController = new AbortController();

    this.#query = query({
      prompt: text,
      options: {
        cwd: this.workdir,
        abortController: this.#abortController,
        allowedTools: ["Read", "Grep", "Glob", "Write", "Edit", "Agent"],
        permissionMode: "default",
        includePartialMessages: false,
        persistSession: true,
        sessionId: this.id,
        settingSources: ["project"],
        canUseTool: async (toolName, input) => {
          // Surface permission request to attached clients
          const timestamp = new Date().toISOString();
          this.#broadcast({
            type: "agent.approval_request",
            sessionId: this.id,
            tool: toolName,
            input: JSON.stringify(input),
            timestamp,
          });
          this.#setStatus("waiting_approval");

          // Wait for approval from any attached client
          const result = await this.#waitForApproval();
          this.#setStatus("working");

          if (result) {
            this.#store.audit(sender.sub, "session.approve", this.id, `tool=${toolName}`);
            return { behavior: "allow" as const };
          }
          this.#store.audit(sender.sub, "session.deny", this.id, `tool=${toolName}`);
          return { behavior: "deny" as const, message: "Denied by user" };
        },
      },
    });

    try {
      for await (const msg of this.#query) {
        this.#handleAgentMessage(msg);
      }
    } catch (err) {
      if (!this.#abortController.signal.aborted) {
        this.#setStatus("error");
        this.#broadcast({
          type: "agent.output",
          sessionId: this.id,
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: new Date().toISOString(),
        });
      }
    } finally {
      this.#query = null;
      this.#abortController = null;
      if (this.#status !== "error") {
        this.#setStatus("idle");
      }
    }
  }

  /**
   * Interrupt the running agent.
   */
  interrupt(sender: AuthContext): void {
    this.#store.audit(sender.sub, "session.interrupt", this.id);
    this.#abortController?.abort();
    this.#resolveApproval?.(false);
  }

  /**
   * Respond to a pending approval request.
   */
  approve(approved: boolean, sender: AuthContext): void {
    this.#store.audit(
      sender.sub,
      approved ? "session.approve" : "session.deny",
      this.id,
    );
    this.#resolveApproval?.(approved);
  }

  /**
   * Destroy this session — kills the agent and cleans up.
   */
  destroy(sender: AuthContext): void {
    this.#store.audit(sender.sub, "session.destroy", this.id);
    this.#abortController?.abort();
    this.#resolveApproval?.(false);
    this.#clients.clear();
    this.#store.deleteSession(this.id);
  }

  toInfo(): SessionInfo {
    return {
      id: this.id,
      name: this.name,
      workdir: this.workdir,
      status: this.#status,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      attachedClients: this.#clients.size,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────

  #resolveApproval: ((approved: boolean) => void) | null = null;

  #waitForApproval(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.#resolveApproval = resolve;
    });
  }

  #handleAgentMessage(msg: SDKMessage): void {
    const timestamp = new Date().toISOString();

    switch (msg.type) {
      case "assistant": {
        const content = msg.message.content as Array<Record<string, unknown>>;
        const textParts: string[] = [];
        for (const block of content) {
          if (block["type"] === "text" && typeof block["text"] === "string") {
            textParts.push(block["text"]);
          }
          if (block["type"] === "tool_use" && typeof block["name"] === "string") {
            this.#broadcast({
              type: "agent.tool_call",
              sessionId: this.id,
              tool: block["name"],
              input: JSON.stringify(block["input"]),
              timestamp,
            });
          }
        }
        const text = textParts.join("");
        if (text) {
          this.#broadcast({
            type: "agent.output",
            sessionId: this.id,
            content: text,
            timestamp,
          });
        }
        break;
      }
      case "result": {
        if (msg.subtype === "success" && msg.result) {
          this.#broadcast({
            type: "agent.output",
            sessionId: this.id,
            content: msg.result,
            timestamp,
          });
        }
        break;
      }
    }
  }

  #broadcast(msg: DaemonMessage): void {
    for (const client of this.#clients.values()) {
      try {
        client.send(msg);
      } catch {
        // Client disconnected — will be cleaned up on next message
        this.#clients.delete(client.id);
      }
    }
  }

  #setStatus(status: SessionStatus): void {
    this.#status = status;
    this.#store.updateSessionStatus(this.id, status);
    this.#broadcast({
      type: "agent.status_change",
      sessionId: this.id,
      status,
      timestamp: new Date().toISOString(),
    });
  }
}
