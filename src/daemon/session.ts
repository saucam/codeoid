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
  SessionMode,
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
import {
  EpisodeChunker,
  buildMemoryMcpServer,
  workspaceIdFromPath,
  type MemoryEngine,
} from "./memory/index.js";
import type { Attachment } from "../protocol/types.js";
import { resolveAttachments } from "./attachments.js";

/**
 * System-prompt append used when memory is enabled. Deliberately brief and
 * action-oriented — long preambles eat the cache hit. This string is stable
 * per-workspace so it becomes part of the cached prompt prefix.
 */
const MEMORY_SYSTEM_PROMPT_APPEND = [
  "You have access to durable cross-session memory for this workspace via three tools: recall, recall_file, and timeline.",
  "",
  "- Before reading a file, call recall_file(path) — if it was read recently and hasn't changed, reuse that content instead of issuing a fresh Read.",
  "- When the user references earlier work ('what we did yesterday', 'the bug we hit', 'that auth flow'), call recall(query) first. Don't guess from your own session history; it may be out of date.",
  "- At the start of a new session in a known workspace, consider calling timeline() to orient yourself on recent activity.",
  "",
  "Memory stores every tool call and assistant reply across all past sessions in this directory. It is the source of truth for history — summaries in your context may be partial.",
].join("\n");

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
  /** Optional memory engine — when provided, episodes are chunked and stored for recall. */
  memory?: MemoryEngine;
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
  #memory?: MemoryEngine;
  #chunker?: EpisodeChunker;
  #workspaceId: string;

  // Execution mode + turn budget (autonomous mode only).
  #mode: SessionMode = "interactive";
  #turnsRemaining: number | undefined = undefined;

  // Pinned files — prepended to every turn until unpinned. Kept both in
  // memory (for hot reads) and in the Store (for restart persistence).
  #pinnedFiles: string[] = [];

  // Sub-agent tracking — identity-first attribution for delegated work.
  // Populated by SubagentStart / SubagentStop hooks; consulted when building
  // a tool_call SessionMessage so each tool call carries the identity of the
  // agent that actually made it (parent session OR sub-agent worker).
  #subagents = new Map<
    string,
    {
      identity: MessageIdentity;
      agentType: string;
      spawnedAt: number;
      active: boolean;
    }
  >();
  // SDK tool_use_id → agent_id that invoked it. Populated in the PreToolUse
  // hook, used when we later see the tool_use in an assistant message.
  #toolUseAgentId = new Map<string, string>();

  // Track whether we've run a query before (for resume vs new session)
  #hasQueried = false;

  // Active streaming message — accumulates deltas into a complete message for scrollback
  #activeAssistantMsg: SessionMessage | null = null;
  // Active thinking message — Claude's extended reasoning, streamed live so
  // the user can see what the model is considering before it acts.
  #activeThinkingMsg: SessionMessage | null = null;
  // Which content block index the active thinking corresponds to (so we
  // only finalize it on the matching content_block_stop).
  #activeThinkingIndex: number | null = null;

  // Pending tool approvals: approvalId → resolve(boolean)
  #pendingApprovals = new Map<string, (approved: boolean) => void>();

  // Active tool call messageIds — completed when next assistant message arrives
  #activeToolMsgIds: string[] = [];

  // SDK tool_use_id → our internal messageId — lets us correlate tool_result
  // blocks (emitted in SDKUserMessage) back to the originating tool_call message
  // so we can record the real tool output in scrollback, transcript, and memory.
  #toolUseIdToMessageId = new Map<string, string>();
  // messageIds of tool_calls already closed via a tool_result — so the
  // fallback #completeActiveTools() path doesn't clobber their output.
  #toolCallsClosedByResult = new Set<string>();
  // messageId → canonical tool_call message, kept around so the completion
  // update preserves the original tool input.
  #toolCallMessages = new Map<string, SessionMessage>();

  constructor(opts: SessionCreateOptions) {
    this.id = opts.existingId ?? randomUUID();
    this.name = opts.name;
    this.workdir = opts.workdir;
    this.createdBy = opts.auth.sub;
    this.createdAt = new Date().toISOString();
    this.#store = opts.store;
    this.#transcriptStore = opts.transcriptStore;
    this.#identityManager = opts.identityManager;
    this.#memory = opts.memory;
    this.#workspaceId = workspaceIdFromPath(opts.workdir);

    // Restore any pinned files the user had on this session before.
    try {
      this.#pinnedFiles = this.#store.listPins(this.id);
    } catch {
      this.#pinnedFiles = [];
    }

    // Default agent identity — upgraded to ZeroID identity in SessionStart hook if manager is available
    this.#agentIdentity = {
      sub: `agent:${this.id}`,
      name: `${opts.name} (Claude)`,
      type: "agent",
    };

    if (this.#memory) {
      const memory = this.#memory;
      this.#chunker = new EpisodeChunker(
        {
          workspaceId: this.#workspaceId,
          sessionId: this.id,
          createdBy: opts.auth.sub,
        },
        (episode) => {
          try {
            memory.ingest(episode);
          } catch (err) {
            console.error(
              `[codeoid/memory] ingest failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      );
    }

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
  get mode(): SessionMode { return this.#mode; }
  get turnsRemaining(): number | undefined { return this.#turnsRemaining; }
  get pinnedFiles(): readonly string[] { return this.#pinnedFiles; }

  /** Snapshot the active sub-agent tree — used by /who and toInfo(). */
  get subagentSnapshot(): Array<{
    agentId: string;
    wimseUri?: string;
    agentType: string;
    spawnedAt: number;
    active: boolean;
  }> {
    return Array.from(this.#subagents.entries()).map(([agentId, s]) => ({
      agentId,
      wimseUri: s.identity.sub.startsWith("anonymous:") ? undefined : s.identity.sub,
      agentType: s.agentType,
      spawnedAt: s.spawnedAt,
      active: s.active,
    }));
  }

  /** Pin a file — prepended to every subsequent turn until unpinned. */
  pinFile(path: string, sender: AuthContext): void {
    if (!path || this.#pinnedFiles.includes(path)) return;
    this.#pinnedFiles.push(path);
    this.#store.pinFile(this.id, path);
    this.#store.audit(sender.sub, "session.pin", this.id, `path=${path}`);
    this.#broadcastInfoUpdate();
  }

  /** Unpin a file. No-op if it wasn't pinned. */
  unpinFile(path: string, sender: AuthContext): void {
    const idx = this.#pinnedFiles.indexOf(path);
    if (idx < 0) return;
    this.#pinnedFiles.splice(idx, 1);
    this.#store.unpinFile(this.id, path);
    this.#store.audit(sender.sub, "session.unpin", this.id, `path=${path}`);
    this.#broadcastInfoUpdate();
  }

  /** Change execution mode. Resets turn budget if moving out of autonomous. */
  setMode(mode: SessionMode, maxTurns?: number, sender?: AuthContext): void {
    if (this.#mode === mode && this.#turnsRemaining === maxTurns) return;
    this.#mode = mode;
    this.#turnsRemaining = mode === "autonomous" ? maxTurns : undefined;
    if (sender) {
      this.#store.audit(sender.sub, "session.set_mode", this.id, `mode=${mode}`);
    }
    this.#broadcastInfoUpdate();
  }

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

  async send(
    text: string,
    sender: AuthContext,
    attachments?: readonly Attachment[],
  ): Promise<void> {
    this.#store.audit(sender.sub, "session.send", this.id);

    // Merge pinned + per-turn attachments (dedup by path, per-turn wins).
    const allAttachments = this.#buildEffectiveAttachments(attachments);
    const { resolved, promptPrefix } = resolveAttachments(allAttachments, {
      workdir: this.workdir,
    });
    const effectivePrompt = promptPrefix ? `${promptPrefix}${text}` : text;

    // The user-visible message carries the bare text plus a metadata
    // breadcrumb for the transcript/memory layer. The attachment content
    // itself doesn't need to be echoed back into the UI — we log the
    // filenames (and any resolution errors) so the user can see what was
    // sent without flooding the chat.
    const userIdentity = authToIdentity(sender);
    const attachmentSummary = resolved.map((r) => ({
      path: r.path,
      pinned: this.#pinnedFiles.includes(r.path),
      bytes: r.bytes,
      error: r.error,
    }));
    const userMsg = this.#makeMessage(
      "user",
      text,
      userIdentity,
      undefined,
      undefined,
      attachmentSummary.length > 0 ? { attachments: attachmentSummary } : undefined,
    );
    this.#persistAndBuffer(userMsg);
    this.#broadcastRaw(userMsg);

    this.#setStatus("working");

    // Thinking is now streamed from the SDK (content_block type=thinking).
    // No hardcoded "Thinking..." indicator; if the model actually reasons
    // out loud, we'll stream it live as a role=thinking message.

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

    // Build MCP memory server for this turn so Claude can call recall()
    const mcpServers = this.#memory
      ? {
          codeoid_memory: buildMemoryMcpServer(this.#memory, {
            workspaceId: this.#workspaceId,
            sessionId: this.id,
          }),
        }
      : undefined;

    this.#query = query({
      prompt: effectivePrompt,
      options: {
        cwd: this.workdir,
        abortController: this.#abortController,
        allowedTools: [
          "Read",
          "Grep",
          "Glob",
          "Write",
          "Edit",
          "Bash",
          "Agent",
          ...(this.#memory
            ? [
                "mcp__codeoid_memory__recall",
                "mcp__codeoid_memory__recall_file",
                "mcp__codeoid_memory__timeline",
              ]
            : []),
        ],
        permissionMode: "default",
        includePartialMessages: true,
        persistSession: true,
        // Capture subprocess stderr into the daemon log so spawn failures are debuggable.
        stderr: (data: string) => {
          process.stderr.write(`[claude-subprocess ${this.id.slice(0, 8)}] ${data}`);
        },
        ...(mcpServers ? { mcpServers } : {}),
        ...(this.#memory
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: MEMORY_SYSTEM_PROMPT_APPEND,
              },
            }
          : {}),
        ...sessionOpts,
        settingSources: ["project"],

        hooks: {
          PreToolUse: [{
            hooks: [async (rawInput) => {
              const input = rawInput as PreToolUseHookInput & { agent_id?: string };
              im?.auditToolCall(sessionId, input.tool_name, JSON.stringify(input.tool_input));
              // Record which agent (parent session or sub-agent) is invoking
              // this tool_use_id. Used later in #handleAgentMessage to tag
              // the emitted tool_call SessionMessage with the right identity.
              if (input.tool_use_id && input.agent_id) {
                this.#toolUseAgentId.set(input.tool_use_id, input.agent_id);
              }
              return {};
            }],
          }],

          SubagentStart: [{
            hooks: [async (rawInput) => {
              const input = rawInput as SubagentStartHookInput;
              const agentId = input.agent_id ?? "unknown";
              const agentType = input.agent_type ?? "unknown";
              let childIdentity: MessageIdentity = {
                sub: `anonymous:subagent:${agentId}`,
                name: agentType,
                type: "subagent",
              };
              if (im) {
                try {
                  const result = await im.registerSubagent(sessionId, agentId, agentType);
                  childIdentity = {
                    sub: result.wimseUri,
                    name: agentType,
                    type: "subagent",
                  };
                } catch (err) {
                  console.error(
                    `[codeoid] subagent register failed: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
              this.#subagents.set(agentId, {
                identity: childIdentity,
                agentType,
                spawnedAt: Date.now(),
                active: true,
              });
              const infoMsg = this.#makeMessage(
                "info",
                `Sub-agent spawned: ${agentType}`,
                this.#agentIdentity,
                undefined,
                undefined,
                {
                  event: "subagent.spawned",
                  subagentUri: childIdentity.sub,
                  agentType,
                  parentAgent: this.#agentIdentity.sub,
                },
              );
              this.#persistAndBuffer(infoMsg);
              this.#broadcastRaw(infoMsg);
              this.#broadcastInfoUpdate();
              return {};
            }],
          }],

          SubagentStop: [{
            hooks: [async (rawInput) => {
              const input = rawInput as SubagentStopHookInput;
              const agentId = input.agent_id ?? "unknown";
              await im?.deactivateSubagent(sessionId, agentId);
              const entry = this.#subagents.get(agentId);
              if (entry) {
                entry.active = false;
                this.#broadcastInfoUpdate();
              }
              return {};
            }],
          }],
        },

        canUseTool: async (toolName, input) => {
          const approvalId = randomUUID();
          const toolId = randomUUID();
          const inputObj = input as Record<string, unknown>;

          // Mode-based auto-approve check — runs before we even emit a
          // waiting_confirmation message.
          const autoApprove = this.#shouldAutoApprove(toolName);
          if (autoApprove) {
            const autoMsg = this.#makeMessage(
              "tool_call",
              `${toolName}(${Object.keys(inputObj).join(", ")})`,
              this.#agentIdentity,
              undefined,
              {
                toolId,
                name: toolName,
                state: { phase: "executing", input: inputObj } as unknown as ToolState,
              },
            );
            this.#activeToolMsgIds.push(autoMsg.messageId);
            this.#toolCallMessages.set(autoMsg.messageId, autoMsg);
            this.#persistAndBuffer(autoMsg);
            this.#broadcastRaw(autoMsg);
            this.#store.audit(sender.sub, "session.auto_approve", this.id, `tool=${toolName} mode=${this.#mode}`);
            return { behavior: "allow" as const };
          }

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
        // Surface the full error (message + stack + any extra fields) to
        // daemon stdout so we can diagnose SDK-level failures from the logs.
        console.error(
          `[codeoid/session ${this.id}] SDK query failed:`,
          err instanceof Error ? err.stack ?? err.message : err,
        );
        if (err && typeof err === "object") {
          for (const key of Object.keys(err as object)) {
            const v = (err as Record<string, unknown>)[key];
            if (v !== undefined) console.error(`  ${key}:`, v);
          }
        }

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
      this.#chunker?.onTurnEnd();
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
    // A session with prior scrollback already exists in Claude Code's own
    // persistent session store — next send() must use `resume`, not re-create.
    if (messages.length > 0) {
      this.#hasQueried = true;
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
      mode: this.#mode,
      turnsRemaining: this.#turnsRemaining,
      pinnedFiles: [...this.#pinnedFiles],
      agentUri: this.#agentIdentity.sub,
      subagents: this.subagentSnapshot,
    };
  }

  #broadcastInfoUpdate(): void {
    this.#broadcastRaw({
      type: "session.info_update",
      session: this.toInfo(),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Merge pinned files + per-turn attachments. Per-turn entries override
   * pinned entries with the same path (caller can push fresh content
   * inline without removing the pin).
   */
  #buildEffectiveAttachments(
    perTurn: readonly Attachment[] | undefined,
  ): Attachment[] {
    const out: Attachment[] = [];
    const seen = new Set<string>();
    if (perTurn) {
      for (const a of perTurn) {
        if (seen.has(a.path)) continue;
        seen.add(a.path);
        out.push(a);
      }
    }
    for (const p of this.#pinnedFiles) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ path: p });
    }
    return out;
  }

  /**
   * Look up the identity that should be credited with a given SDK
   * tool_use_id. Falls back to the session's primary agent identity when
   * no sub-agent mapping is recorded.
   */
  #identityForToolUse(toolUseId: string | null): MessageIdentity {
    if (!toolUseId) return this.#agentIdentity;
    const agentId = this.#toolUseAgentId.get(toolUseId);
    if (!agentId) return this.#agentIdentity;
    const sub = this.#subagents.get(agentId);
    return sub ? sub.identity : this.#agentIdentity;
  }

  /** Tool classification — used by auto-approve logic. */
  #shouldAutoApprove(toolName: string): boolean {
    if (this.#mode === "interactive") return false;

    // Read-only / retrieval tools — safe in both auto-allow and autonomous.
    if (isSafeTool(toolName)) return true;

    // Write / exec tools — only auto-approved in autonomous mode.
    if (this.#mode === "autonomous") {
      if (this.#turnsRemaining === undefined) return true;
      if (this.#turnsRemaining <= 0) {
        // Budget exhausted — revert to interactive and fall through to ask.
        this.setMode("interactive");
        return false;
      }
      this.#turnsRemaining -= 1;
      this.#broadcastInfoUpdate();
      return true;
    }

    return false;
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
            const sdkToolUseId = typeof block["id"] === "string" ? block["id"] : null;

            // Complete any previously executing tools before starting new one
            this.#completeActiveTools();

            // Attribute this tool call to the correct agent — the parent
            // session agent by default, or the sub-agent worker that ran it
            // (if PreToolUse recorded a mapping).
            const emittingIdentity = this.#identityForToolUse(sdkToolUseId);

            const toolMsg = this.#makeMessage(
              "tool_call",
              `${toolName}(${Object.keys(toolInput).join(", ")})`,
              emittingIdentity,
              undefined,
              {
                toolId: randomUUID(),
                name: toolName,
                state: { phase: "executing", input: toolInput } as unknown as ToolState,
              },
            );
            this.#activeToolMsgIds.push(toolMsg.messageId);
            this.#toolCallMessages.set(toolMsg.messageId, toolMsg);
            if (sdkToolUseId) {
              this.#toolUseIdToMessageId.set(sdkToolUseId, toolMsg.messageId);
            }
            this.#persistAndBuffer(toolMsg);
            this.#broadcastRaw(toolMsg);
          }
        }

        const text = textParts.join("");
        if (text) {
          // Tool calls finished — complete them before showing response
          this.#completeActiveTools();

          if (this.#activeAssistantMsg) {
            // Streaming already delivered this content — update in-place,
            // persist, AND re-broadcast so clients can flip this message
            // from "live/streaming" to "committed" in their transcript.
            this.#activeAssistantMsg.content = text;
            this.#activeAssistantMsg.parts = parts;
            this.#persistAndBuffer(this.#activeAssistantMsg);
            this.#broadcastRaw(this.#activeAssistantMsg);
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
        // The SDK forwards the raw Anthropic stream. We care about three
        // event shapes: content_block_start (begin thinking/text block),
        // content_block_delta (append thinking/text chunk), content_block_stop
        // (finalize the active block so its message commits to scrollback).
        const event = (msg as {
          event?: {
            type?: string;
            index?: number;
            content_block?: { type?: string };
            delta?: { type?: string; text?: string; thinking?: string };
          };
        }).event;
        if (!event) break;

        if (event.type === "content_block_start") {
          if (event.content_block?.type === "thinking") {
            this.#activeThinkingMsg = this.#makeMessage(
              "thinking",
              "",
              this.#agentIdentity,
              undefined,
              undefined,
              { event: "thinking_stream" },
            );
            this.#activeThinkingIndex = event.index ?? null;
            this.#broadcastRaw(this.#activeThinkingMsg);
          }
          break;
        }

        if (event.type === "content_block_delta" && event.delta) {
          // Text delta — streaming assistant response.
          if (event.delta.type === "text_delta" && event.delta.text) {
            if (!this.#activeAssistantMsg) {
              this.#activeAssistantMsg = this.#makeMessage(
                "assistant", "", this.#agentIdentity,
              );
              this.#broadcastRaw(this.#activeAssistantMsg);
            }
            this.#activeAssistantMsg.content += event.delta.text;
            const delta: SessionMessageDelta = {
              type: "session.message.delta",
              sessionId: this.id,
              messageId: this.#activeAssistantMsg.messageId,
              contentAppend: event.delta.text,
              timestamp: new Date().toISOString(),
            };
            this.#broadcastRaw(delta);
            break;
          }

          // Thinking delta — Claude's extended reasoning.
          if (event.delta.type === "thinking_delta" && event.delta.thinking) {
            if (!this.#activeThinkingMsg) {
              this.#activeThinkingMsg = this.#makeMessage(
                "thinking", "", this.#agentIdentity,
                undefined, undefined, { event: "thinking_stream" },
              );
              this.#activeThinkingIndex = event.index ?? null;
              this.#broadcastRaw(this.#activeThinkingMsg);
            }
            this.#activeThinkingMsg.content += event.delta.thinking;
            const delta: SessionMessageDelta = {
              type: "session.message.delta",
              sessionId: this.id,
              messageId: this.#activeThinkingMsg.messageId,
              contentAppend: event.delta.thinking,
              timestamp: new Date().toISOString(),
            };
            this.#broadcastRaw(delta);
            break;
          }
        }

        if (event.type === "content_block_stop") {
          // Finalize the matching active block. Thinking blocks commit to
          // scrollback here (with their complete content) so the user can
          // scroll back and read the reasoning later. We also re-broadcast
          // the message so clients can flip it from "live" to "committed"
          // in their transcript layout.
          if (
            this.#activeThinkingMsg &&
            (event.index === this.#activeThinkingIndex || event.index === undefined)
          ) {
            this.#persistAndBuffer(this.#activeThinkingMsg);
            this.#broadcastRaw(this.#activeThinkingMsg);
            this.#activeThinkingMsg = null;
            this.#activeThinkingIndex = null;
          }
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

      case "user": {
        // The SDK emits "user" messages that echo Claude's turn payload — these
        // carry tool_result content blocks from tools that just executed. We
        // correlate each tool_result back to the originating tool_call via its
        // tool_use_id, then push a completion update (with real output) through
        // #persistAndBuffer so the chunker can close the episode properly.
        const content = (msg.message as { content?: unknown }).content;
        if (!Array.isArray(content)) break;
        let closedAny = false;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block["type"] !== "tool_result") continue;
          const useId = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : null;
          if (!useId) continue;
          const messageId = this.#toolUseIdToMessageId.get(useId);
          if (!messageId) continue;

          const output = extractToolResultText(block["content"]);
          const isError = block["is_error"] === true;
          this.#closeToolCallWithOutput(messageId, output, !isError);
          closedAny = true;
        }
        // Re-emit a thinking indicator so the UI shows Claude is still working
        // while it decides the next step. The web frontend auto-dismisses it
        // when the next assistant content, tool_call, or status=idle arrives.
        if (closedAny && this.#status === "working") {
          const thinkingMsg = this.#makeMessage(
            "thinking",
            "Thinking...",
            this.#agentIdentity,
            undefined, undefined,
            { event: "thinking_continue" },
          );
          this.#broadcastRaw(thinkingMsg);
        }
        break;
      }
    }
  }

  #closeToolCallWithOutput(messageId: string, output: string, success: boolean): void {
    if (this.#toolCallsClosedByResult.has(messageId)) return;
    this.#toolCallsClosedByResult.add(messageId);

    const original = this.#toolCallMessages.get(messageId);
    if (!original || !original.tool) return;

    // Build an updated session.message that preserves identity + tool name +
    // original input, and records the completion state with actual output.
    const updated: SessionMessage = {
      ...original,
      tool: {
        ...original.tool,
        state: {
          phase: "completed",
          success,
          output,
        },
      },
      timestamp: new Date().toISOString(),
    };

    // Persist + feed the chunker so memory captures the real tool output.
    this.#scrollback.updateMessage(messageId, (m) => {
      const sm = m as SessionMessage;
      if (sm.tool) sm.tool.state = updated.tool!.state;
    });
    this.#transcriptStore.append(this.id, updated, this.#seq++).catch(() => {});
    this.#chunker?.onMessage(updated);

    this.#broadcastRaw({
      type: "session.message.delta",
      sessionId: this.id,
      messageId,
      toolStateUpdate: updated.tool!.state,
      timestamp: updated.timestamp,
    });

    // Remove from active list so the fallback completer doesn't clobber us.
    this.#activeToolMsgIds = this.#activeToolMsgIds.filter((id) => id !== messageId);
    this.#toolCallMessages.delete(messageId);
  }

  /** Flush the active assistant message into scrollback (for device handoff) */
  #flushActiveAssistant(): void {
    if (this.#activeAssistantMsg) {
      this.#activeAssistantMsg = null;
    }
  }

  /** Mark any still-open tool calls as completed — skips ones already closed with a real tool_result. */
  #completeActiveTools(): void {
    for (const msgId of this.#activeToolMsgIds) {
      if (this.#toolCallsClosedByResult.has(msgId)) continue;

      let updated: SessionMessage | null = null;
      this.#scrollback.updateMessage(msgId, (msg) => {
        const sm = msg as SessionMessage;
        if (sm.tool) {
          sm.tool.state = { phase: "completed", success: true };
          updated = sm;
        }
      });

      if (updated) {
        const sm = updated as SessionMessage;
        this.#transcriptStore.append(this.id, sm, this.#seq++).catch(() => {});
        // Feed the chunker so the episode closes even when we never saw a tool_result.
        this.#chunker?.onMessage(sm);
      }

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

  /** Persist to transcript + scrollback buffer + memory chunker */
  #persistAndBuffer(msg: SessionMessage): void {
    this.#scrollback.push(msg);
    this.#transcriptStore.append(this.id, msg, this.#seq++).catch(() => {});
    this.#chunker?.onMessage(msg);
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

/** Tools that only read state — safe to auto-approve in auto-allow mode. */
function isSafeTool(name: string): boolean {
  if (SAFE_TOOLS.has(name)) return true;
  // All memory recall tools are read-only.
  if (name.startsWith("mcp__codeoid_memory__")) return true;
  return false;
}

const SAFE_TOOLS = new Set<string>(["Read", "Grep", "Glob"]);

/**
 * Extract text from an Anthropic tool_result content payload. The spec allows
 * either a plain string or an array of content blocks; we flatten both to
 * a single string for memory storage. Non-text blocks become a placeholder.
 */
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block["type"] === "text" && typeof block["text"] === "string") {
      parts.push(block["text"]);
    } else if (block["type"] === "image") {
      parts.push("[image]");
    } else if (typeof block["text"] === "string") {
      parts.push(block["text"] as string);
    }
  }
  return parts.join("\n");
}
