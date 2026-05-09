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
  type SDKUserMessage,
  type PreToolUseHookInput,
  type SubagentStartHookInput,
  type SubagentStopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "./async-queue.js";
import { randomUUID } from "node:crypto";
import type {
  AuthContext,
  SessionInfo,
  SessionMode,
  SessionStatus,
  SessionUsage,
  TurnUsage,
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
import { contextWindowForModel } from "./context-windows.js";
import {
  EpisodeChunker,
  IndexScheduler,
  buildMemoryMcpServer,
  workspaceIdFromPath,
  type MemoryEngine,
} from "./memory/index.js";
import type { Attachment } from "../protocol/types.js";
import { resolveAttachments } from "./attachments.js";
import type { CodeoidConfig } from "../config.js";
import {
  CompressionRegistry,
  rewriteBashToolInput,
} from "./compress/index.js";
import { findModel, resolveModelId } from "./models.js";
import {
  callContextSize,
  decideRotation,
  type LLMCallUsage,
} from "./context-math.js";

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
  /**
   * Full parsed config — carries compress / workspaceIndex / telemetry
   * toggles. When absent, compression stays off (safe default).
   */
  config?: CodeoidConfig;
  /**
   * Optional pre-built compression registry. If provided, PreToolUse hook
   * rewrites Bash commands to route through the wrapper CLI when enabled.
   */
  compressionRegistry?: CompressionRegistry;
}

export class Session {
  readonly id: string;
  /**
   * User-visible session label. Mutable via `rename()` — callers must go
   * through the setter so the SessionInfo broadcast fires and transcript
   * audits record the change.
   */
  name: string;
  readonly workdir: string;
  readonly createdBy: string;
  readonly createdAt: string;
  /**
   * Tenancy stamps captured at session creation (or restored from disk
   * on resume). Persisted alongside the transcript meta on every
   * `setStatus` so a daemon restart picks them back up — without this
   * the fields drift to "" the moment the first status flip after
   * resume happens, and any future multi-tenant scoping on the
   * `Store.listSessions(accountId, projectId)` filter would
   * silently drop everything that's been resumed.
   */
  readonly accountId: string;
  readonly projectId: string;

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
  #indexScheduler?: IndexScheduler;
  #workspaceId: string;

  // Compression (Layer B) — toggled via config.compress.enabled.
  #config?: CodeoidConfig;
  #compressionRegistry?: CompressionRegistry;

  // ── Model selection ───────────────────────────────────────────────────
  // Both fields resolved to full Anthropic model ids (never aliases). Null
  // means "use whatever the SDK / Claude Code picks as default" — we don't
  // force a choice if neither session nor config specified one. Takes
  // effect on the NEXT send() (current stream is torn down on change).
  #model: string | null = null;
  #fallbackModel: string | null = null;

  // ── Auto-rotation (Layer D) ────────────────────────────────────────────
  // Claude Code's backing session id — distinct from codeoid's public
  // session.id so we can rotate the underlying context while keeping the
  // user-visible identity stable. Initialized to this.id at construction;
  // mutates when rotate() fires.
  #claudeCodeSessionId!: string;
  // When true, the next send() injects the task-anchor seed prefix so the
  // fresh context knows it's a continuation and memory recall is the path
  // to prior detail. Cleared after the first send post-rotation.
  #justRotated = false;
  // In-memory rotation counter (Store has the persistent one). Used for the
  // "X total rotations" display without hitting SQLite on every broadcast.
  #rotationCount = 0;
  #lastRotatedAt: number | null = null;
  // Last user turn BEFORE rotation — seeded into the new session's opening
  // prompt so the agent knows what it was working on. Captured inside
  // rotate() from the most recent user_turn episode.
  #lastUserTurnBeforeRotate: string | null = null;
  // Claude's context window. Opus 4.7 + Sonnet 4.x (1M beta) share 1M; we
  // compute occupancy against this constant. Making it tunable per-session
  // was considered overkill — users rarely run sub-1M models via codeoid.
  static readonly CONTEXT_WINDOW = 1_000_000;

  // Execution mode + turn budget (autonomous mode only).
  #mode: SessionMode = "interactive";
  #turnsRemaining: number | undefined = undefined;

  // Cumulative token + cost totals, aggregated from SDK `result` messages
  // (one per turn). Broadcast via session.info_update so StatusBar-style
  // UIs can render a running counter without polling. The authoritative
  // store is the `turn_usage` SQLite table — #usage is a cached projection
  // rebuilt from the DB on session load and kept fresh per-turn.
  #usage: SessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0,
    numTurns: 0,
    durationMs: 0,
    recentTurns: [],
    peakInputTokens: 0,
  };

  /** Cap on how many recent turns we embed in SessionInfo broadcasts. */
  static readonly RECENT_TURNS_KEEP = 20;

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

  // ── Per-turn usage accumulator (primary vs subagent split) ─────────────
  // SDK's `result.usage` sums ALL API calls in a turn — including any
  // subagents spawned via the Task tool. But subagents have their own
  // context windows; summing them into "ctx" would defeat the whole
  // point of delegating work to subagents (to keep the primary context
  // clean). We stream `SDKAssistantMessage` events and split by
  // `parent_tool_use_id`:
  //   - null → primary agent's LLM call (accumulate into `primary`)
  //   - non-null → subagent call (accumulate separately, for diagnostics)
  //
  // `primary.maxCallContext` is the CURRENT primary context size — the
  // biggest single primary-agent API call seen this turn. That's the
  // number we report as `ctx` + use for rotation decisions.
  #primaryTurnCalls: LLMCallUsage[] = [];
  #subagentTurnCalls: LLMCallUsage[] = [];
  /**
   * Running max of primaryCtx across all turns this session — the real
   * "peak" indicator. Persisted implicitly via being recomputed from the
   * Store's aggregated peak as a floor, then bumped as new turns come in.
   */
  #primaryPeakContext = 0;
  /** Running total of cache_read from primary calls only (for honest avg). */
  #primaryCacheReadCumulative = 0;

  // ── Stream input mode (VSCode-style mid-turn messaging) ───────────────
  // One long-running `query()` per (session, backing_session_id). The
  // input queue lives for that query's lifetime and accepts new user
  // messages at any time — mid-turn, after a turn, doesn't matter. The
  // SDK's `priority` field on SDKUserMessage controls whether a mid-turn
  // push interrupts immediately ("now") or waits for turn end ("next"/"later").
  //
  // Lifecycle: created lazily on first send, torn down on rotation /
  // destroy / SDK error. Subsequent sends restart the loop.
  #inputQueue: AsyncQueue<SDKUserMessage> | null = null;
  #consumerTask: Promise<void> | null = null;

  // Active streaming message — accumulates deltas into a complete message for scrollback
  #activeAssistantMsg: SessionMessage | null = null;
  // Active thinking message — Claude's extended reasoning, streamed live so
  // the user can see what the model is considering before it acts.
  #activeThinkingMsg: SessionMessage | null = null;
  // Which content block index the active thinking corresponds to (so we
  // only finalize it on the matching content_block_stop).
  #activeThinkingIndex: number | null = null;

  // Pending tool approvals: approvalId → resolve({approved, updatedInput?})
  // `updatedInput` is the form-data patch the client may attach (e.g.
  // AskUserQuestion's `answers` map) — see SessionApproveMsg.
  #pendingApprovals = new Map<
    string,
    (result: { approved: boolean; updatedInput?: Record<string, unknown> }) => void
  >();

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

  // Live MCP state captured from the SDK's `system/init` events. The SDK
  // emits one init per query, so these are refreshed on every send(). Keyed
  // by the SDK-reported server name (which matches what we read from
  // ~/.claude.json). Empty until the first turn starts.
  #sdkMcpStatus = new Map<string, string>();
  #sdkMcpTools = new Map<string, string[]>();

  constructor(opts: SessionCreateOptions) {
    this.id = opts.existingId ?? randomUUID();
    this.name = opts.name;
    this.workdir = opts.workdir;
    this.createdBy = opts.auth.sub;
    this.createdAt = new Date().toISOString();
    this.accountId = opts.auth.accountId;
    this.projectId = opts.auth.projectId;
    this.#store = opts.store;
    this.#transcriptStore = opts.transcriptStore;
    this.#identityManager = opts.identityManager;
    this.#memory = opts.memory;
    this.#config = opts.config;
    this.#compressionRegistry = opts.compressionRegistry;
    this.#workspaceId = workspaceIdFromPath(opts.workdir);
    // Initialize backing Claude Code session id. On resume, the Store
    // may already have one — restore it. Otherwise default to this.id
    // so existing sessions remain backwards-compatible.
    const persistedBackingId = this.#store.getClaudeCodeSessionId(this.id);
    this.#claudeCodeSessionId = persistedBackingId ?? this.id;
    // Rotation counters — populated from Store so they survive restart.
    const stats = this.#store.getRotationStats(this.id);
    this.#rotationCount = stats.count;
    this.#lastRotatedAt = stats.lastRotatedAt;

    // Model selection — prefer persisted session choice, fall back to
    // config default, else leave null (SDK default). Always resolve to
    // full id so downstream code doesn't see aliases.
    const persistedModel = this.#store.getSessionModel(this.id);
    this.#model =
      persistedModel.model ??
      resolveModelId(opts.config?.session.defaultModel ?? "") ??
      null;
    this.#fallbackModel =
      persistedModel.fallbackModel ??
      resolveModelId(opts.config?.session.fallbackModel ?? "") ??
      null;

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

    // Restore cumulative usage from SQLite so the StatusBar reflects any
    // prior turns after a daemon restart. No-op on first-ever session start.
    if (opts.memory) {
      try {
        this.#refreshUsageFromStore();
      } catch (err) {
        console.error(
          `[codeoid/usage] restore failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (this.#memory) {
      const memory = this.#memory;
      this.#indexScheduler = new IndexScheduler({
        store: memory.store,
        workspaceId: this.#workspaceId,
        currentSessionId: this.id,
        workdir: opts.workdir,
      });
      const scheduler = this.#indexScheduler;
      this.#chunker = new EpisodeChunker(
        {
          workspaceId: this.#workspaceId,
          sessionId: this.id,
          createdBy: opts.auth.sub,
        },
        (episode) => {
          try {
            memory.ingest(episode);
            scheduler.onEpisode();
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

  /**
   * Snapshot of the SDK-reported MCP state for this session, captured
   * from the most recent `system/init` event. `claude.config` merges this
   * over the static config we read from disk so the drawer can show live
   * connection status + the actual tools available to the agent.
   */
  get sdkMcpSnapshot(): { status: Map<string, string>; tools: Map<string, string[]> } {
    return { status: this.#sdkMcpStatus, tools: this.#sdkMcpTools };
  }
  get agentUri(): string | undefined { return this.#agentIdentity.sub; }
  get mode(): SessionMode { return this.#mode; }
  get turnsRemaining(): number | undefined { return this.#turnsRemaining; }
  get pinnedFiles(): readonly string[] { return this.#pinnedFiles; }
  get model(): string | null { return this.#model; }
  get fallbackModel(): string | null { return this.#fallbackModel; }

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

  /**
   * Update the user-visible name. No-ops when `next` matches the current
   * name. Broadcasts `session.info_update` so every attached client
   * refreshes its tab label without a separate list roundtrip.
   */
  rename(next: string, sender: AuthContext): void {
    const trimmed = next.trim();
    if (!trimmed || trimmed === this.name) return;
    this.#store.audit(
      sender.sub,
      "session.rename",
      this.id,
      `from=${this.name} to=${trimmed}`,
    );
    this.name = trimmed;
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
    priority?: "now" | "next" | "later",
  ): Promise<void> {
    this.#store.audit(sender.sub, "session.send", this.id);

    // Snapshot status BEFORE we do anything that might change it. If the
    // session was already working when this send arrived, the user wants
    // the new message to land mid-turn — auto-promote priority to `now`
    // so the SDK's agent loop observes it immediately rather than FIFO
    // queueing it behind the current turn's output.
    const wasWorking = this.#status === "working";

    // Pre-send rotation check. Auto-rotate if enabled AND we're above the
    // configured threshold AND past the min-turns safety window. Hard-
    // rotation fires even when disabled. Runs before queueing so the
    // seed prompt gets fed to the NEW query, not the stale one.
    if (this.#shouldRotate()) {
      await this.#rotate(sender, "auto");
    }

    // Merge pinned + per-turn attachments (dedup by path, per-turn wins).
    const allAttachments = this.#buildEffectiveAttachments(attachments);
    const { resolved, promptPrefix } = resolveAttachments(allAttachments, {
      workdir: this.workdir,
    });
    // Rotation seed: on the first send after a rotation, prepend a
    // task-anchor block so the fresh Claude Code session knows what the
    // user was working on and how to fetch prior detail via memory.recall.
    const rotationSeed = this.#justRotated ? this.#buildRotationSeed(text) : "";
    if (this.#justRotated) this.#justRotated = false;
    const effectivePrompt = `${rotationSeed}${promptPrefix}${text}`;

    // The user-visible message carries the bare text plus a metadata
    // breadcrumb. Emitted immediately so the TUI sees the user's message
    // before Claude starts responding (even when queued mid-turn).
    const userIdentity = authToIdentity(sender);
    const attachmentSummary = resolved.map((r) => ({
      path: r.path,
      pinned: this.#pinnedFiles.includes(r.path),
      bytes: r.bytes,
      error: r.error,
      binary: r.binary,
      mimeType: r.mimeType,
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

    // Ensure a long-running query is bound to this session's backing
    // Claude Code session. First send + post-rotation sends start the
    // consumer loop; subsequent sends re-use it and push into the queue.
    await this.#ensureQueryLoop(sender);

    // Resolve priority. Explicit caller value wins. Otherwise: `now` when
    // the session was already mid-turn (VSCode-style responsiveness);
    // `later` for the idle case (identical semantics to `now` when nothing
    // is in flight but cheaper to reason about).
    const effectivePriority: "now" | "next" | "later" =
      priority ?? (wasWorking ? "now" : "later");

    // Mid-turn pushes interrupt Claude's in-flight LLM call (the SDK aborts
    // the HTTP stream and restarts with the new context). That costs 1-2s
    // of time-to-first-token latency — surface an info message so the user
    // has immediate feedback that the push was received.
    if (wasWorking) {
      const hint =
        effectivePriority === "now"
          ? "⎆ Queued mid-turn — Claude is re-integrating with new context"
          : effectivePriority === "next"
            ? "⎆ Queued — will be picked up after current turn completes"
            : "⎆ Queued";
      const midTurnMsg = this.#makeMessage(
        "info",
        hint,
        SYSTEM_IDENTITY,
        undefined,
        undefined,
        { event: "midturn_queued", priority: effectivePriority },
      );
      this.#persistAndBuffer(midTurnMsg);
      this.#broadcastRaw(midTurnMsg);
    }

    // Push the user message into the input stream. Claude's consumer loop
    // picks it up — immediately if `priority: "now"`, after current turn
    // if `"next"`, FIFO otherwise. Fire-and-forget from our side.
    this.#pushUserMessage(effectivePrompt, effectivePriority);
    this.#setStatus("working");
    // Broadcast info_update so StatusBar reflects the new queue depth.
    this.#broadcastInfoUpdate();
  }

  /**
   * Lazily start the long-running Claude Code query bound to this
   * session's backing id. Idempotent — returns immediately when a
   * consumer task is already healthy.
   */
  async #ensureQueryLoop(sender: AuthContext): Promise<void> {
    if (this.#consumerTask && this.#inputQueue && !this.#inputQueue.closed) {
      return; // already running
    }

    const im = this.#identityManager;

    // Register agent identity on very first query — the SessionStart hook
    // doesn't fire via SDK query(), so we do it here once per session.
    if (im && !this.#hasQueried && this.#agentIdentity.sub.startsWith("agent:")) {
      try {
        const { wimseUri } = await im.registerSessionAgent(
          this.id,
          this.name,
          sender.sub,
        );
        this.#agentIdentity = {
          sub: wimseUri,
          name: `${this.name} agent`,
          type: "agent",
        };
        console.log(`[codeoid] agent identity registered: ${wimseUri}`);
        const infoMsg = this.#makeMessage(
          "info",
          `Agent identity registered`,
          SYSTEM_IDENTITY,
          undefined,
          undefined,
          {
            event: "identity.registered",
            agentUri: wimseUri,
            sessionName: this.name,
            createdBy: sender.sub,
          },
        );
        this.#persistAndBuffer(infoMsg);
        this.#broadcastRaw(infoMsg);
      } catch (err) {
        console.error(
          `[codeoid] agent identity registration failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const sessionId = this.id;
    this.#abortController = new AbortController();
    this.#inputQueue = new AsyncQueue<SDKUserMessage>();

    // First-ever query creates the backing session. Subsequent queries (after
    // rotation or daemon restart) resume. `#hasQueried` persists across the
    // Session's life to distinguish these cases.
    const sessionOpts = this.#hasQueried
      ? { resume: this.#claudeCodeSessionId }
      : { sessionId: this.#claudeCodeSessionId };

    // Build MCP memory server for this session so Claude can call recall()
    const mcpServers = this.#memory
      ? {
          codeoid_memory: buildMemoryMcpServer(this.#memory, {
            workspaceId: this.#workspaceId,
            sessionId: this.id,
          }),
        }
      : undefined;

    this.#query = query({
      prompt: this.#inputQueue,
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
        // Adaptive thinking — lets the model decide how deeply to reason per
        // turn. Without this, many prompts ship thinking=disabled and the
        // TUI's gray reasoning block stays empty. Adaptive = small prompts
        // get no overhead, hard prompts get visible reasoning.
        thinking: { type: "adaptive" as const },
        // Model selection — null means "leave to Claude Code's default"
        // (don't force a specific model on users who haven't opted in).
        // When set, propagates to the SDK subprocess via the `--model` CLI
        // flag and the Messages API's `model` field.
        ...(this.#model ? { model: this.#model } : {}),
        // Fallback model: SDK retries here on 429/529 capacity errors so
        // the user doesn't see a hard failure during rate-limited windows.
        ...(this.#fallbackModel ? { fallbackModel: this.#fallbackModel } : {}),
        // Capture subprocess stderr into the daemon log so spawn failures are debuggable.
        stderr: (data: string) => {
          process.stderr.write(`[claude-subprocess ${this.id.slice(0, 8)}] ${data}`);
        },
        ...(mcpServers ? { mcpServers } : {}),
        ...(this.#memory
          ? {
              // Build the system-prompt append by stacking:
              //   (1) MEMORY_SYSTEM_PROMPT_APPEND — stable across turns, cached by
              //       prompt cache since the string never changes.
              //   (2) IndexScheduler.get() — the workspace memory index. Cheaply
              //       rebuilt when episodes accumulate; gated by debounce so cache
              //       invalidation stays bounded to ~1/minute of active work.
              // Putting the stable text first lets the prompt cache hold more
              // often than if the dynamic index came first.
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: this.#buildMemoryPromptAppend(),
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

              // Compression (Layer B): rewrite Bash tool_input to route
              // through the codeoid wrapper CLI when enabled + eligible.
              // Returns null on any non-applicable path — then we pass
              // through unchanged.
              if (this.#config && this.#compressionRegistry) {
                const rewritten = rewriteBashToolInput({
                  toolName: input.tool_name,
                  toolInput: (input.tool_input ?? {}) as Record<string, unknown>,
                  config: this.#config,
                  registry: this.#compressionRegistry,
                  workdir: this.workdir,
                });
                if (rewritten) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      updatedInput: rewritten,
                    },
                  };
                }
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
                input: inputObj,
                state: { phase: "executing", input: inputObj } as unknown as ToolState,
              },
            );
            this.#activeToolMsgIds.push(autoMsg.messageId);
            this.#toolCallMessages.set(autoMsg.messageId, autoMsg);
            this.#persistAndBuffer(autoMsg);
            this.#broadcastRaw(autoMsg);
            this.#store.audit(sender.sub, "session.auto_approve", this.id, `tool=${toolName} mode=${this.#mode}`);
            return { behavior: "allow" as const, updatedInput: inputObj };
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
              input: inputObj,
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

          const { approved, updatedInput } = await this.#waitForApproval(approvalId);
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

            // updatedInput must be present even when we don't change anything —
            // SDK's runtime Zod schema rejects `{behavior:"allow"}` without
            // it, even though the published TS types say it's optional.
            //
            // SECURITY: only allow `updatedInput` to inject NEW fields the
            // tool legitimately needs from a form-style approval. Without a
            // whitelist, a client with `session:approve` could swap a Bash
            // tool's `command` at the moment of approval — UI shows the
            // user `Bash(ls)` (the input recorded in the
            // waiting_confirmation state), they approve, but the daemon
            // hands the SDK whatever patch the client supplied. Per-tool
            // allowlist below: AskUserQuestion answers map only;
            // everything else falls through to the original input.
            const sanitizedPatch = sanitizeApprovalPatch(toolName, updatedInput);
            const merged: Record<string, unknown> = sanitizedPatch
              ? { ...inputObj, ...sanitizedPatch }
              : inputObj;
            return { behavior: "allow" as const, updatedInput: merged };
          }

          this.#store.audit(sender.sub, "session.deny", this.id, `tool=${toolName} approvalId=${approvalId}`);
          return { behavior: "deny" as const, message: "Denied by user" };
        },
      },
    });

    this.#hasQueried = true;

    // Drive the SDK stream in the background. The consumer never blocks
    // send() — user messages keep flowing through the queue while Claude
    // emits events at its own pace.
    const query$ = this.#query;
    const ac = this.#abortController;
    this.#consumerTask = (async () => {
      try {
        for await (const msg of query$) {
          this.#handleAgentMessage(msg);
        }
      } catch (err) {
        if (!ac.signal.aborted) {
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
            undefined,
            undefined,
            { event: "agent_error", errorCode: "agent_error" },
          );
          this.#persistAndBuffer(errorMsg);
          this.#broadcastRaw(errorMsg);
        }
      } finally {
        // Cleanup per-loop state. Next send() will start a fresh loop.
        this.#completeActiveTools();
        this.#flushActiveAssistant();
        this.#finalizeActiveThinking();
        this.#chunker?.onTurnEnd();
        if (this.#query === query$) this.#query = null;
        if (this.#abortController === ac) this.#abortController = null;
        this.#inputQueue?.close();
        this.#inputQueue = null;
        this.#consumerTask = null;
        // Resolve any pending tool approvals — they're awaiting
        // canUseTool callbacks that will never fire on a torn-down
        // SDK loop. Without this, the client-side `await
        // session.approve(...)` hangs and the awaiter promise leaks.
        // Also flips the matching tool_call rows in scrollback to
        // `cancelled/interrupted` so the ApprovalBar dismisses.
        if (this.#pendingApprovals.size > 0) {
          // Synthetic auth context — only used as the audit subject
          // for the cancelled deltas we're about to broadcast.
          const systemAuth: AuthContext = {
            sub: "system",
            scopes: [],
            delegationDepth: 0,
            accountId: this.accountId,
            projectId: this.projectId,
          };
          for (const [aid, resolveFn] of this.#pendingApprovals.entries()) {
            resolveFn({ approved: false });
            this.#dismissStaleApproval(aid, systemAuth);
          }
          this.#pendingApprovals.clear();
        }
        if (this.#status !== "error") this.#setStatus("idle");
      }
    })();
  }

  /**
   * Push a user message into the active SDK stream. Must only be called
   * when `#inputQueue` is non-null (i.e. after #ensureQueryLoop).
   */
  #pushUserMessage(
    content: string,
    priority: "now" | "next" | "later",
  ): void {
    if (!this.#inputQueue) {
      console.error(
        `[codeoid/session ${this.id}] push without active query — dropping message`,
      );
      return;
    }
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.#claudeCodeSessionId,
      priority,
    };
    try {
      this.#inputQueue.push(msg);
    } catch (err) {
      console.error(
        `[codeoid/session ${this.id}] queue push failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Tear down the active query loop — used on rotation and destroy.
   * Closes the input queue (ends the SDK stream cleanly), aborts the
   * controller, and awaits the consumer task so we don't leave orphan
   * goroutines draining into a post-rotation session.
   */
  async #teardownQueryLoop(): Promise<void> {
    this.#inputQueue?.close();
    this.#abortController?.abort();
    if (this.#consumerTask) {
      try {
        await this.#consumerTask;
      } catch {
        /* consumer handles its own errors */
      }
    }
    this.#inputQueue = null;
    this.#consumerTask = null;
    this.#query = null;
    this.#abortController = null;
  }

  interrupt(sender: AuthContext): void {
    this.#store.audit(sender.sub, "session.interrupt", this.id);
    // Finalize any in-flight streaming messages RIGHT NOW so the TUI's
    // live region doesn't keep spinning on content the model won't finish
    // emitting. The consumer task's finally block also calls these, but
    // there's a window between abort and finally where the user sees
    // stuck spinners — doing it here flushes immediately.
    this.#flushActiveAssistant();
    this.#finalizeActiveThinking();
    // Abort aborts the whole SDK stream. The consumer task picks that up
    // via its try/catch and cleans itself up. Next send() will start a
    // fresh loop. Approvals are always unblocked to avoid orphan waiters.
    this.#abortController?.abort();
    // Best-effort close — consumer cleanup also nulls this, but closing
    // early prevents any pending push from sneaking in between.
    this.#inputQueue?.close();
    for (const resolve of this.#pendingApprovals.values()) {
      resolve({ approved: false });
    }
    this.#pendingApprovals.clear();

    const infoMsg = this.#makeMessage(
      "info",
      `⏹ Session interrupted by ${sender.sub}. The current turn was aborted; send a new message to continue.`,
      SYSTEM_IDENTITY,
      undefined,
      undefined,
      { event: "session.interrupt", sub: sender.sub },
    );
    this.#persistAndBuffer(infoMsg);
    this.#broadcastRaw(infoMsg);
  }

  approve(
    approvalId: string,
    approved: boolean,
    sender: AuthContext,
    updatedInput?: Record<string, unknown>,
  ): void {
    const resolve = this.#pendingApprovals.get(approvalId);
    if (!resolve) {
      // SECURITY: do NOT fall back to "resolve the first pending" any
      // more. The old fallback let any client with `session:approve`
      // resolve another client's pending approval just by sending an
      // unrelated id. Every UI we ship now sends the real id; if a
      // future client doesn't, fail closed rather than mis-resolving.
      //
      // No live approval matches. Most likely a stale tool_call left
      // in `waiting_confirmation` after a daemon restart or failed
      // canUseTool — the SDK will never call us back for it. Walk
      // scrollback, find the matching tool_call by approvalId, and
      // flip it to cancelled so the ApprovalBar dismisses.
      this.#dismissStaleApproval(approvalId, sender);
      return;
    }

    this.#store.audit(sender.sub, approved ? "session.approve" : "session.deny", this.id, `approvalId=${approvalId}`);
    resolve({ approved, updatedInput });
    this.#pendingApprovals.delete(approvalId);
  }

  #dismissStaleApproval(approvalId: string, sender: AuthContext): void {
    const messages = this.#scrollback.read() as SessionMessage[];
    let target: SessionMessage | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== "tool_call" || !m.tool) continue;
      const state = m.tool.state;
      if (state.phase === "waiting_confirmation" && state.approvalId === approvalId) {
        target = m;
        break;
      }
    }
    if (!target) return;
    this.#store.audit(sender.sub, "session.deny_stale", this.id, `approvalId=${approvalId}`);
    this.#broadcastRaw({
      type: "session.message.delta",
      sessionId: this.id,
      messageId: target.messageId,
      toolStateUpdate: {
        phase: "cancelled",
        reason: "interrupted",
        message: "approval was no longer pending",
      },
      timestamp: new Date().toISOString(),
    });
  }

  async destroy(sender: AuthContext): Promise<void> {
    this.#store.audit(sender.sub, "session.destroy", this.id);
    // Tear down the streamInput loop cleanly before wiping storage so we
    // don't leave a zombie SDK subprocess alive holding the transcript file.
    await this.#teardownQueryLoop();
    for (const resolve of this.#pendingApprovals.values()) {
      resolve({ approved: false });
    }
    this.#pendingApprovals.clear();
    this.#clients.clear();
    await this.#identityManager?.deactivateSessionAgent(this.id);
    this.#store.deleteSession(this.id);
    await this.#transcriptStore.delete(this.id);
  }

  restoreScrollback(messages: DaemonMessage[]): void {
    for (const msg of messages) {
      if (msg.type !== "session.message") continue;
      // Any tool_call still in `waiting_confirmation` after a daemon restart
      // is orphaned — `#pendingApprovals` lives in memory only, so the SDK
      // will never call canUseTool again for this approvalId. Rewrite to
      // `cancelled` before persisting so the ApprovalBar doesn't resurrect a
      // ghost prompt the user can't actually answer.
      if (
        msg.role === "tool_call" &&
        msg.tool &&
        msg.tool.state.phase === "waiting_confirmation"
      ) {
        const stale: SessionMessage = {
          ...msg,
          tool: {
            ...msg.tool,
            state: {
              phase: "cancelled",
              reason: "interrupted",
              message: "approval lost on daemon restart",
            },
          },
        };
        this.#scrollback.push(stale);
        continue;
      }
      this.#scrollback.push(msg);
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
      usage: { ...this.#usage },
      rotation: {
        count: this.#rotationCount,
        lastRotatedAt: this.#lastRotatedAt,
        claudeCodeSessionId: this.#claudeCodeSessionId,
      },
      queuedMessages: this.#inputQueue?.size ?? 0,
      model: this.#model ?? undefined,
      fallbackModel: this.#fallbackModel ?? undefined,
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
   * Persist a turn's usage from an SDK `result` message into SQLite and
   * refresh the in-memory cumulative projection. Single source of truth is
   * the DB; #usage is a cache for fast broadcasts. Also handles the error
   * surface (the old inline path used to do this).
   */
  #recordTurnFromResult(msg: unknown): void {
    const turn = msg as {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      total_cost_usd?: number;
      duration_ms?: number;
      stop_reason?: string | null;
      is_error?: boolean;
      error?: unknown;
      subtype?: string;
    };

    // Surface error sub-types as system messages (used to happen in the
    // old inline accumulator).
    if (turn.subtype && turn.subtype !== "success" && turn.error) {
      const errorMsg = this.#makeMessage(
        "system",
        `Error: ${typeof turn.error === "string" ? turn.error : JSON.stringify(turn.error)}`,
        SYSTEM_IDENTITY,
        undefined,
        undefined,
        { event: "agent_error" },
      );
      this.#persistAndBuffer(errorMsg);
      this.#broadcastRaw(errorMsg);
    }

    // Anthropic semantics: input_tokens = NEW input only (not cache).
    // Total context = input + cache_read + cache_creation.
    const input = turn.usage?.input_tokens ?? 0;
    const output = turn.usage?.output_tokens ?? 0;
    const cacheRead = turn.usage?.cache_read_input_tokens ?? 0;
    const cacheCreate = turn.usage?.cache_creation_input_tokens ?? 0;
    const total = input + cacheRead + cacheCreate;
    const billable = input + cacheCreate;
    const hitRate = total > 0 ? cacheRead / total : 0;

    // PRIMARY-ONLY CONTEXT SIZE — the honest ctx metric. We streamed
    // per-call usage from each `SDKAssistantMessage.message.usage` and
    // bucketed by `parent_tool_use_id` (null = primary). `primaryCtx`
    // here is the max across those primary calls: the biggest snapshot
    // of the primary agent's context during this turn = current ctx.
    //
    // Fallback: if the SDK didn't give us per-call usage (unlikely but
    // possible on older Claude Code versions), degrade to the summed
    // `total` so we still report something — just noted in the log.
    let primaryCtx = 0;
    let primaryCacheReadThisTurn = 0;
    for (const c of this.#primaryTurnCalls) {
      const size = callContextSize(c);
      if (size > primaryCtx) primaryCtx = size;
      primaryCacheReadThisTurn += c.cacheReadTokens;
    }
    const subagentCallCount = this.#subagentTurnCalls.length;
    // Reset accumulators for the next turn (result marks turn end).
    this.#primaryTurnCalls = [];
    this.#subagentTurnCalls = [];
    if (primaryCtx === 0 && total > 0) {
      // Per-call usage missing — fall back to summed usage but cap at
      // window so a multi-call sum doesn't report > 100% occupancy.
      primaryCtx = Math.min(total, Session.CONTEXT_WINDOW);
      primaryCacheReadThisTurn = cacheRead; // best we can do on fallback
    }

    // If the memory engine isn't enabled we have no durable store — fall
    // back to pure in-memory accumulation so StatusBar still gets usage.
    const store = this.#memory?.store;
    if (!store) {
      this.#usage.inputTokens += input;
      this.#usage.outputTokens += output;
      this.#usage.cacheReadTokens += cacheRead;
      this.#usage.cacheCreationTokens += cacheCreate;
      this.#usage.totalCostUsd += turn.total_cost_usd ?? 0;
      this.#usage.durationMs += turn.duration_ms ?? 0;
      this.#usage.numTurns += 1;
      // PEAK tracks primary-only — ignore subagent contributions so a
      // subagent-heavy turn doesn't poison the bloat canary.
      this.#usage.peakInputTokens = Math.max(
        this.#usage.peakInputTokens ?? 0,
        primaryCtx,
      );
      this.#usage.lastTurnInputTokens = primaryCtx;
      this.#usage.lastTurnOutputTokens = output;
      this.#usage.lastTurnCostUsd = turn.total_cost_usd ?? 0;
      this.#usage.lastTurnCacheHitRate = hitRate;
      this.#broadcastInfoUpdate();
      return;
    }
    void subagentCallCount; // intentionally tracked for future telemetry

    const turnNumber = store.nextTurnNumber(this.id);
    const record: TurnUsage = {
      turnNumber,
      createdAt: Date.now(),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreate,
      totalCostUsd: turn.total_cost_usd ?? 0,
      durationMs: turn.duration_ms ?? 0,
      stopReason: turn.stop_reason ?? undefined,
      totalInputTokens: total,
      billableInputTokens: billable,
      cacheHitRate: hitRate,
      // Honest per-turn ctx-of-window denominator. > 0 only when the SDK
      // streamed per-call usage AND we tracked it; 0 fallback ends up
      // null in storage, so refreshUsageFromStore degrades to legacy
      // sum-based math for those rows.
      ...(primaryCtx > 0 ? { primaryMaxCallInputTokens: primaryCtx } : {}),
    };

    try {
      store.recordTurnUsage({
        workspaceId: this.#workspaceId,
        sessionId: this.id,
        turn: record,
      });
    } catch (err) {
      console.error(
        `[codeoid/usage] recordTurnUsage failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Bump primary peak + cumulative now (before the refresh below
    // which recomputes derived fields from in-memory + DB state).
    if (primaryCtx > this.#primaryPeakContext) {
      this.#primaryPeakContext = primaryCtx;
    }
    this.#primaryCacheReadCumulative += primaryCacheReadThisTurn;

    this.#refreshUsageFromStore(record, primaryCtx);
    this.#broadcastInfoUpdate();
  }

  /**
   * Rebuild the cumulative #usage projection from SQLite. Called on session
   * load (daemon restart) and after each turn record so StatusBar stays in
   * sync without caller bookkeeping. Optional `lastTurn` parameter seeds
   * the "last turn" fields when we have fresher data than the DB read.
   *
   * `primaryCtxHint` (when present) is the PRIMARY-ONLY context size for
   * the most recent turn, computed via per-call `SDKAssistantMessage`
   * usage parsing. It overrides the summed-usage figure (which inflates
   * on subagent-heavy turns). On session load (no hint), falls back to
   * the Store's aggregated peak — not ideal but bounded by the new
   * cap-at-window semantics, so never nonsensical.
   */
  #refreshUsageFromStore(lastTurn?: TurnUsage, primaryCtxHint?: number): void {
    const store = this.#memory?.store;
    if (!store) return;

    const totals = store.sessionUsageTotals(this.id);
    const recent = store.listTurnsForSession(
      this.id,
      Session.RECENT_TURNS_KEEP,
    );
    const mostRecent = lastTurn ?? recent[0];

    // ctx metric, in priority order:
    //   1. Fresh in-memory hint from the just-completed turn (live).
    //   2. Persisted `primaryMaxCallInputTokens` on the most recent row
    //      — the honest single-call max, set by recordUsageFromTurn for
    //      every turn since this column was added.
    //   3. Legacy fallback: `totalInputTokens` (SUM across calls in a
    //      tool-using turn) capped at the window. Over-reports for
    //      tool-heavy turns but the only signal we have for old rows.
    const fallbackTotal = mostRecent
      ? mostRecent.primaryMaxCallInputTokens ??
        Math.min(mostRecent.totalInputTokens, Session.CONTEXT_WINDOW)
      : undefined;
    const lastPrimary = primaryCtxHint ?? fallbackTotal;

    // Peak: use our in-memory primary-only tracker if populated (live
    // session); fall back to the Store's aggregated peak for historical
    // data, but cap at the window so nothing inflates past 100%.
    const peakFallback = Math.min(totals.peakInputTokens, Session.CONTEXT_WINDOW);
    const peakPrimary = Math.max(this.#primaryPeakContext, peakFallback);
    if (peakPrimary > this.#primaryPeakContext) {
      this.#primaryPeakContext = peakPrimary; // backfill on first load
    }

    this.#usage = {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      totalCostUsd: totals.totalCostUsd,
      numTurns: totals.numTurns,
      durationMs: totals.durationMs,
      recentTurns: recent,
      peakInputTokens: peakPrimary,
      lastTurnInputTokens: lastPrimary,
      lastTurnOutputTokens: mostRecent?.outputTokens,
      lastTurnCostUsd: mostRecent?.totalCostUsd,
      lastTurnCacheHitRate: mostRecent?.cacheHitRate,
      contextWindow: contextWindowForModel(this.#model),
    };
  }

  /**
   * Switch the session's model (and optionally its fallback). Resolves
   * aliases to full ids, persists, tears down the current streamInput
   * loop so the next send starts with the new model, and emits a scroll-
   * back warning so the user knows to expect a one-time cache re-seed
   * cost on the next turn.
   *
   * Returns the resolved full model id on success, or throws with a clear
   * error when the id can't be resolved. Fallback clearing: pass `null`.
   */
  async setModel(
    model: string,
    fallbackModel: string | null | undefined,
    sender: AuthContext,
  ): Promise<{ model: string; fallbackModel: string | null }> {
    const resolved = resolveModelId(model);
    if (!resolved) {
      throw new Error(
        `Unknown model "${model}". Try opus / sonnet / haiku, or a full claude-* id.`,
      );
    }
    // Fallback semantics:
    //   undefined → leave current value alone
    //   null      → clear explicitly
    //   string    → resolve + set
    let nextFallback: string | null | undefined = undefined;
    if (fallbackModel === null) {
      nextFallback = null;
    } else if (typeof fallbackModel === "string") {
      const rf = resolveModelId(fallbackModel);
      if (!rf) {
        throw new Error(`Unknown fallback model "${fallbackModel}".`);
      }
      nextFallback = rf;
    }

    const prev = this.#model;
    this.#model = resolved;
    if (nextFallback !== undefined) this.#fallbackModel = nextFallback;

    // Persist. Passing `undefined` for the fallback argument means "don't
    // touch the persisted fallback" — matches our in-memory semantic.
    this.#store.setSessionModel(this.id, resolved, nextFallback);
    this.#store.audit(
      sender.sub,
      "session.set_model",
      this.id,
      `model=${resolved} fallback=${nextFallback ?? "(unchanged)"} from=${prev ?? "(default)"}`,
    );

    // Tear down current stream so the new model kicks in on next send.
    // No effect when no loop is active.
    await this.#teardownQueryLoop();

    const desc = findModel(resolved);
    const label = desc ? desc.label : resolved;
    const info = this.#makeMessage(
      "info",
      `⎆ Model switched to ${label}${nextFallback !== undefined ? ` (fallback: ${nextFallback ? findModel(nextFallback)?.label ?? nextFallback : "none"})` : ""}. Next turn will re-seed the prompt cache.`,
      SYSTEM_IDENTITY,
      undefined,
      undefined,
      {
        event: "session.model_changed",
        model: resolved,
        fallback_model: this.#fallbackModel,
        prev_model: prev,
      },
    );
    this.#persistAndBuffer(info);
    this.#broadcastRaw(info);
    this.#broadcastInfoUpdate();

    return { model: resolved, fallbackModel: this.#fallbackModel };
  }

  /**
   * Public entry for `/rotate` slash command — a user-initiated rotation.
   * Still respects the min-turns guard so a fresh session can't rotate to
   * itself on turn 1.
   */
  async manualRotate(sender: AuthContext): Promise<boolean> {
    if (this.#usage.numTurns < (this.#config?.autoRotate.minTurnsBeforeRotate ?? 3)) {
      const infoMsg = this.#makeMessage(
        "info",
        `Cannot rotate: session has only ${this.#usage.numTurns} turn(s) so far — min is ${this.#config?.autoRotate.minTurnsBeforeRotate ?? 3}.`,
        SYSTEM_IDENTITY,
        undefined,
        undefined,
        { event: "rotation.rejected", reason: "min_turns" },
      );
      this.#persistAndBuffer(infoMsg);
      this.#broadcastRaw(infoMsg);
      return false;
    }
    await this.#rotate(sender, "manual");
    return true;
  }

  /**
   * Decide whether to auto-rotate before the next query. Uses the most
   * recent turn's total context size as the occupancy signal — that IS
   * what Claude will see on the next turn (same transcript re-sent).
   */
  #shouldRotate(): boolean {
    if (!this.#config) return false;
    const ar = this.#config.autoRotate;
    // Uses the primary-only context size (lastTurnInputTokens is already
    // primary-only post-refactor). Subagent usage is intentionally
    // excluded — the whole point of subagents is to keep the primary
    // context clean; rotating because a subagent did heavy work would
    // defeat that.
    const decision = decideRotation({
      primaryLastTurnContext: this.#usage.lastTurnInputTokens ?? 0,
      numTurns: this.#usage.numTurns,
      enabled: ar.enabled,
      rotatePct: ar.rotatePct,
      hardRotatePct: ar.hardRotatePct,
      minTurnsBeforeRotate: ar.minTurnsBeforeRotate,
      contextWindow: Session.CONTEXT_WINDOW,
    });
    return decision.shouldRotate;
  }

  /**
   * Core rotation — mint a new Claude Code backing session id, persist,
   * emit an info message, and schedule the task-anchor seed for the next
   * send. Does NOT touch our scrollback or memory — those stay intact.
   *
   * Kept a stateless single step: all the fiddly continuity (seed prompt,
   * recall advertising) happens when the NEXT send fires with `#justRotated`.
   */
  async #rotate(sender: AuthContext, reason: "auto" | "manual"): Promise<void> {
    const previousBackingId = this.#claudeCodeSessionId;
    const newBackingId = randomUUID();
    const now = Date.now();

    // Capture the last user turn from memory as the task anchor. If we
    // can't find one (e.g. memory disabled), fall back to a generic prompt.
    this.#lastUserTurnBeforeRotate = this.#captureLastUserTurn();

    // Tear down the current streamInput loop before minting the new backing
    // id. Without this we'd leave a zombie consumer task subscribed to the
    // old backing session's stream; the next send() starts a fresh loop
    // against the new id.
    await this.#teardownQueryLoop();

    // Update in-memory state first so subsequent broadcasts see the new values.
    this.#claudeCodeSessionId = newBackingId;
    this.#rotationCount += 1;
    this.#lastRotatedAt = now;
    this.#justRotated = true;
    // CRITICAL: reset hasQueried so the SDK creates a fresh session rather
    // than trying to resume an id that has no persisted history.
    this.#hasQueried = false;

    // Persist + audit.
    try {
      this.#store.setClaudeCodeSessionId(this.id, newBackingId, 1, now);
    } catch (err) {
      console.error(
        `[codeoid/rotate] failed to persist rotation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.#store.audit(
      sender.sub,
      "session.rotate",
      this.id,
      `reason=${reason} prev=${previousBackingId} new=${newBackingId}`,
    );

    const ctxBefore = this.#usage.lastTurnInputTokens ?? 0;
    const pctBefore = Math.round((ctxBefore / Session.CONTEXT_WINDOW) * 100);

    const infoMsg = this.#makeMessage(
      "info",
      `🔄 Context rotated (${reason}) — prior context was ${formatTokenCount(ctxBefore)} (${pctBefore}% of window). Memory preserved; call recall() for prior detail. Rotations: ${this.#rotationCount}.`,
      SYSTEM_IDENTITY,
      undefined,
      undefined,
      {
        event: "session.rotate",
        reason,
        rotation_count: this.#rotationCount,
        prev_backing_id: previousBackingId,
        new_backing_id: newBackingId,
        ctx_before_tokens: ctxBefore,
      },
    );
    this.#persistAndBuffer(infoMsg);
    this.#broadcastRaw(infoMsg);
    this.#broadcastInfoUpdate();
  }

  /**
   * Pull the most recent user_turn summary from memory so the new session
   * knows what the user was asking. Graceful fallback when memory is off.
   */
  #captureLastUserTurn(): string | null {
    const store = this.#memory?.store;
    if (!store) return null;
    try {
      const recent = store.listRecent(this.#workspaceId, 40);
      for (const ep of recent) {
        if (ep.sessionId === this.id && ep.kind === "user_turn") {
          return ep.content || ep.summary;
        }
      }
    } catch {
      /* graceful — fall through */
    }
    return null;
  }

  /**
   * Build the rotation-seed prompt. Strategy B (task-anchor): NO
   * summarization. Tell Claude the context reset happened, what the user
   * was working on, and how to fetch prior detail on demand.
   */
  #buildRotationSeed(_incoming: string): string {
    const lastTurn = this.#lastUserTurnBeforeRotate;
    const parts: string[] = [];
    parts.push("<rotation_context>");
    parts.push(
      "Codeoid just rotated this session's backing Claude Code context to stay below the compaction ceiling. This is a CONTINUATION, not a new session.",
    );
    parts.push("");
    parts.push(
      `Workspace: ${this.workdir}. Rotation #${this.#rotationCount} of this session (\"${this.name}\").`,
    );
    parts.push("");
    parts.push("Prior turns are preserved verbatim in codeoid memory. Retrieve on demand:");
    parts.push("  - `recall(query)`       — semantic search across all prior episodes");
    parts.push("  - `recall_file(path)`   — most recent prior Read of a specific file");
    parts.push("  - `timeline(limit?)`    — chronological recent activity");
    parts.push(
      "The workspace index in your system prompt already advertises what topics + files are in memory.",
    );
    parts.push("");
    if (lastTurn) {
      parts.push("Most recent user turn before the rotation:");
      parts.push("---");
      parts.push(lastTurn.length > 2000 ? lastTurn.slice(0, 2000) + "\n…" : lastTurn);
      parts.push("---");
    } else {
      parts.push("No prior user turn recorded (memory disabled). Rely on the user's next message.");
    }
    parts.push("</rotation_context>");
    parts.push("");
    return parts.join("\n");
  }

  /**
   * Build the system-prompt `append` block for the memory-enabled path.
   * Concatenates the stable nudge with the workspace index. The index is
   * omitted on cold sessions (no episodes yet) so the append stays identical
   * to the pre-index version — prompt cache stays warm for first turns.
   */
  #buildMemoryPromptAppend(): string {
    const index = this.#indexScheduler?.get() ?? "";
    if (!index) return MEMORY_SYSTEM_PROMPT_APPEND;
    return `${MEMORY_SYSTEM_PROMPT_APPEND}\n\n${index}`;
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

  #waitForApproval(
    approvalId: string,
  ): Promise<{ approved: boolean; updatedInput?: Record<string, unknown> }> {
    return new Promise((resolve) => {
      this.#pendingApprovals.set(approvalId, resolve);
    });
  }

  #handleAgentMessage(msg: SDKMessage): void {
    switch (msg.type) {
      case "assistant": {
        // Capture per-LLM-call usage + split by primary vs subagent.
        // `parent_tool_use_id` null → primary agent's call; non-null →
        // a subagent worker spawned via a Task tool. Anthropic's
        // BetaMessage carries per-call `usage` so we can attribute each
        // call individually rather than relying on the SDK's
        // end-of-turn SUM (which inflates ctx on subagent-heavy turns).
        const assistantMsg = msg as unknown as {
          message: {
            content: unknown;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
          parent_tool_use_id: string | null;
        };
        const perCall = assistantMsg.message?.usage;
        if (perCall) {
          const callUsage: LLMCallUsage = {
            inputTokens: perCall.input_tokens ?? 0,
            cacheReadTokens: perCall.cache_read_input_tokens ?? 0,
            cacheCreationTokens: perCall.cache_creation_input_tokens ?? 0,
            outputTokens: perCall.output_tokens ?? 0,
          };
          if (assistantMsg.parent_tool_use_id === null) {
            this.#primaryTurnCalls.push(callUsage);
          } else {
            this.#subagentTurnCalls.push(callUsage);
          }
        }

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
            // Multi-call turns (primary agent + subagents + retries) can
            // interleave their own thinking streams. Our slot is
            // singular — finalize the previous in-flight block BEFORE
            // starting a new one, otherwise the old messageId orphans in
            // the TUI's live region with a spinning cursor forever.
            this.#finalizeActiveThinking();
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
        // Also finalize any thinking block that never got its
        // content_block_stop (happens when the turn ends mid-reasoning
        // or the API abbreviates the stream). Without this, the TUI's
        // live region keeps spinning on a thinking message that the
        // model won't finish emitting.
        this.#finalizeActiveThinking();
        this.#recordTurnFromResult(msg);
        // Turn complete. In streamInput mode the query() doesn't end — it
        // blocks waiting for more input. If nothing's queued and no
        // approvals are waiting, we're genuinely idle. If there's more in
        // the queue, Claude picks it up next and status stays working.
        const moreQueued = (this.#inputQueue?.size ?? 0) > 0;
        const awaitingApproval = this.#pendingApprovals.size > 0;
        if (!moreQueued && !awaitingApproval && this.#status === "working") {
          this.#setStatus("idle");
        }
        // Broadcast regardless of status change — queue depth may have
        // decayed (SDK consumed a message) and StatusBar needs to update.
        this.#broadcastInfoUpdate();
        break;
      }

      case "system": {
        const subtype = (msg as { subtype?: string }).subtype;
        if (subtype === "init") {
          // Capture per-turn MCP state. The SDK reports each configured
          // server's connection status plus the flat list of tools it
          // ended up exposing. Bucket the tools by server name (from the
          // `mcp__<server>__<tool>` prefix) so the drawer can show
          // "highflame-platform: connected · 12 tools" with a tool list
          // expandable underneath.
          const init = msg as {
            mcp_servers?: { name: string; status: string }[];
            tools?: string[];
          };
          this.#sdkMcpStatus.clear();
          this.#sdkMcpTools.clear();
          for (const s of init.mcp_servers ?? []) {
            this.#sdkMcpStatus.set(s.name, s.status);
            this.#sdkMcpTools.set(s.name, []);
          }
          for (const t of init.tools ?? []) {
            if (!t.startsWith("mcp__")) continue;
            const rest = t.slice("mcp__".length);
            const sep = rest.indexOf("__");
            if (sep <= 0) continue;
            const server = rest.slice(0, sep);
            const bucket = this.#sdkMcpTools.get(server) ?? [];
            bucket.push(t);
            this.#sdkMcpTools.set(server, bucket);
          }
          break;
        }
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
        // NOTE: we used to emit a synthetic `thinking: "Thinking..."`
        // message here to visually signal "Claude is deciding next step".
        // That's been removed — it created orphan live-region messages
        // that never finalized (each had a fresh messageId with no
        // content_block_stop partner). Real streaming thinking via
        // `content_block_start` now handles this case, and the StatusBar's
        // `working` state + WorkingIndicator cover the gap otherwise.
        void closedAny;
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

  /**
   * Finalize the active assistant stream. When the model gets cut off
   * mid-reply (interrupt, abort, error, turn boundary reached without a
   * natural end), we need to flip the TUI's live-region entry into a
   * committed scrollback row — otherwise the spinner on the streaming
   * cursor never retires.
   *
   * If there's meaningful content already, re-broadcast it so the store
   * treats it as committed (store rule: same messageId + non-empty content
   * → move live → committed). If there's no content, just drop it — an
   * empty assistant row would be noise.
   */
  #flushActiveAssistant(): void {
    if (!this.#activeAssistantMsg) return;
    const m = this.#activeAssistantMsg;
    this.#activeAssistantMsg = null;
    // Rebroadcast ALWAYS — even with empty content. The TUI's store
    // looks for "same messageId with content" to move a live-region
    // entry to committed; an empty rebroadcast wouldn't trigger that,
    // leaving the spinner stuck. Use a placeholder so commit fires.
    if (!m.content || m.content.length === 0) {
      m.content = "(no output)";
    }
    this.#persistAndBuffer(m);
    this.#broadcastRaw(m);
  }

  /**
   * Finalize the active thinking stream. Same shape as
   * #flushActiveAssistant — always rebroadcast with non-empty content so
   * the TUI's "same msgId + content → committed" rule fires and the
   * live-region spinner retires. Prevents stuck `Thinking…` stacks when
   * multi-call turns overlap or turns end mid-reasoning.
   */
  #finalizeActiveThinking(): void {
    if (!this.#activeThinkingMsg) return;
    const m = this.#activeThinkingMsg;
    this.#activeThinkingMsg = null;
    this.#activeThinkingIndex = null;
    if (!m.content || m.content.length === 0) {
      m.content = "(reasoning elided)";
    }
    this.#persistAndBuffer(m);
    this.#broadcastRaw(m);
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
      accountId: this.accountId,
      projectId: this.projectId,
    }).catch(() => {});

    this.#broadcastRaw({
      type: "session.status_change",
      sessionId: this.id,
      status,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Compact token-count formatter for info messages — same rules as StatusBar
 * but duplicated here because daemon code avoids importing from the TUI
 * layer. 1234 → "1.2k", 250_000 → "250k", 1_500_000 → "1.5M".
 */
function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 10_000) return (n / 1_000).toFixed(1) + "k";
  if (n < 1_000_000) return Math.round(n / 1_000) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
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

/**
 * Per-tool whitelist for the `updatedInput` patch a client may send
 * with `session.approve`.
 *
 * The shallow-merge inside `canUseTool` would otherwise let any
 * client field land in the SDK's tool input — including overriding
 * the very fields the user just inspected and approved. We allow
 * patches only for tools where the user's response IS a form input
 * (AskUserQuestion), and even then restrict the keys.
 *
 * Returns `undefined` when the patch should be ignored entirely
 * (binary-approve tools, or empty input). Returns the sanitized
 * subset of fields the tool legitimately needs from approval.
 */
function sanitizeApprovalPatch(
  toolName: string,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!patch || typeof patch !== "object") return undefined;
  if (toolName === "AskUserQuestion" || toolName === "ask_user_question") {
    const answers = (patch as { answers?: unknown }).answers;
    if (!answers || typeof answers !== "object") return undefined;
    // The SDK's AskUserQuestion expects `answers: Record<string,string>`.
    // Drop anything that doesn't fit the shape silently — the tool's
    // input schema will validate the rest.
    const clean: Record<string, string> = {};
    for (const [q, a] of Object.entries(answers as Record<string, unknown>)) {
      if (typeof a === "string") clean[q] = a;
    }
    return Object.keys(clean).length > 0 ? { answers: clean } : undefined;
  }
  // Every other tool: no client-side patch is meaningful at approval
  // time. The user reviewed the original input; that's what runs.
  return undefined;
}
