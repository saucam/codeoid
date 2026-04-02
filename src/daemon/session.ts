/**
 * Session — wraps a single Claude Agent SDK query (one agent working in one repo).
 *
 * Protocol v2:
 *   - Every message carries identity (who produced it)
 *   - Streaming via SessionMessageDelta (token-by-token)
 *   - Tool calls are state machines (streaming → confirmation → executing → completed)
 *   - Thinking indicator as first-class message
 *   - Scrollback stores merged SessionMessage (not deltas)
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
  SessionMessage,
  SessionMessageDelta,
  MessageIdentity,
  ContentPart,
  ToolState,
} from "../protocol/types.js";
import { authToIdentity, SYSTEM_IDENTITY } from "../protocol/types.js";
import type { Store } from "./store.js";
import type { AgentIdentityManager } from "./agent-identity.js";
import { ScrollbackBuffer } from "./scrollback.js";
import { TranscriptStore } from "./transcript.js";

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
  identityManager?: AgentIdentityManager;
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
  #agentIdentity: MessageIdentity;
  #query: Query | null = null;
  #abortController: AbortController | null = null;
  #scrollback = new ScrollbackBuffer();
  #seq = 0;

  // Track whether we've run a query before (for resume vs new session)
  #hasQueried = false;

  // Active streaming message — accumulates deltas into a complete message for scrollback
  #activeAssistantMsg: SessionMessage | null = null;

  // Pending tool approvals: approvalId → resolve(boolean)
  #pendingApprovals = new Map<string, (approved: boolean) => void>();

  // Active tool call messageIds — completed when next assistant message arrives
  #activeToolMsgIds: string[] = [];

  constructor(opts: SessionCreateOptions) {
    this.id = opts.existingId ?? randomUUID();
    this.name = opts.name;
    this.workdir = opts.workdir;
    this.createdBy = opts.auth.sub;
    this.createdAt = new Date().toISOString();
    this.#store = opts.store;
    this.#transcriptStore = opts.transcriptStore;
    this.#identityManager = opts.identityManager;

    // Default agent identity — upgraded to ZeroID identity in SessionStart hook if manager is available
    this.#agentIdentity = {
      sub: `agent:${this.id}`,
      name: `${opts.name} (Claude)`,
      type: "agent",
    };

    if (!opts.existingId) {
      this.#store.createSession({
        ...this.toInfo(),
        accountId: opts.auth.accountId,
        projectId: opts.auth.projectId,
      });
      this.#store.audit(opts.auth.sub, "session.create", this.id, `name=${this.name}`);

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

  get status(): SessionStatus { return this.#status; }
  get attachedClientCount(): number { return this.#clients.size; }
  get agentUri(): string | undefined { return this.#agentIdentity.sub; }

  // ── Client management ─────────────────────────────────────────────────

  attach(client: AttachedClient): void {
    this.#clients.set(client.id, client);
    this.#store.audit(client.auth.sub, "session.attach", this.id);

    // Replay scrollback — full SessionMessage objects, not deltas
    const messages = this.#scrollback.read() as SessionMessage[];
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

    // Emit user message with proper identity
    const userIdentity = authToIdentity(sender);
    const userMsg = this.#makeMessage("user", text, userIdentity);
    this.#persistAndBuffer(userMsg);
    this.#broadcastRaw(userMsg);

    this.#setStatus("working");

    // Emit thinking indicator
    const thinkingMsg = this.#makeMessage(
      "thinking", "Thinking...", this.#agentIdentity,
      undefined, undefined, { event: "thinking_start" },
    );
    this.#broadcastRaw(thinkingMsg);

    this.#abortController = new AbortController();
    const im = this.#identityManager;

    // Register agent identity on first query (SessionStart hook doesn't fire via SDK query())
    if (im && !this.#hasQueried && this.#agentIdentity.sub.startsWith("agent:")) {
      try {
        const { wimseUri } = await im.registerSessionAgent(this.id, this.name, sender.sub);
        this.#agentIdentity = { sub: wimseUri, name: `${this.name} agent`, type: "agent" };
        console.log(`[codeoid] agent identity registered: ${wimseUri}`);
        const infoMsg = this.#makeMessage(
          "info", `Agent identity registered`,
          SYSTEM_IDENTITY, undefined, undefined,
          { event: "identity.registered", agentUri: wimseUri, sessionName: this.name, createdBy: sender.sub },
        );
        this.#persistAndBuffer(infoMsg);
        this.#broadcastRaw(infoMsg);
      } catch (err) {
        console.error(`[codeoid] agent identity registration failed:`, err instanceof Error ? err.message : err);
      }
    }
    const sessionId = this.id;

    // First query: create session. Subsequent queries: resume existing.
    const sessionOpts = this.#hasQueried
      ? { resume: this.id }
      : { sessionId: this.id };

    this.#query = query({
      prompt: text,
      options: {
        cwd: this.workdir,
        abortController: this.#abortController,
        allowedTools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash", "Agent"],
        permissionMode: "default",
        includePartialMessages: true,
        persistSession: true,
        ...sessionOpts,
        settingSources: ["project"],

        hooks: {
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
                const result = await im.registerSubagent(
                  sessionId,
                  input.agent_id ?? "unknown",
                  input.agent_type ?? "unknown",
                );
                const infoMsg = this.#makeMessage(
                  "info",
                  `Sub-agent spawned: ${input.agent_type ?? "unknown"}`,
                  this.#agentIdentity,
                  undefined, undefined,
                  { event: "subagent.spawned", subagentUri: result.wimseUri, agentType: input.agent_type, parentAgent: this.#agentIdentity.sub },
                );
                this.#persistAndBuffer(infoMsg);
                this.#broadcastRaw(infoMsg);
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

        canUseTool: async (toolName, input) => {
          const approvalId = randomUUID();
          const toolId = randomUUID();
          const inputObj = input as Record<string, unknown>;

          // Emit tool_call message with waiting_confirmation state
          const toolMsg = this.#makeMessage(
            "tool_call",
            `${toolName}(${Object.keys(inputObj).join(", ")})`,
            this.#agentIdentity,
            undefined,
            {
              toolId,
              name: toolName,
              state: {
                phase: "waiting_confirmation",
                input: inputObj,
                description: `${toolName}(${Object.keys(inputObj).join(", ")})`,
                approvalId,
              },
            },
          );
          this.#persistAndBuffer(toolMsg);
          this.#broadcastRaw(toolMsg);
          this.#setStatus("waiting_approval");

          const approved = await this.#waitForApproval(approvalId);
          this.#setStatus("working");

          // Emit tool state transition
          const delta: SessionMessageDelta = {
            type: "session.message.delta",
            sessionId: this.id,
            messageId: toolMsg.messageId,
            toolStateUpdate: approved
              ? { phase: "executing" }
              : { phase: "cancelled", reason: "denied" },
            timestamp: new Date().toISOString(),
          };
          this.#broadcastRaw(delta);

          if (approved) {
            this.#store.audit(sender.sub, "session.approve", this.id, `tool=${toolName} approvalId=${approvalId}`);

            // Schedule completion delta after tool finishes (tracked by tool_use_id from SDK)
            // We'll update this in handleAgentMessage when we see the tool result
            return { behavior: "allow" as const };
          }

          this.#store.audit(sender.sub, "session.deny", this.id, `tool=${toolName} approvalId=${approvalId}`);
          return { behavior: "deny" as const, message: "Denied by user" };
        },
      },
    });

    this.#hasQueried = true;

    try {
      for await (const msg of this.#query) {
        this.#handleAgentMessage(msg);
      }
    } catch (err) {
      if (!this.#abortController.signal.aborted) {
        this.#setStatus("error");
        const errorMsg = this.#makeMessage(
          "system",
          `Error: ${err instanceof Error ? err.message : String(err)}`,
          SYSTEM_IDENTITY,
          undefined, undefined,
          { event: "agent_error", errorCode: "agent_error" },
        );
        this.#persistAndBuffer(errorMsg);
        this.#broadcastRaw(errorMsg);
      }
    } finally {
      this.#completeActiveTools();
      this.#flushActiveAssistant();
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
    for (const resolve of this.#pendingApprovals.values()) {
      resolve(false);
    }
    this.#pendingApprovals.clear();
  }

  approve(approvalId: string, approved: boolean, sender: AuthContext): void {
    const resolve = this.#pendingApprovals.get(approvalId);
    if (!resolve) {
      // Fallback: resolve first pending (for clients that don't send approvalId)
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
    for (const resolve of this.#pendingApprovals.values()) {
      resolve(false);
    }
    this.#pendingApprovals.clear();
    this.#clients.clear();
    await this.#identityManager?.deactivateSessionAgent(this.id);
    this.#store.deleteSession(this.id);
    await this.#transcriptStore.delete(this.id);
  }

  restoreScrollback(messages: DaemonMessage[]): void {
    for (const msg of messages) {
      if (msg.type === "session.message") {
        this.#scrollback.push(msg);
      }
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
    switch (msg.type) {
      case "assistant": {
        const content = msg.message.content as Array<Record<string, unknown>>;
        const textParts: string[] = [];
        const parts: ContentPart[] = [];

        for (const block of content) {
          if (block["type"] === "text" && typeof block["text"] === "string") {
            textParts.push(block["text"]);
            parts.push({ kind: "text", text: block["text"], markdown: true });
          }
          if (block["type"] === "tool_use" && typeof block["name"] === "string") {
            const toolName = block["name"] as string;
            const toolInput = block["input"] as Record<string, unknown>;

            // Complete any previously executing tools before starting new one
            this.#completeActiveTools();

            const toolMsg = this.#makeMessage(
              "tool_call",
              `${toolName}(${Object.keys(toolInput).join(", ")})`,
              this.#agentIdentity,
              undefined,
              {
                toolId: randomUUID(),
                name: toolName,
                state: { phase: "executing" },
              },
            );
            this.#activeToolMsgIds.push(toolMsg.messageId);
            this.#persistAndBuffer(toolMsg);
            this.#broadcastRaw(toolMsg);
          }
        }

        const text = textParts.join("");
        if (text) {
          // Tool calls finished — complete them before showing response
          this.#completeActiveTools();

          if (this.#activeAssistantMsg) {
            // Streaming already delivered this content — just update scrollback
            // with the final complete text and flush
            this.#activeAssistantMsg.content = text;
            this.#activeAssistantMsg.parts = parts;
            this.#persistAndBuffer(this.#activeAssistantMsg);
            this.#activeAssistantMsg = null;
          } else {
            // No streaming happened — send the full message directly
            const assistantMsg = this.#makeMessage(
              "assistant", text, this.#agentIdentity, parts,
            );
            this.#persistAndBuffer(assistantMsg);
            this.#broadcastRaw(assistantMsg);
          }
        } else {
          this.#flushActiveAssistant();
        }
        break;
      }

      case "stream_event": {
        // Partial streaming — emit delta
        const event = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          if (!this.#activeAssistantMsg) {
            // Start new streaming message with empty content — deltas fill it in
            this.#activeAssistantMsg = this.#makeMessage(
              "assistant", "", this.#agentIdentity,
            );
            this.#broadcastRaw(this.#activeAssistantMsg);
          }

          // Track full content for scrollback
          this.#activeAssistantMsg.content += event.delta.text;

          // Send delta to clients
          const delta: SessionMessageDelta = {
            type: "session.message.delta",
            sessionId: this.id,
            messageId: this.#activeAssistantMsg.messageId,
            contentAppend: event.delta.text,
            timestamp: new Date().toISOString(),
          };
          this.#broadcastRaw(delta);
        }
        break;
      }

      case "result": {
        this.#flushActiveAssistant();
        // Only emit errors — success result duplicates last assistant message
        if (msg.subtype === "error" && msg.error) {
          const errorMsg = this.#makeMessage(
            "system",
            `Error: ${typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)}`,
            SYSTEM_IDENTITY,
            undefined, undefined,
            { event: "agent_error" },
          );
          this.#persistAndBuffer(errorMsg);
          this.#broadcastRaw(errorMsg);
        }
        break;
      }

      case "system": {
        const subtype = (msg as { subtype?: string }).subtype;
        if (subtype === "api_retry") {
          const retryMsg = msg as { attempt?: number; retry_delay_ms?: number; error_status?: number | null };
          const infoMsg = this.#makeMessage(
            "system",
            `API retry: attempt ${retryMsg.attempt}, delay ${retryMsg.retry_delay_ms}ms${retryMsg.error_status ? ` (status ${retryMsg.error_status})` : ""}`,
            SYSTEM_IDENTITY,
            [{ kind: "progress", message: `Retrying (attempt ${retryMsg.attempt})...` }],
            undefined,
            { event: "api_retry", attempt: retryMsg.attempt },
          );
          this.#broadcastRaw(infoMsg);
        }
        break;
      }

      case "tool_progress": {
        const progress = msg as { tool_name?: string; elapsed_time_seconds?: number; tool_use_id?: string };
        // Emit progress part as info
        const progressMsg = this.#makeMessage(
          "info",
          `${progress.tool_name ?? "Tool"} running... (${Math.round(progress.elapsed_time_seconds ?? 0)}s)`,
          this.#agentIdentity,
          [{ kind: "progress", message: `${progress.tool_name} running...`, elapsedMs: (progress.elapsed_time_seconds ?? 0) * 1000 }],
          undefined,
          { event: "tool_progress", toolName: progress.tool_name },
        );
        this.#broadcastRaw(progressMsg);
        break;
      }
    }
  }

  /** Flush the active assistant message into scrollback (for device handoff) */
  #flushActiveAssistant(): void {
    if (this.#activeAssistantMsg) {
      this.#activeAssistantMsg = null;
    }
  }

  /** Mark all active tool calls as completed — updates scrollback + broadcasts delta */
  #completeActiveTools(): void {
    for (const msgId of this.#activeToolMsgIds) {
      // Update scrollback so replay shows completed, not executing
      this.#scrollback.updateMessage(msgId, (msg) => {
        const sm = msg as SessionMessage;
        if (sm.tool) {
          sm.tool.state = { phase: "completed", success: true };
        }
      });

      // Broadcast delta to live clients
      this.#broadcastRaw({
        type: "session.message.delta",
        sessionId: this.id,
        messageId: msgId,
        toolStateUpdate: { phase: "completed", success: true },
        timestamp: new Date().toISOString(),
      });
    }
    this.#activeToolMsgIds = [];
  }

  /** Create a SessionMessage with all required fields */
  #makeMessage(
    role: SessionMessage["role"],
    content: string,
    identity: MessageIdentity,
    parts?: ContentPart[],
    tool?: SessionMessage["tool"],
    metadata?: Record<string, unknown>,
  ): SessionMessage {
    return {
      type: "session.message",
      sessionId: this.id,
      messageId: randomUUID(),
      role,
      content,
      parts,
      identity,
      tool,
      metadata,
      timestamp: new Date().toISOString(),
    };
  }

  /** Persist to transcript + scrollback buffer */
  #persistAndBuffer(msg: SessionMessage): void {
    this.#scrollback.push(msg);
    this.#transcriptStore.append(this.id, msg, this.#seq++).catch(() => {});
  }

  /** Broadcast any DaemonMessage to all attached clients */
  #broadcastRaw(msg: DaemonMessage): void {
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

    this.#transcriptStore.saveMeta({
      sessionId: this.id,
      sessionName: this.name,
      workdir: this.workdir,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      lastStatus: status,
      lastActivityAt: new Date().toISOString(),
      accountId: "",
      projectId: "",
    }).catch(() => {});

    this.#broadcastRaw({
      type: "session.status_change",
      sessionId: this.id,
      status,
      timestamp: new Date().toISOString(),
    });
  }
}
