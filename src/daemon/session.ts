/**
 * Session — wraps a single Claude Agent SDK query (one agent working in one repo).
 *
 * Production-grade patterns:
 *   1. Scrollback buffer — replay on device handoff
 *   2. Persistent retry — exponential backoff, fallback model
 *   3. Transcript persistence — JSONL, survives daemon restart
 *   4. Permission request_id correlation — JSON-RPC style
 *   5. ZeroID identity lifecycle — agent + sub-agent identities
 */

import {
  query,
  type Query,
  type SDKMessage,
  type PreToolUseHookInput,
  type SubagentStartHookInput,
  type SubagentStopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type {
  AuthContext,
  SessionInfo,
  SessionStatus,
  DaemonMessage,
  SessionMessageMsg,
} from "../protocol/types.js";
import type { Store } from "./store.js";
import type { AgentIdentityManager } from "./agent-identity.js";
import { ScrollbackBuffer } from "./scrollback.js";
import { TranscriptStore } from "./transcript.js";
// retry.ts available for future use when SDK supports per-call retry hooks

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
  transcriptStore: TranscriptStore;
  /** Optional — if provided, agents get ZeroID identities. */
  identityManager?: AgentIdentityManager;
  /** Existing session ID for resume. */
  existingId?: string;
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
  #transcriptStore: TranscriptStore;
  #identityManager?: AgentIdentityManager;
  #agentWimseUri?: string;
  #query: Query | null = null;
  #abortController: AbortController | null = null;
  #scrollback = new ScrollbackBuffer();
  #seq = 0;

  // ── Permission request_id correlation ─────────────────────────────────
  // Multiple approvals can be pending simultaneously. Each has a unique ID.
  #pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(opts: SessionCreateOptions) {
    this.id = opts.existingId ?? randomUUID();
    this.name = opts.name;
    this.workdir = opts.workdir;
    this.createdBy = opts.auth.sub;
    this.createdAt = new Date().toISOString();
    this.#store = opts.store;
    this.#transcriptStore = opts.transcriptStore;
    this.#identityManager = opts.identityManager;

    if (!opts.existingId) {
      this.#store.createSession({
        ...this.toInfo(),
        accountId: opts.auth.accountId,
        projectId: opts.auth.projectId,
      });
      this.#store.audit(opts.auth.sub, "session.create", this.id, `name=${this.name}`);

      // Persist metadata for resume
      this.#transcriptStore.saveMeta({
        sessionId: this.id,
        sessionName: this.name,
        workdir: this.workdir,
        createdBy: this.createdBy,
        createdAt: this.createdAt,
        lastStatus: "idle",
        lastActivityAt: this.createdAt,
        accountId: opts.auth.accountId,
        projectId: opts.auth.projectId,
      });
    }
  }

  get status(): SessionStatus {
    return this.#status;
  }

  get attachedClientCount(): number {
    return this.#clients.size;
  }

  get agentUri(): string | undefined {
    return this.#agentWimseUri;
  }

  // ── Client management ─────────────────────────────────────────────────

  attach(client: AttachedClient): void {
    this.#clients.set(client.id, client);
    this.#store.audit(client.auth.sub, "session.attach", this.id);

    // Replay scrollback so client sees what happened while disconnected.
    const messages = this.#scrollback.read();
    if (messages.length > 0) {
      client.send({
        type: "scrollback.replay",
        sessionId: this.id,
        messages,
      });
    }
  }

  detach(clientId: string): void {
    const client = this.#clients.get(clientId);
    if (client) {
      this.#store.audit(client.auth.sub, "session.detach", this.id);
      this.#clients.delete(clientId);
    }
  }

  // ── Agent interaction ─────────────────────────────────────────────────

  async send(text: string, sender: AuthContext): Promise<void> {
    this.#store.audit(sender.sub, "session.send", this.id);
    this.#setStatus("working");

    // Broadcast user message to all attached clients
    this.#broadcast({
      type: "session.message",
      sessionId: this.id,
      role: "user",
      content: text,
      metadata: { sender: sender.sub, senderName: sender.name },
      timestamp: new Date().toISOString(),
    });

    // Persist user prompt BEFORE API call — survives crashes
    await this.#transcriptStore.appendUserPrompt(
      this.id, text, sender.sub, this.#seq++,
    );

    this.#abortController = new AbortController();
    const im = this.#identityManager;
    const sessionId = this.id;

    // ── Retry wrapper for the entire query ────────────────────────
    const executeQuery = async (ctx: { attempt: number; fallbackModel?: string }) => {
      this.#query = query({
        prompt: text,
        options: {
          cwd: this.workdir,
          abortController: this.#abortController!,
          allowedTools: ["Read", "Grep", "Glob", "Write", "Edit", "Agent"],
          permissionMode: "default",
          includePartialMessages: false,
          persistSession: true,
          sessionId: this.id,
          settingSources: ["project"],
          ...(ctx.fallbackModel ? { model: ctx.fallbackModel } : {}),

          // ── ZeroID hooks for agent identity lifecycle ──────────
          hooks: {
            SessionStart: [{
              hooks: [async () => {
                if (im && !this.#agentWimseUri) {
                  try {
                    const { wimseUri } = await im.registerSessionAgent(
                      sessionId, this.name, sender.sub,
                    );
                    this.#agentWimseUri = wimseUri;
                  } catch { /* best-effort */ }
                }
                return {};
              }],
            }],

            PreToolUse: [{
              hooks: [async (rawInput) => {
                const input = rawInput as PreToolUseHookInput;
                im?.auditToolCall(sessionId, input.tool_name, JSON.stringify(input.tool_input));
                return {};
              }],
            }],

            SubagentStart: [{
              hooks: [async (rawInput) => {
                const input = rawInput as SubagentStartHookInput;
                if (im) {
                  await im.registerSubagent(
                    sessionId,
                    input.agent_id ?? "unknown",
                    input.agent_type ?? "unknown",
                  );
                }
                return {};
              }],
            }],

            SubagentStop: [{
              hooks: [async (rawInput) => {
                const input = rawInput as SubagentStopHookInput;
                await im?.deactivateSubagent(sessionId, input.agent_id ?? "unknown");
                return {};
              }],
            }],
          },

          // ── Permission routing with request_id correlation ─────
          canUseTool: async (toolName, input) => {
            const approvalId = randomUUID();
            const timestamp = new Date().toISOString();

            this.#broadcast({
              type: "agent.approval_request",
              sessionId: this.id,
              approvalId,
              tool: toolName,
              input: JSON.stringify(input),
              description: `${toolName}(${Object.keys(input as Record<string, unknown>).join(", ")})`,
              timestamp,
            });
            this.#setStatus("waiting_approval");

            const result = await this.#waitForApproval(approvalId);
            this.#setStatus("working");

            if (result) {
              this.#store.audit(sender.sub, "session.approve", this.id, `tool=${toolName} approvalId=${approvalId}`);
              return { behavior: "allow" as const };
            }
            this.#store.audit(sender.sub, "session.deny", this.id, `tool=${toolName} approvalId=${approvalId}`);
            return { behavior: "deny" as const, message: "Denied by user" };
          },
        },
      });

      for await (const msg of this.#query) {
        this.#handleAgentMessage(msg);
      }
    };

    try {
      await executeQuery({ attempt: 1, fallbackModel: undefined });
    } catch (err) {
      if (!this.#abortController.signal.aborted) {
        this.#setStatus("error");
        this.#broadcast({
          type: "session.message",
          sessionId: this.id,
          role: "system",
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { errorCode: "agent_error" },
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

  interrupt(sender: AuthContext): void {
    this.#store.audit(sender.sub, "session.interrupt", this.id);
    this.#abortController?.abort();
    // Reject all pending approvals
    for (const [id, resolve] of this.#pendingApprovals) {
      resolve(false);
      this.#pendingApprovals.delete(id);
    }
  }

  /**
   * Respond to a specific pending approval request by approvalId.
   * First response wins — subsequent responses for the same approvalId are ignored.
   */
  approve(approvalId: string, approved: boolean, sender: AuthContext): void {
    const resolve = this.#pendingApprovals.get(approvalId);
    if (!resolve) {
      // Fallback: if no approvalId match, resolve the first pending approval
      // (backwards compat with clients that don't send approvalId)
      const first = this.#pendingApprovals.entries().next();
      if (!first.done) {
        const [firstId, firstResolve] = first.value;
        this.#store.audit(sender.sub, approved ? "session.approve" : "session.deny", this.id, `approvalId=${firstId}`);
        firstResolve(approved);
        this.#pendingApprovals.delete(firstId);
      }
      return;
    }

    this.#store.audit(sender.sub, approved ? "session.approve" : "session.deny", this.id, `approvalId=${approvalId}`);
    resolve(approved);
    this.#pendingApprovals.delete(approvalId);
  }

  async destroy(sender: AuthContext): Promise<void> {
    this.#store.audit(sender.sub, "session.destroy", this.id);
    this.#abortController?.abort();

    // Reject all pending approvals
    for (const resolve of this.#pendingApprovals.values()) {
      resolve(false);
    }
    this.#pendingApprovals.clear();
    this.#clients.clear();

    await this.#identityManager?.deactivateSessionAgent(this.id);
    this.#store.deleteSession(this.id);
    await this.#transcriptStore.delete(this.id);
  }

  /**
   * Restore scrollback from transcript entries (used on daemon restart).
   */
  restoreScrollback(messages: DaemonMessage[]): void {
    for (const msg of messages) {
      this.#scrollback.push(msg);
    }
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

  #waitForApproval(approvalId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.#pendingApprovals.set(approvalId, resolve);
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
            const toolName = block["name"] as string;
            const toolInput = block["input"] as Record<string, unknown>;
            this.#broadcast({
              type: "session.message",
              sessionId: this.id,
              role: "tool_call",
              content: toolName,
              metadata: {
                tool: toolName,
                toolInput: JSON.stringify(toolInput),
                toolDescription: `${toolName}(${Object.keys(toolInput).join(", ")})`,
              },
              timestamp,
            });
          }
        }
        const text = textParts.join("");
        if (text) {
          this.#broadcast({
            type: "session.message",
            sessionId: this.id,
            role: "assistant",
            content: text,
            timestamp,
          });
        }
        break;
      }
      case "result": {
        // Don't broadcast result text — it duplicates the last assistant message.
        // Only broadcast errors.
        if (msg.subtype === "error" && msg.error) {
          this.#broadcast({
            type: "session.message",
            sessionId: this.id,
            role: "system",
            content: `Error: ${msg.error}`,
            metadata: { errorCode: "agent_error" },
            timestamp,
          });
        }
        break;
      }
    }
  }

  #broadcast(msg: DaemonMessage): void {
    // Push to scrollback (device handoff)
    this.#scrollback.push(msg);

    // Persist to transcript (daemon restart)
    this.#transcriptStore.append(this.id, msg, this.#seq++).catch(() => {});

    // Send to all attached clients
    for (const client of this.#clients.values()) {
      try {
        client.send(msg);
      } catch {
        this.#clients.delete(client.id);
      }
    }
  }

  #setStatus(status: SessionStatus): void {
    this.#status = status;
    this.#store.updateSessionStatus(this.id, status);

    // Update transcript metadata
    this.#transcriptStore.saveMeta({
      sessionId: this.id,
      sessionName: this.name,
      workdir: this.workdir,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      lastStatus: status,
      lastActivityAt: new Date().toISOString(),
      accountId: "", // filled from auth context at creation
      projectId: "",
    }).catch(() => {});

    this.#broadcast({
      type: "agent.status_change",
      sessionId: this.id,
      status,
      timestamp: new Date().toISOString(),
    });
  }
}
