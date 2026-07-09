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

import { CanonicalHistoryAccumulator } from "./providers/canonical.js";
import { CONDUCTOR_SYSTEM_PROMPT_APPEND, isFleetSendTool } from "./fleet.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  type ProviderEvent,
  type NormalizedTurnResult,
  type TurnRun,
  type ToolApprovalFn,
  type SessionProvider,
  type UiRequest,
  type UiResponse,
  isSubagentEvent,
} from "./providers/interface.js";
import { createDefaultProviderRegistry, type ProviderRegistry } from "./providers/registry.js";
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
  SessionUiRequestMsg,
  SessionUiResolvedMsg,
  MessageIdentity,
  ContentPart,
  ProviderCommand,
  ToolState,
} from "../protocol/types.js";
import { authToIdentity, CAPABILITIES, isActiveStatus, SYSTEM_IDENTITY } from "../protocol/types.js";
import type { Store } from "./store.js";
import type { AgentIdentityManager } from "./agent-identity.js";
import { ScrollbackBuffer } from "./scrollback.js";
import { reconcileResumedMessage } from "./resume-reconcile.js";
import type { TranscriptStore } from "./transcript.js";
import { contextWindowForModel } from "./context-windows.js";
import {
  EpisodeChunker,
  IndexScheduler,
  workspaceIdFromPath,
  type MemoryEngine,
} from "./memory/index.js";
import type { Attachment } from "../protocol/types.js";
import { resolveAttachments } from "./attachments.js";
import type { CodeoidConfig } from "../config.js";
import type { CompressionRegistry } from "./compress/index.js";
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

/**
 * Trailing-debounce window for persisting ACTIVE status flips (thinking ↔
 * tool_running — several per tool call). Terminal states bypass it; this only
 * bounds how stale a crashed daemon's view of an in-flight turn can be.
 */
const STATUS_PERSIST_DEBOUNCE_MS = 500;

/**
 * Max serialized message payload per scrollback.replay frame (#84). Kept well
 * under the server's 16 MB WS outbound backpressure limit (server.ts) so a
 * single chunk — plus the frame envelope and any concurrent traffic — never
 * trips closeOnBackpressureLimit. Scrollback whose total fits one chunk is
 * still replayed as a single legacy frame; only larger sessions are chunked.
 */
const REPLAY_CHUNK_BYTES = 4 * 1024 * 1024;

/** A connected client that can receive messages from this session. */
export interface AttachedClient {
  id: string;
  auth: AuthContext;
  send(msg: DaemonMessage): void;
  /**
   * Optional backpressure signal: resolves once the client's outbound buffer
   * has drained enough to accept more data. Used to pace a chunked scrollback
   * replay (#84) so chunks don't accumulate past the WS backpressure limit and
   * force-close the socket. Transports without backpressure awareness
   * (in-memory test clients, Telegram) omit it — callers treat absence as
   * "always ready" (`await client.flush?.()` is a no-op).
   */
  flush?(): Promise<void>;
  /**
   * Capability ids the client declared on its auth frame. Capability-gated
   * frames (`session.ui_request`) are only sent to clients that declared the
   * matching capability. Absent = legacy client (no capabilities).
   */
  capabilities?: readonly string[];
}

export interface SessionCreateOptions {
  name: string;
  workdir: string;
  auth: AuthContext;
  store: Store;
  transcriptStore: TranscriptStore;
  identityManager?: AgentIdentityManager;
  existingId?: string;
  /**
   * Called once per session with the live model catalog the backend
   * supports (e.g. the Claude Code SDK's `supportedModels()`), tagged with
   * the reporting provider's id so the manager can cache catalogs
   * per-provider — codeoid is provider-agnostic and each backend serves a
   * different model list. The manager caches it daemon-wide so `/model`
   * validation + the picker use the real list.
   */
  onModels?: (
    providerId: string,
    models: ReadonlyArray<{ value: string; displayName: string; description?: string }>,
  ) => void;
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
  /**
   * Session role. "conductor" = the per-tenant fleet supervisor: it gets the
   * conductor system prompt and the codeoid_fleet MCP server (when `fleet`
   * is provided). "worker" = a disposable dispatch-spawned worker. Shown in
   * SessionInfo.role for clients.
   */
  role?: "conductor" | "worker";
  /**
   * Provider id backing this session ("claude" | "gemini" | "openai").
   * Absent = claude. Every session carries its own selection so any session
   * — the conductor included — can run on a different backend (e.g. an
   * open-weight provider once one is registered).
   */
  providerId?: string;
  /**
   * Pre-built codeoid_fleet MCP server (conductor sessions only). Built by
   * the SessionManager because its tools close over the manager's tenant-
   * scoped session view; the Session just hands it to the provider.
   */
  fleet?: McpSdkServerConfigWithInstance;
  /**
   * Model default that outranks config.session.defaultModel for THIS
   * session (still loses to a persisted per-session choice). Used by the
   * conductor's config.conductor.model override.
   */
  defaultModel?: string;
  /**
   * Observe every status transition of this session. The dispatcher uses
   * this to detect a worker's turn completing (→ idle/error) or wedging
   * (→ waiting_approval) without polling. Called AFTER the transition is
   * applied; exceptions are swallowed (observability must not break turns).
   */
  onStatusChange?: (sessionId: string, status: SessionStatus) => void;
  /**
   * Initial execution mode + autonomous tool budget. Spawned workers start
   * "autonomous" with a bounded budget so they can work unattended; when the
   * budget exhausts, the mode reverts to guarded and the session waits for
   * approval — which the dispatcher detects as a wedge.
   */
  initialMode?: { mode: SessionMode; maxTurns?: number };
  /**
   * Shape of a dispatch-spawned worker ("ship" | "scout"). Selects the
   * shape-capped LEAF identity profile (registerWorker) instead of the
   * standard session-agent registration: scouts hold no tools:write, and no
   * worker ever holds session:* — a worker cannot see or direct the fleet.
   */
  workerShape?: "ship" | "scout";
  /**
   * The daemon's provider registry. Built once at startup by the
   * SessionManager and shared across sessions; when absent (unit tests
   * constructing Session directly) a default registry is built on the fly.
   */
  providers?: ProviderRegistry;
  /**
   * Provider override for testing. When present, replaces the registry
   * lookup so integration tests run without the Claude Agent SDK subprocess.
   * Name prefix signals this is test-only infrastructure — do not use in production.
   */
  _testProvider?: SessionProvider;
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
  /** "conductor" = fleet supervisor; "worker" = dispatch-spawned; undefined = normal. */
  readonly role?: "conductor" | "worker";
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
  /** Trailing-debounce timer coalescing persistence of ACTIVE status flips
   * (thinking ↔ tool_running). See #setStatus. */
  #statusPersistTimer: ReturnType<typeof setTimeout> | null = null;
  #clients = new Map<string, AttachedClient>();
  #store: Store;
  #transcriptStore: TranscriptStore;
  #identityManager?: AgentIdentityManager;
  #agentIdentity: MessageIdentity;
  #scrollback = new ScrollbackBuffer();
  /**
   * Identity of this Session instance's replay buffer (`replay.resume`).
   * A client cursor (`sinceSeq`) is only valid against the buffer that
   * issued it; regenerating the key on every construction (incl. restart
   * resume, where the buffer is rebuilt from the transcript with fresh
   * seqs) forces stale cursors down the full-snapshot path.
   */
  #resumeKey = randomUUID();
  /**
   * Recently-processed `session.send.clientMsgId`s (`send.idempotency`) —
   * insertion-ordered for FIFO eviction. Bounds the window in which an
   * ambiguous-delivery retry is recognized as a duplicate; 256 comfortably
   * outlives any client resend queue while staying O(1) per send.
   */
  #seenClientMsgIds = new Set<string>();
  #provider!: SessionProvider;
  #activeRun: TurnRun | null = null;
  #eventConsumerTask: Promise<void> | null = null;
  // Wall-clock ms of the most recent provider event for the active run. The
  // stall watchdog in #consumeEvents and the liveness guard in #sendInner read
  // this to detect a turn whose event stream has gone silent (hung tool / dead
  // subprocess) so the session can self-recover instead of wedging forever.
  #lastEventAt = 0;
  #accumulator = new CanonicalHistoryAccumulator();
  // Tracks the sender of the most recently started turn. The onRecoveryNeeded
  // closure reads this instead of closing over the original send()'s sender,
  // which may have been overwritten by a subsequent send() before recovery fires.
  #currentSender: AuthContext | null = null;
  #approvalIdToMessageId = new Map<string, string>();
  // Pending ZeroID registration promises keyed by subagent id. tool_start
  // awaits this fence before attributing identity so the real WIMSE URI is
  // used even for a subagent's very first tool call.
  #subagentRegistrations = new Map<string, Promise<void>>();
  #seq = 0;
  #memory?: MemoryEngine;
  #chunker?: EpisodeChunker;
  // Counts mid-turn messages in flight. When the SDK interrupts the current
  // turn to process a pushMidTurn() injection, it emits a turn_done for the
  // aborted partial turn BEFORE the continuation turn starts. This counter lets
  // #consumeEvents absorb those intermediate turn_dones and keep looping instead
  // of exiting the consumer and leaving the continuation turn without a reader.
  #pendingMidTurnCount = 0;
  #indexScheduler?: IndexScheduler;
  #workspaceId: string;

  #config?: CodeoidConfig;

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
  // When true, the next send() injects the task-anchor seed prefix so the
  // fresh context knows it's a continuation and memory recall is the path
  // to prior detail. Cleared after the first send post-rotation.
  #justRotated = false;
  // In-memory rotation counter (Store has the persistent one). Used for the
  // "X total rotations" display without hitting SQLite on every broadcast.
  #rotationCount = 0;
  #lastRotatedAt: number | null = null;
  /**
   * Turns elapsed since the last rotation (or since session start
   * if we've never rotated). The auto-rotate min-turns guard now
   * uses THIS instead of `usage.numTurns` (which is cumulative
   * across rotations and can't gate the post-rotation thrash).
   */
  #turnsSinceLastRotation = 0;
  // Last user turn BEFORE rotation — seeded into the new session's opening
  // prompt so the agent knows what it was working on. Captured inside
  // rotate() from the most recent user_turn episode.
  #lastUserTurnBeforeRotate: string | null = null;
  // Claude's context window. The current Opus and Sonnet families share 1M;
  // we compute occupancy against this constant. Making it tunable per-session
  // was considered overkill — users rarely run sub-1M models via codeoid.
  static readonly CONTEXT_WINDOW = 1_000_000;

  // Execution mode + turn budget (autonomous mode only).
  // Default `guarded` (≈ Claude Code's default): read-only tools (Read/Grep/Glob
  // + memory) auto-approve, while Write/Edit/Bash and other mutations prompt.
  // `interactive` (prompt for everything, incl. reads) and `autonomous` (auto
  // until budget) are opt-in via /mode.
  #mode: SessionMode = "guarded";
  #onStatusChange?: (sessionId: string, status: SessionStatus) => void;
  #workerShape?: "ship" | "scout";
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
  /**
   * Decisions that arrived BEFORE canUseTool registered its resolver. The
   * event consumer broadcasts the waiting_confirmation tool message (and the
   * waiting_approval status) a beat before #waitForApproval runs, so a fast
   * client — or an automation — can approve/deny inside that window; without
   * this buffer the decision was silently dropped and the turn hung forever.
   * Keyed by approvalId; consumed (or discarded) by #waitForApproval.
   */
  #earlyApprovals = new Map<
    string,
    { approved: boolean; updatedInput?: Record<string, unknown> }
  >();

  /**
   * Pending provider-initiated dialogs (`session.ui_request`), keyed by
   * requestId. Settled by the first client `session.ui_response`, by the
   * request's own timeout, or by interrupt/destroy (as cancelled). Pending
   * requests are re-sent to newly attaching capable clients so a dialog
   * raised while nobody was watching still gets answered.
   */
  #pendingUiRequests = new Map<
    string,
    {
      msg: SessionUiRequestMsg;
      resolve: (r: UiResponse) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * Per-approval patchable-keys whitelist declared by the provider on
   * `tool_start` (form-style tools). Consumed by canUseTool's approval
   * sanitizer; cleaned up on resolution or interrupt.
   */
  #approvalPatchKeys = new Map<string, string[]>();

  // Active tool call messageIds — completed when next assistant message arrives
  #activeToolMsgIds: string[] = [];

  // SDK tool_use_id → our internal messageId — lets us correlate tool_result
  // blocks (emitted in SDKUserMessage) back to the originating tool_call message
  // so we can record the real tool output in scrollback, transcript, and memory.
  #toolUseIdToMessageId = new Map<string, string>();
  // Reverse of #toolUseIdToMessageId — needed so _applyInterruptedStateToTool
  // and the denial path can clean up both maps without a full scan.
  #messageIdToToolUseId = new Map<string, string>();
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
    this.role = opts.role;
    this.#onStatusChange = opts.onStatusChange;
    this.#workerShape = opts.workerShape;
    if (opts.initialMode) {
      this.#mode = opts.initialMode.mode;
      this.#turnsRemaining =
        opts.initialMode.mode === "autonomous" ? opts.initialMode.maxTurns : undefined;
    }
    this.createdBy = opts.auth.sub;
    this.createdAt = new Date().toISOString();
    this.accountId = opts.auth.accountId;
    this.projectId = opts.auth.projectId;
    this.#store = opts.store;
    this.#transcriptStore = opts.transcriptStore;
    this.#identityManager = opts.identityManager;
    this.#memory = opts.memory;
    this.#config = opts.config;
    // Tenant-scoped (auth carries account_id/project_id) so two accounts in
    // the same directory never share memory.
    this.#workspaceId = workspaceIdFromPath(opts.workdir, opts.auth);
    // Rotation counters — populated from Store so they survive restart.
    const stats = this.#store.getRotationStats(this.id);
    this.#rotationCount = stats.count;
    this.#lastRotatedAt = stats.lastRotatedAt;

    // Model selection — prefer persisted session choice, then a per-session
    // default (conductor's config.conductor.model), then the config default,
    // else leave null (provider default). Always resolve to full id so
    // downstream code doesn't see aliases.
    const persistedModel = this.#store.getSessionModel(this.id);
    this.#model =
      persistedModel.model ??
      resolveModelId(opts.defaultModel ?? opts.config?.session.defaultModel ?? "") ??
      null;
    this.#fallbackModel =
      persistedModel.fallbackModel ??
      resolveModelId(opts.config?.session.fallbackModel ?? "") ??
      null;

    this.#provider = opts._testProvider ?? this.#createProvider(opts);

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
        role: this.role,
        providerId: this.#provider.id,
      });
    }
  }

  /**
   * Construct the backing provider for this session from `opts.providerId`
   * via the daemon's ProviderRegistry. Every session carries its own
   * selection (the conductor takes its from config.conductor.provider), so
   * any session can run on a different backend. Unknown ids warn and fall
   * back to the registry default rather than throw — resume must survive a
   * meta written by a newer codeoid.
   */
  #createProvider(opts: SessionCreateOptions): SessionProvider {
    const registry = opts.providers ?? createDefaultProviderRegistry(opts.config);
    const factory = registry.resolve(opts.providerId, `session ${this.id}`);
    return factory.create({
      sessionId: this.id,
      // Pass the tenant-scoped workspace id in rather than have the provider
      // re-derive it (which would drop the tenant and desync the memory MCP
      // binding from where episodes are actually stored).
      workspaceId: this.#workspaceId,
      model: this.#model,
      initialBackingId: this.#store.getClaudeCodeSessionId(this.id) ?? this.id,
      store: opts.store,
      identityManager: opts.identityManager,
      memory: opts.memory,
      fleet: opts.fleet,
      config: opts.config,
      compressionRegistry: opts.compressionRegistry,
      // Tag model reports with the factory's id (known before construction),
      // so the manager caches catalogs per-provider.
      onModels: (m) => opts.onModels?.(factory.id, m),
    });
  }

  get status(): SessionStatus { return this.#status; }
  /** Id of the provider backing this session (e.g. "claude"). */
  get providerId(): string { return this.#provider.id; }
  /** Tenant-scoped memory workspace id (for fleet views / cross-session search). */
  get workspaceId(): string { return this.#workspaceId; }
  /**
   * Final text of the most recent assistant turn (null before any turn).
   * Bounded consumer beware: this is the FULL turn text — digest builders
   * must truncate. Reads the canonical history, never the provider.
   */
  get lastAssistantText(): string | null {
    for (let i = this.#accumulator.history.length - 1; i >= 0; i--) {
      const turn = this.#accumulator.history[i];
      if (turn && turn.role === "assistant" && turn.content) return turn.content;
    }
    return null;
  }
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

  attach(client: AttachedClient, resume?: { key: string; sinceSeq: number }): void {
    this.#clients.set(client.id, client);
    this.#store.audit(client.auth.sub, "session.attach", this.id);

    // Re-deliver pending provider dialogs to the newly attached client (if it
    // can render them) — a dialog raised while nobody was attached must not
    // hang until timeout. Dialogs are transcript-independent overlays, so
    // ordering relative to the scrollback replay below doesn't matter.
    if (client.capabilities?.includes(CAPABILITIES.UI_DIALOGS)) {
      for (const pending of this.#pendingUiRequests.values()) {
        client.send(pending.msg);
      }
    }

    // Incremental resume (`replay.resume`): when the client's cursor belongs
    // to THIS replay buffer (key match), replay only the entries mutated
    // after it — new messages plus older ones grown by deltas / tool-state
    // transitions — instead of the whole scrollback. Any mismatch (daemon
    // restarted and rebuilt the buffer, unknown key) falls back to the
    // authoritative full snapshot; the client resets on `mode: "snapshot"`.
    const incremental = resume !== undefined && resume.key === this.#resumeKey;

    // Replay scrollback — full SessionMessage objects, not deltas. Partition
    // by byte budget so a large session can't emit one oversized frame that
    // trips the WS backpressure limit and force-closes the client (#84).
    const chunks = (
      incremental
        ? this.#scrollback.readChunkedSince(resume.sinceSeq, REPLAY_CHUNK_BYTES)
        : this.#scrollback.readChunked(REPLAY_CHUNK_BYTES)
    ) as SessionMessage[][];
    const meta = {
      mode: incremental ? ("incremental" as const) : ("snapshot" as const),
      resumeKey: this.#resumeKey,
      maxSeq: this.#scrollback.maxSeq,
    };

    if (chunks.length === 0) {
      // Nothing to replay. A client that ASKED to resume still gets an empty
      // frame: it acks the cursor (incremental, fully caught up) or re-syncs
      // a stale key (snapshot after a daemon restart with an empty buffer).
      // Legacy clients keep the silent no-frame behaviour.
      if (resume !== undefined) {
        client.send({ type: "scrollback.replay", sessionId: this.id, messages: [], ...meta });
      }
      return;
    }

    if (chunks.length === 1) {
      // Common case: the whole replay fits one frame. Send it synchronously
      // in the single-frame shape (no chunk seq/final) — wire format is
      // unchanged for legacy clients apart from the additive resume fields.
      client.send({ type: "scrollback.replay", sessionId: this.id, messages: chunks[0]!, ...meta });
      return;
    }

    // Large replay: stream chunks oldest→newest, pacing on socket drain so
    // frames don't accumulate past the backpressure limit. Because that pacing
    // is async, live broadcasts to this client are buffered until the replay
    // finishes — otherwise a newer live message could land ahead of older
    // replayed ones. The buffering wrapper is what #broadcastRaw sees; replay
    // frames go straight to the raw client, then the buffered live messages in
    // order, then the wrapper becomes a pass-through.
    const raw = client;
    const buffer: DaemonMessage[] = [];
    let replaying = true;
    const buffered: AttachedClient = {
      id: raw.id,
      auth: raw.auth,
      send: (m) => {
        if (replaying) buffer.push(m);
        else raw.send(m);
      },
      flush: raw.flush?.bind(raw),
      capabilities: raw.capabilities,
    };
    this.#clients.set(raw.id, buffered);

    void this.#streamReplay(raw, buffered, chunks, meta).finally(() => {
      // Flush live messages that arrived during replay, in order — but only if
      // this client is still the current attachment (not detached/replaced).
      if (this.#clients.get(raw.id) === buffered) {
        for (const m of buffer) raw.send(m);
      }
      replaying = false;
      buffer.length = 0;
    });
  }

  /**
   * Stream a chunked scrollback replay to a client, waiting for the socket to
   * drain between chunks. `token` is the buffering wrapper currently registered
   * in #clients; if it's been replaced (detach / re-attach) mid-replay we stop.
   */
  async #streamReplay(
    raw: AttachedClient,
    token: AttachedClient,
    chunks: SessionMessage[][],
    meta: { mode: "snapshot" | "incremental"; resumeKey: string; maxSeq: number },
  ): Promise<void> {
    const last = chunks.length - 1;
    for (let i = 0; i <= last; i++) {
      if (this.#clients.get(raw.id) !== token) return;
      raw.send({
        type: "scrollback.replay",
        sessionId: this.id,
        messages: chunks[i]!,
        seq: i,
        final: i === last,
        ...meta,
      });
      if (i < last) await raw.flush?.();
    }
  }

  detach(clientId: string): void {
    const client = this.#clients.get(clientId);
    if (client) {
      this.#store.audit(client.auth.sub, "session.detach", this.id);
      this.#clients.delete(clientId);
    }
  }

  // ── Provider-initiated UI (dialogs) ───────────────────────────────────

  /**
   * Raise a dialog on behalf of the provider and await the user's answer.
   * Passed to providers as `TurnOpts.requestUserInput`. The promise settles
   * when the first client answers, the request times out (`timeoutMs`), or
   * the session is interrupted/destroyed — never rejects.
   */
  requestUserInput(req: UiRequest): Promise<UiResponse> {
    const requestId = randomUUID();
    const msg: SessionUiRequestMsg = {
      type: "session.ui_request",
      sessionId: this.id,
      requestId,
      method: req.method,
      title: req.title,
      ...(req.message !== undefined ? { message: req.message } : {}),
      ...(req.options !== undefined ? { options: req.options } : {}),
      ...(req.placeholder !== undefined ? { placeholder: req.placeholder } : {}),
      ...(req.prefill !== undefined ? { prefill: req.prefill } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      timestamp: new Date().toISOString(),
    };
    return new Promise<UiResponse>((resolve) => {
      const timer =
        req.timeoutMs !== undefined && req.timeoutMs > 0
          ? setTimeout(() => {
              this.#settleUiRequest(requestId, { cancelled: true }, "timeout");
            }, req.timeoutMs)
          : undefined;
      this.#pendingUiRequests.set(requestId, { msg, resolve, timer });
      this.#broadcastToCapable(CAPABILITIES.UI_DIALOGS, msg);
    });
  }

  /** Count of unanswered provider dialogs (StatusBar / watchdog signal). */
  get pendingUiRequestCount(): number {
    return this.#pendingUiRequests.size;
  }

  /**
   * Apply a client's `session.ui_response`. Returns false when the request
   * is not pending (already answered elsewhere, timed out, or unknown) so
   * the manager can answer `not_found`.
   */
  resolveUiRequestFromClient(
    requestId: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
    sender: AuthContext,
  ): boolean {
    if (!this.#pendingUiRequests.has(requestId)) return false;
    const cancelled = response.cancelled === true;
    this.#store.audit(
      sender.sub,
      "session.ui_response",
      this.id,
      `requestId=${requestId} ${cancelled ? "cancelled" : "answered"}`,
    );
    return this.#settleUiRequest(
      requestId,
      {
        ...(response.value !== undefined ? { value: response.value } : {}),
        ...(response.confirmed !== undefined ? { confirmed: response.confirmed } : {}),
        cancelled,
      },
      cancelled ? "cancelled" : "answered",
    );
  }

  /**
   * Settle one pending dialog: resolve the provider's promise, clear the
   * timeout, and broadcast `session.ui_resolved` so every client dismisses
   * its copy. Idempotent — a second settle for the same id is a no-op.
   */
  #settleUiRequest(
    requestId: string,
    response: UiResponse,
    reason: SessionUiResolvedMsg["reason"],
  ): boolean {
    const pending = this.#pendingUiRequests.get(requestId);
    if (!pending) return false;
    this.#pendingUiRequests.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(response);
    this.#broadcastToCapable(CAPABILITIES.UI_DIALOGS, {
      type: "session.ui_resolved",
      sessionId: this.id,
      requestId,
      reason,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  /** Cancel every pending dialog (interrupt / destroy). */
  #cancelAllUiRequests(reason: SessionUiResolvedMsg["reason"]): void {
    for (const requestId of [...this.#pendingUiRequests.keys()]) {
      this.#settleUiRequest(requestId, { cancelled: true }, reason);
    }
  }

  /** Broadcast a frame only to clients that declared `capability`. */
  #broadcastToCapable(capability: string, msg: DaemonMessage): void {
    for (const client of this.#clients.values()) {
      if (!client.capabilities?.includes(capability)) continue;
      try {
        client.send(msg);
      } catch {
        this.#clients.delete(client.id);
      }
    }
  }

  // ── Provider extension surface ────────────────────────────────────────

  /**
   * The provider's current slash-command catalog (`session.commands`).
   * Providers without dynamic commands (or a failing provider) yield [].
   */
  async listProviderCommands(): Promise<ProviderCommand[]> {
    if (!this.#provider.listCommands) return [];
    try {
      return await this.#provider.listCommands();
    } catch (err) {
      console.error(
        `[codeoid/session ${this.id}] listCommands failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Validate + dispatch a `session.part_action` (ButtonPart activation).
   * The button must exist on a real scrollback message with the claimed
   * action — clients cannot mint arbitrary provider calls.
   */
  async dispatchPartAction(
    messageId: string,
    action: string,
    data: Record<string, unknown> | undefined,
    sender: AuthContext,
  ): Promise<{ ok: true } | { ok: false; code: "not_found" | "invalid_request"; error: string }> {
    const msg = this.#scrollback.getMessage(messageId) as SessionMessage | undefined;
    if (!msg) {
      return { ok: false, code: "not_found", error: "Message not found" };
    }
    const button = (msg.parts ?? []).find(
      (p) => p.kind === "button" && p.action === action,
    );
    if (!button) {
      return { ok: false, code: "not_found", error: "No such action on this message" };
    }
    if (!this.#provider.handlePartAction) {
      return {
        ok: false,
        code: "invalid_request",
        error: `Provider "${this.#provider.id}" does not handle part actions`,
      };
    }
    this.#store.audit(sender.sub, "session.part_action", this.id, `action=${action}`);
    try {
      await this.#provider.handlePartAction(action, data);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        code: "invalid_request",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Agent interaction ─────────────────────────────────────────────────

  /**
   * Per-Session promise chain that serializes `send()` invocations.
   * Without it, two near-simultaneous sends both await `#rotate` /
   * `#ensureQueryLoop` and observe the same pre-rotation state —
   * both rotate, both call `query()`, two SDK subprocesses fight
   * over the same input queue. Chaining ensures the second send
   * sees the first send's full state transition.
   *
   * Different sessions still run in parallel (each Session instance
   * has its own chain).
   */
  #sendChain: Promise<void> = Promise.resolve();

  async send(
    text: string,
    sender: AuthContext,
    attachments?: readonly Attachment[],
    priority?: "now" | "next" | "later",
  ): Promise<void> {
    // Funnel through the chain. The next send awaits the previous
    // send's full settle (success or thrown). Errors propagate to the
    // caller of THIS send only — the chain itself absorbs them so a
    // failed send doesn't poison subsequent sends.
    const next = this.#sendChain
      .catch(() => undefined)
      .then(() => this.#sendInner(text, sender, attachments, priority));
    this.#sendChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Surface a send-path failure as a visible system message instead of
   * swallowing it. Called by SessionManager#send when the async send()
   * rejects. By the time send() can throw, the user's message is already
   * persisted (see #sendInner), so this tells the user it failed and that
   * their text was kept — never a silent drop with a false "ok".
   */
  reportSendFailure(err: unknown): void {
    const emsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[codeoid/session ${this.id}] send failed after ack: ${
        err instanceof Error ? (err.stack ?? emsg) : emsg
      }`,
    );
    const msg = this.#makeMessage(
      "system",
      `⚠️ Your message couldn't be processed (${emsg}). It was saved — send again to retry.`,
      SYSTEM_IDENTITY,
      undefined,
      undefined,
      { event: "send_failed", errorCode: "send_failed" },
    );
    this.#persistAndBuffer(msg);
    this.#broadcastRaw(msg);
    if (this.#status !== "error") this.#setStatus("idle");
  }

  async #sendInner(
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
    const wasWorking =
      this.#status === "thinking" || this.#status === "tool_running";

    // PERSIST THE USER MESSAGE FIRST — before any fallible work (attachment
    // resolution, rotation, ensureQueryLoop). Whatever fails downstream, what
    // the user typed is already on disk (transcript) and in scrollback, so it
    // can never be silently lost. Resolve attachments up front for the
    // breadcrumb, but guard it: a resolver failure must not drop the message.
    let resolved: ReturnType<typeof resolveAttachments>["resolved"] = [];
    let promptPrefix = "";
    try {
      // Merge pinned + per-turn attachments (dedup by path, per-turn wins).
      const allAttachments = this.#buildEffectiveAttachments(attachments);
      ({ resolved, promptPrefix } = resolveAttachments(allAttachments, {
        workdir: this.workdir,
      }));
    } catch (err) {
      console.error(
        `[codeoid/session ${this.id}] attachment resolution failed (continuing without): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // The user-visible message carries the bare text plus a metadata
    // breadcrumb. Emitted immediately so every frontend sees the user's
    // message before Claude starts responding (even when queued mid-turn).
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

    // ── From here on, the message is safe. Any throw surfaces as a visible
    //    error (see SessionManager#send -> reportSendFailure), never a silent
    //    drop. ────────────────────────────────────────────────────────────
    //
    // Pre-send rotation check. Auto-rotate if enabled AND above the configured
    // threshold AND past the min-turns safety window. Hard-rotation fires even
    // when disabled. Runs before queueing so the seed prompt feeds the NEW
    // query, not the stale one.
    if (this.#shouldRotate()) {
      await this.#rotate(sender, "auto");
    }

    // Rotation seed: on the first send after a rotation, prepend a
    // task-anchor block so the fresh Claude Code session knows what the
    // user was working on and how to fetch prior detail via memory.recall.
    const rotationSeed = this.#justRotated ? this.#buildRotationSeed(text) : "";
    if (this.#justRotated) this.#justRotated = false;
    const effectivePrompt = `${rotationSeed}${promptPrefix}${text}`;

    // Resolve priority. Explicit caller value wins. Otherwise: `now` when
    // the session was already mid-turn (VSCode-style responsiveness);
    // `later` for the idle case.
    const effectivePriority: "now" | "next" | "later" =
      priority ?? (wasWorking ? "now" : "later");

    // Liveness guard: a session can look "working" while its run is actually
    // wedged (provider stream went silent on a hung tool / dead subprocess).
    // Queuing a mid-turn push into a dead run silently swallows the message and
    // the user never gets a reply. If the active run has produced no event for
    // longer than the stall window, recover it now and start a fresh turn
    // instead of trusting #activeRun. Skipped while the watchdog is paused
    // (tool executing / approval pending) — sending "how's it going?" into a
    // long-running tool must queue mid-turn, not kill the run.
    const stallMs = this.#config?.session.turnStallTimeoutMs ?? 300_000;
    if (
      wasWorking &&
      this.#activeRun &&
      stallMs > 0 &&
      this.#lastEventAt > 0 &&
      Date.now() - this.#lastEventAt > stallMs &&
      !this.#watchdogPaused()
    ) {
      console.error(
        `[codeoid/session ${this.id}] send arrived on a stalled run (${Date.now() - this.#lastEventAt}ms since last event); recovering before starting a fresh turn`,
      );
      await this.#recoverStalledRun(this.#activeRun, stallMs, {
        continuingCurrentSend: true,
      });
      // Fall through to the normal (idle) turn-start path below.
    }

    // For keep-warm mid-turn pushes (ClaudeProvider), inject directly into the live run.
    if (wasWorking && this.#activeRun?.pushMidTurn) {
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
      this.#accumulator.pushUserTurn(effectivePrompt);
      this.#pendingMidTurnCount++;
      this.#activeRun.pushMidTurn(effectivePrompt, effectivePriority ?? "now");
      this.#setStatus("thinking");
      this.#broadcastInfoUpdate();
      return;
    }

    await this.#ensureAgentIdentity(sender);
    this.#currentSender = sender;

    // Wire recovery handler. Uses #currentSender rather than closing over `sender`
    // so that if a subsequent send() updates the active sender before recovery fires,
    // audit events are attributed to the turn that actually triggered recovery.
    this.#provider.onRecoveryNeeded = (content: string) => {
      const recoverySender = this.#currentSender ?? sender;
      this.#sendChain = this.#sendChain.then(async () => {
        // Reset to a fresh backing session for recovery.
        const newBackingId = randomUUID();
        this.#provider.resetToNewSession(newBackingId);
        try {
          this.#store.setClaudeCodeSessionId(this.id, newBackingId);
        } catch (e) {
          console.error(
            `[codeoid/session ${this.id}] failed to persist recovered backing id: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        // Do NOT pushUserTurn(content) here — the original send() already
        // pushed it before runTurn(). Pushing again duplicates the user turn.
        const recoveryRun = this.#provider.runTurn({
          history: this.#accumulator.history,
          userMessage: content,
          model: this.#model ?? undefined,
          fallbackModel: this.#fallbackModel ?? undefined,
          workdir: this.workdir,
          systemPromptAppend: this.#buildPromptAppend(),
          canUseTool: this.#makeCanUseToolFn(recoverySender),
          requestUserInput: (req) => this.requestUserInput(req),
          sender: recoverySender,
        });
        this.#activeRun = recoveryRun;
        this.#eventConsumerTask = this.#consumeEvents(recoveryRun, recoverySender);
        this.#setStatus("thinking");
      });
    };

    this.#accumulator.pushUserTurn(effectivePrompt);
    const run = this.#provider.runTurn({
      history: this.#accumulator.history,
      userMessage: effectivePrompt,
      model: this.#model ?? undefined,
      fallbackModel: this.#fallbackModel ?? undefined,
      workdir: this.workdir,
      systemPromptAppend: this.#buildPromptAppend(),
      canUseTool: this.#makeCanUseToolFn(sender),
      requestUserInput: (req) => this.requestUserInput(req),
      sender,
    });
    this.#activeRun = run;
    this.#eventConsumerTask = this.#consumeEvents(run, sender);
    this.#setStatus("thinking");
    // Broadcast info_update so StatusBar reflects the new queue depth.
    this.#broadcastInfoUpdate();
  }

  async #teardownProvider(): Promise<void> {
    // Capture before nulling: provider.teardown() may trigger onRecoveryNeeded,
    // which installs a new #eventConsumerTask. Awaiting the snapshot drains
    // the old consumer; we intentionally don't null the field again afterward
    // so the recovery task is not orphaned.
    const taskToAwait = this.#eventConsumerTask;
    const hadActiveRun = this.#activeRun !== null;
    this.#activeRun = null;
    this.#eventConsumerTask = null;
    await this.#provider.teardown();
    try { await taskToAwait; } catch { /* consumer handles its own errors */ }
    // The drained consumer's `finally` skips its own idle reset here: we nulled
    // #activeRun above, so its run-ownership guard (`#activeRun === run`) is
    // false. Without this, tearing a provider down mid-turn (setModel / rotate)
    // strands #status at thinking/tool_running forever — no `status_change:
    // idle` is ever broadcast and clients loop the "thinking…" indicator. Emit
    // the transition ourselves, but only if nothing took over the run in the
    // meantime (provider.teardown() can trigger onRecoveryNeeded, which installs
    // a fresh run we must not clobber) and we aren't in a terminal error state.
    if (hadActiveRun && this.#activeRun === null && this.#status !== "error") {
      this.#setStatus("idle");
    }
  }

  /**
   * Interrupt the current turn — the Claude-Code "Esc" semantics.
   *
   * KEEP-WARM: we use the SDK's `Query.interrupt()`, which stops the
   * in-flight turn (LLM call + running tool, including reaping the tool's
   * child process) WITHOUT ending the streaming query. The `for await`
   * consumer loop and the backing Claude Code session stay alive, so the
   * next `send()` just pushes into the existing queue — no re-`query()`,
   * no `resume`, no chance of the resume-handshake wedge that strands a
   * session after an interrupt.
   *
   * Fallback: if there's no live query, or `interrupt()` rejects, we hard
   * `abort()` the controller (the old behavior) so the turn still stops —
   * correctness over warmth. Idempotent: a second interrupt on an
   * already-idle session is a harmless no-op.
   */
  async interrupt(sender: AuthContext): Promise<void> {
    this.#store.audit(sender.sub, "session.interrupt", this.id);
    this.#pendingMidTurnCount = 0; // cancel pending mid-turn continuations
    // Finalize any in-flight streaming messages RIGHT NOW so the UI's live
    // region stops spinning on content the model won't finish emitting,
    // before we even await the SDK — instant feedback.
    this.#flushActiveAssistant();
    this.#finalizeActiveThinking();
    // Unblock any pending tool approvals so canUseTool awaiters don't leak.
    for (const resolve of this.#pendingApprovals.values()) {
      resolve({ approved: false });
    }
    this.#pendingApprovals.clear();
    this.#earlyApprovals.clear();
    this.#approvalPatchKeys.clear();
    // Same for provider dialogs — an interrupted turn must not leave the
    // provider awaiting an answer that can no longer arrive.
    this.#cancelAllUiRequests("interrupted");

    const infoMsg = this.#makeMessage(
      "info",
      `⏹ Interrupted by ${sender.sub}. Send a new message to continue.`,
      SYSTEM_IDENTITY,
      undefined,
      undefined,
      { event: "session.interrupt", sub: sender.sub },
    );
    this.#persistAndBuffer(infoMsg);
    this.#broadcastRaw(infoMsg);

    const run = this.#activeRun;
    if (run) {
      try {
        await run.interrupt();
        if (this.#status !== "error") this.#setStatus("idle");
        return;
      } catch {
        // fall through to hard abort
      }
    }
    if (this.#status !== "error") this.#setStatus("idle");
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

      // Race window: the tool message (and waiting_approval status) are
      // broadcast by the event consumer BEFORE canUseTool registers its
      // resolver. #approvalIdToMessageId proves this approvalId belongs to
      // the live turn — buffer the decision for #waitForApproval to consume
      // instead of dropping it (which hung the turn forever).
      if (this.#approvalIdToMessageId.has(approvalId)) {
        this.#earlyApprovals.set(approvalId, { approved, updatedInput });
        this.#store.audit(
          sender.sub,
          approved ? "session.approve" : "session.deny",
          this.id,
          `approvalId=${approvalId} (early)`,
        );
        return;
      }

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
    // Cancel any pending debounced status persist — a write firing after the
    // deletes below would resurrect the meta file for a destroyed session,
    // which restart resume would then pick up as a ghost.
    if (this.#statusPersistTimer) {
      clearTimeout(this.#statusPersistTimer);
      this.#statusPersistTimer = null;
    }
    this.#store.audit(sender.sub, "session.destroy", this.id);
    // Tear down the streamInput loop cleanly before wiping storage so we
    // don't leave a zombie SDK subprocess alive holding the transcript file.
    await this.#teardownProvider();
    for (const resolve of this.#pendingApprovals.values()) {
      resolve({ approved: false });
    }
    this.#pendingApprovals.clear();
    this.#earlyApprovals.clear();
    this.#approvalPatchKeys.clear();
    this.#cancelAllUiRequests("cancelled");
    this.#clients.clear();
    await this.#identityManager?.deactivateSessionAgent(this.id);
    this.#store.deleteSession(this.id);
    await this.#transcriptStore.delete(this.id);
  }

  restoreScrollback(
    messages: DaemonMessage[],
    nextSeq?: number,
    sizeHints?: ReadonlyArray<number | undefined>,
  ): void {
    // Seed the transcript sequence counter past the loaded log's tail.
    // Without this, post-restart appends restart at seq 0 — harmless for
    // loadTranscript (which orders by file position) but it makes seq
    // unusable as a monotonic replay cursor.
    if (nextSeq !== undefined && nextSeq > this.#seq) {
      this.#seq = nextSeq;
    }
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.type !== "session.message") continue;
      // Reconcile tool calls frozen in a non-terminal phase (streaming /
      // waiting_confirmation / executing) by a daemon restart. The in-memory
      // state that would advance them — the live SDK turn and
      // `#pendingApprovals` — is gone, so without this clients replay them as
      // forever-"running" (and the ApprovalBar resurrects ghost prompts the
      // user can't answer). Rewrite to `cancelled` / `interrupted`.
      // The size hint (the transcript line's byte length, when the caller
      // loaded from disk) spares scrollback a re-serialization per message.
      this.#scrollback.push(reconcileResumedMessage(msg), sizeHints?.[i]);
    }
    // A session with prior scrollback already exists in Claude Code's own
    // persistent session store — next send() must use `resume`, not re-create.
    if (messages.length > 0) {
      this.#provider.setHasQueried(true);
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
      role: this.role,
      providerId: this.#provider.id,
      mode: this.#mode,
      turnsRemaining: this.#turnsRemaining,
      pinnedFiles: [...this.#pinnedFiles],
      agentUri: this.#agentIdentity.sub,
      subagents: this.subagentSnapshot,
      usage: { ...this.#usage },
      rotation: {
        count: this.#rotationCount,
        lastRotatedAt: this.#lastRotatedAt,
        claudeCodeSessionId: this.#provider.backingSessionId,
      },
      queuedMessages: this.#provider.queuedMessages,
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
  #recordTurnFromResult(result: NormalizedTurnResult): void {
    // Anthropic semantics: input_tokens = NEW input only (not cache).
    // Total context = input + cache_read + cache_creation.
    const input = result.inputTokens;
    const output = result.outputTokens;
    const cacheRead = result.cacheReadTokens;
    const cacheCreate = result.cacheCreationTokens;
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
      this.#usage.totalCostUsd += result.totalCostUsd;
      this.#usage.durationMs += result.durationMs;
      this.#usage.numTurns += 1;
      this.#turnsSinceLastRotation += 1;
      // PEAK tracks primary-only — ignore subagent contributions so a
      // subagent-heavy turn doesn't poison the bloat canary.
      this.#usage.peakInputTokens = Math.max(
        this.#usage.peakInputTokens ?? 0,
        primaryCtx,
      );
      this.#usage.lastTurnInputTokens = primaryCtx;
      this.#usage.lastTurnOutputTokens = output;
      this.#usage.lastTurnCostUsd = result.totalCostUsd;
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
      totalCostUsd: result.totalCostUsd,
      durationMs: result.durationMs,
      stopReason: result.stopReason,
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
    await this.#teardownProvider();

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
      // Pass turns-since-last-rotation, not cumulative numTurns —
      // the min-turns guard exists to avoid rotating right after
      // we just rotated. Cumulative numTurns saturates past the
      // threshold and the guard becomes a no-op forever.
      numTurns: this.#turnsSinceLastRotation,
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
    const previousBackingId = this.#provider.backingSessionId;
    const newBackingId = randomUUID();
    const now = Date.now();

    // Capture the last user turn from memory as the task anchor. If we
    // can't find one (e.g. memory disabled), fall back to a generic prompt.
    this.#lastUserTurnBeforeRotate = this.#captureLastUserTurn();

    // Tear down the current provider loop before minting the new backing
    // id. Without this we'd leave a zombie consumer task subscribed to the
    // old backing session's stream; the next send() starts a fresh loop
    // against the new id.
    await this.#teardownProvider();

    // Update in-memory state first so subsequent broadcasts see the new values.
    this.#rotationCount += 1;
    this.#lastRotatedAt = now;
    this.#justRotated = true;
    // CRITICAL: reset the provider so it creates a fresh session rather
    // than trying to resume an id that has no persisted history.
    this.#provider.resetToNewSession(newBackingId);
    this.#accumulator.reset();
    // Reset rotation-trigger inputs so the next #shouldRotate()
    // doesn't immediately fire on the SAME usage figures that just
    // triggered THIS rotation. Without this:
    //   - lastTurnInputTokens is still ~95% of window (the value
    //     that triggered us). Next send → shouldRotate → true →
    //     another rotation, repeat.
    //   - numTurns is cumulative; minTurnsBeforeRotate doesn't help
    //     because we've passed it long ago.
    // After a rotation the new backing session starts fresh; the
    // ctx denominator is genuinely 0 until the first turn lands a
    // real usage row, so 0 is the right value to seed.
    // Capture BEFORE zeroing so the rotation message shows the real pre-rotation value.
    const ctxBefore = this.#usage.lastTurnInputTokens ?? 0;
    const pctBefore = Math.round((ctxBefore / Session.CONTEXT_WINDOW) * 100);
    this.#usage.lastTurnInputTokens = 0;
    this.#turnsSinceLastRotation = 0;

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
      parts.push(lastTurn.length > 2000 ? `${lastTurn.slice(0, 2000)}\n…` : lastTurn);
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
  /**
   * Compose the per-turn system-prompt append: the conductor contract (for
   * role:"conductor" sessions) plus the memory recall guidance (when memory
   * is enabled). Stable per session so it stays in the cached prompt prefix.
   */
  #buildPromptAppend(): string | undefined {
    const parts: string[] = [];
    if (this.role === "conductor") parts.push(CONDUCTOR_SYSTEM_PROMPT_APPEND);
    if (this.#memory) parts.push(this.#buildMemoryPromptAppend());
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

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
   * Authoritative approval gate — called from canUseTool, NOT from tool_start.
   * Has side effects in autonomous mode: decrements the turn budget and flips
   * mode to "guarded" when the budget is exhausted.
   *
   * IMPORTANT: #peekAutoApprove is used for the initial tool_call message
   * state (UI only). If you call #shouldAutoApprove from tool_start too, the
   * budget is decremented twice per tool call (once here, once there) because
   * tool_start runs after canUseTool's synchronous section but before its
   * first yield — the microtask ordering is deterministic.
   */
  #shouldAutoApprove(toolName: string): boolean {
    // HARD gate, checked before any mode logic: send-class fleet dispatch
    // (fleet_send / fleet_spawn / fleet_interrupt) must NEVER auto-approve —
    // not in autonomous mode, not under a turn budget. The owner confirming
    // each dispatch with the full input visible is the R3 safety invariant,
    // not a mode default.
    if (isFleetSendTool(toolName)) return false;

    if (this.#mode === "interactive") return false;

    // Read-only / retrieval tools — safe in both guarded and autonomous.
    if (isSafeTool(toolName)) return true;

    // Write / exec tools — only auto-approved in autonomous mode.
    if (this.#mode === "autonomous") {
      if (this.#turnsRemaining === undefined) return true;
      if (this.#turnsRemaining <= 0) {
        // Budget exhausted — revert to guarded (reads stay frictionless,
        // writes/exec start prompting again) and fall through to ask.
        this.setMode("guarded");
        return false;
      }
      this.#turnsRemaining -= 1;
      this.#broadcastInfoUpdate();
      return true;
    }

    return false;
  }

  /**
   * Side-effect-free read of auto-approve state. Used ONLY in the tool_start
   * event handler to determine the initial UI phase (executing vs
   * waiting_confirmation) without touching the turn budget or mode.
   *
   * The authoritative decision with side effects lives in #shouldAutoApprove,
   * called from #makeCanUseToolFn where the actual allow/deny happens.
   */
  #peekAutoApprove(toolName: string): boolean {
    if (isFleetSendTool(toolName)) return false;
    if (this.#mode === "interactive") return false;
    if (isSafeTool(toolName)) return true;
    if (this.#mode === "autonomous") {
      return this.#turnsRemaining === undefined || this.#turnsRemaining > 0;
    }
    return false;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  #waitForApproval(
    approvalId: string,
  ): Promise<{ approved: boolean; updatedInput?: Record<string, unknown> }> {
    // A decision may have raced ahead of registration — consume it now.
    const early = this.#earlyApprovals.get(approvalId);
    if (early) {
      this.#earlyApprovals.delete(approvalId);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      this.#pendingApprovals.set(approvalId, resolve);
    });
  }

  async #ensureAgentIdentity(sender: AuthContext): Promise<void> {
    const im = this.#identityManager;
    if (im && !this.#provider.hasQueried && this.#agentIdentity.sub.startsWith("agent:")) {
      try {
        // Dispatch-spawned workers get a shape-capped LEAF identity created
        // under the conductor's lineage; everything else registers the
        // standard session agent under the human sender.
        const { wimseUri } = this.#workerShape
          ? await im.registerWorker(this.id, this.name, this.#workerShape)
          : await im.registerSessionAgent(this.id, this.name, sender.sub);
        this.#agentIdentity = { sub: wimseUri, name: `${this.name} agent`, type: "agent" };
        console.log(`[codeoid] agent identity registered: ${wimseUri}`);
        const infoMsg = this.#makeMessage("info", "Agent identity registered", SYSTEM_IDENTITY, undefined, undefined, {
          event: "identity.registered",
          agentUri: wimseUri,
          sessionName: this.name,
          createdBy: sender.sub,
        });
        this.#persistAndBuffer(infoMsg);
        this.#broadcastRaw(infoMsg);
      } catch (err) {
        console.error("[codeoid] agent identity registration failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  #makeCanUseToolFn(sender: AuthContext): ToolApprovalFn {
    return async (_toolId, approvalId, toolName, inputObj) => {
      const autoApprove = this.#shouldAutoApprove(toolName);

      // Yield once so the tool_start event is processed by the event consumer
      // (creating the SessionMessage) before we return the approval decision.
      await Promise.resolve();

      if (autoApprove) {
        this.#approvalIdToMessageId.delete(approvalId); // clean up — no manual approval will reference this
        this.#approvalPatchKeys.delete(approvalId);
        this.#store.audit(sender.sub, "session.auto_approve", this.id, `tool=${toolName} mode=${this.#mode}`);
        this.#setStatus("tool_running");
        return { behavior: "allow" as const, updatedInput: inputObj };
      }

      // Manual approval — wait for user response.
      this.#setStatus("waiting_approval");
      const { approved, updatedInput } = await this.#waitForApproval(approvalId);
      this.#setStatus(approved ? "tool_running" : "thinking");

      // Finalize the tool_call message in scrollback + transcript.
      const msgId = this.#approvalIdToMessageId.get(approvalId);
      if (msgId) {
        // Approved → "executing" (tool hasn't run yet — tool_complete will
        // set the final "completed" state with real output). Denied → "cancelled".
        const resolvedState = (
          approved
            ? { phase: "executing", input: inputObj }
            : { phase: "cancelled", reason: "denied" }
        ) as unknown as ToolState;
        this.#scrollback.updateMessage(msgId, (m) => {
          const sm = m as SessionMessage;
          if (sm.tool) sm.tool.state = resolvedState;
        });
        const toolMsg = this.#toolCallMessages.get(msgId);
        if (toolMsg?.tool) {
          const resolvedMsg: SessionMessage = { ...toolMsg, tool: { ...toolMsg.tool, state: resolvedState }, timestamp: new Date().toISOString() };
          this.#transcriptStore.append(this.id, resolvedMsg, this.#seq++).catch(() => {});
          this.#broadcastRaw({
            type: "session.message.delta",
            sessionId: this.id,
            messageId: msgId,
            toolStateUpdate: resolvedState,
            timestamp: resolvedMsg.timestamp,
          });
        }
        this.#approvalIdToMessageId.delete(approvalId);
      }

      const patchableKeys = this.#approvalPatchKeys.get(approvalId);
      this.#approvalPatchKeys.delete(approvalId);
      if (approved) {
        this.#store.audit(sender.sub, "session.approve", this.id, `tool=${toolName} approvalId=${approvalId}`);
        const sanitizedPatch = sanitizeApprovalPatch(toolName, updatedInput, patchableKeys);
        const merged: Record<string, unknown> = sanitizedPatch ? { ...inputObj, ...sanitizedPatch } : inputObj;
        return { behavior: "allow" as const, updatedInput: merged };
      }
      this.#store.audit(sender.sub, "session.deny", this.id, `tool=${toolName} approvalId=${approvalId}`);
      return { behavior: "deny" as const, message: "Denied by user" };
    };
  }

  /**
   * True while event-stream silence is EXPECTED and the stall watchdog (and
   * the #sendInner liveness guard) must not treat it as a wedged turn:
   *
   *   - waiting_approval / pending approvals: the provider blocks on
   *     canUseTool until the user responds — a slow human is not a hang.
   *   - tool_running: a long tool execution (multi-minute Bash, Task
   *     subagents, web research) emits NO provider events until it
   *     completes. Recovering here kills legitimate in-flight work — the
   *     exact failure users hit with the 300s default on long tasks.
   *
   * Hung-tool protection is NOT lost: MCP calls have their own finer
   * timeout (session.mcpToolTimeoutMs), SDK built-ins carry tool-level
   * timeouts, a dead subprocess closes the event stream (which ends the
   * iterator and recovers the turn), and the user can always interrupt.
   */
  #watchdogPaused(): boolean {
    return (
      this.#status === "waiting_approval" ||
      this.#status === "tool_running" ||
      this.#pendingApprovals.size > 0 ||
      // A provider dialog blocks the provider on a human answer — event-stream
      // silence is expected, exactly like a pending tool approval.
      this.#pendingUiRequests.size > 0
    );
  }

  async #consumeEvents(run: TurnRun, _sender: AuthContext): Promise<void> {
    // Stall watchdog: drive the iterator manually so we can race each pull
    // against a timeout. If the provider stream goes silent for longer than
    // the configured window while the MODEL should be producing events
    // (status "thinking"), the turn is treated as wedged and force-recovered.
    // Silence during tool execution or a pending approval is legitimate and
    // pauses the watchdog — see #watchdogPaused. 0 disables the watchdog.
    // See #recoverStalledRun.
    const stallMs = this.#config?.session.turnStallTimeoutMs ?? 300_000;
    const iter = run.events[Symbol.asyncIterator]();
    const STALL = Symbol("stall");
    this.#lastEventAt = Date.now();
    // The in-flight pull persists ACROSS loop iterations: when a stall timer
    // fires but the pause re-check says silence is legitimate (see below), we
    // loop back and re-await the SAME pull instead of issuing a concurrent
    // iter.next() against the queue.
    let pending: Promise<IteratorResult<ProviderEvent>> | null = null;
    try {
      while (true) {
        let next: IteratorResult<ProviderEvent> | typeof STALL;
        pending ??= iter.next();
        if (stallMs > 0 && !this.#watchdogPaused()) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stall = new Promise<typeof STALL>((resolve) => {
            timer = setTimeout(() => resolve(STALL), stallMs);
          });
          try {
            next = await Promise.race([pending, stall]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        } else {
          next = await pending;
        }

        if (next === STALL) {
          // Re-check the pause AT FIRING TIME, not just at arming time. The
          // timer is armed while the model is thinking; if a tool_start (or
          // approval prompt) lands right after arming, the session enters a
          // legitimately-silent state while the old timer keeps counting —
          // without this re-check it would kill an actively-working tool the
          // moment the window lapses (the "timed out during a long research
          // task" bug). Loop back and re-await the same pending pull.
          if (this.#watchdogPaused()) continue;
          await this.#recoverStalledRun(run, stallMs);
          return; // finally still runs; #recoverStalledRun already cleared run state
        }
        pending = null; // pull consumed — next iteration issues a fresh one
        if (next.done) break;
        // Ownership guard: a concurrent #sendInner liveness-guard recovery may
        // have torn down this run while we were awaiting iter.next(). Drop any
        // late event from the abandoned run so it can't leak into the fresh turn.
        if (this.#activeRun !== run) break;
        const event = next.value;
        this.#lastEventAt = Date.now();
        // When a mid-turn message interrupts the current turn, the SDK emits a
        // turn_done (often with isError) for the aborted partial turn BEFORE it
        // starts the continuation turn for the injected message. Absorb that
        // intermediate boundary: flush per-turn state, record partial cost, and
        // continue looping — no break, no error display, no status flip to idle.
        // The continuation turn's events follow immediately in the same queue.
        if (event.type === "turn_done" && this.#pendingMidTurnCount > 0) {
          this.#pendingMidTurnCount--;
          // Record history / cost for the interrupted partial turn.
          this.#accumulator.handleEvent(event);
          this.#recordTurnFromResult(event.result);
          // Flush per-turn accumulators so the continuation turn starts clean.
          this.#completeActiveTools();
          this.#flushActiveAssistant();
          this.#finalizeActiveThinking();
          this.#chunker?.onTurnEnd();
          // Dismiss any stale approval gates from the interrupted turn.
          if (this.#pendingApprovals.size > 0) {
            const systemAuth: AuthContext = { sub: "system", scopes: [], delegationDepth: 0, accountId: this.accountId, projectId: this.projectId };
            for (const [aid, resolveFn] of this.#pendingApprovals.entries()) {
              resolveFn({ approved: false });
              this.#dismissStaleApproval(aid, systemAuth);
            }
            this.#pendingApprovals.clear();
          }
          // Re-assert thinking status so the UI doesn't flash idle between turns.
          if (this.#status !== "error") this.#setStatus("thinking");
          continue;
        }

        await this.#handleProviderEvent(event);
        if (event.type === "turn_done" || event.type === "error") break;
      }
    } catch (err) {
      if (!this.#activeRun) return; // torn down, ignore
      const emsg = err instanceof Error ? err.message : String(err);
      console.error(`[codeoid/session ${this.id}] provider event consumer failed:`, err);
      this.#setStatus("error");
      const errorMsg = this.#makeMessage("system", `Error: ${emsg}`, SYSTEM_IDENTITY, undefined, undefined, { event: "agent_error", errorCode: "agent_error" });
      this.#persistAndBuffer(errorMsg);
      this.#broadcastRaw(errorMsg);
    } finally {
      this.#pendingMidTurnCount = 0; // safety: reset on any exit path
      this.#completeActiveTools();
      this.#flushActiveAssistant();
      this.#finalizeActiveThinking();
      this.#chunker?.onTurnEnd();
      if (this.#pendingApprovals.size > 0) {
        const systemAuth: AuthContext = { sub: "system", scopes: [], delegationDepth: 0, accountId: this.accountId, projectId: this.projectId };
        for (const [aid, resolveFn] of this.#pendingApprovals.entries()) {
          resolveFn({ approved: false });
          this.#dismissStaleApproval(aid, systemAuth);
        }
        this.#pendingApprovals.clear();
      }
      // Guard: only clobber run state if this consumer owns the current run.
      // A recovery path may have started a replacement run before our finally
      // unwinds; clearing unconditionally would null the new run's slots.
      if (this.#activeRun === run) {
        this.#activeRun = null;
        this.#eventConsumerTask = null;
        if (this.#status !== "error") this.#setStatus("idle");
      }
    }
  }

  /**
   * Force-recover a wedged turn whose provider event stream went silent.
   *
   * Called by the #consumeEvents watchdog (after `stallMs` of no events) and by
   * the #sendInner liveness guard (when a send arrives on an apparently-dead
   * run). Idempotent and run-scoped: if `run` is no longer the active run, the
   * turn already ended and we no-op.
   *
   * Crucially this does NOT route through #teardownProvider (which awaits the
   * session event-consumer task — i.e. potentially itself). It nulls the run
   * slots up front, surfaces a clear message, resets status to idle, and hard
   * tears down the PROVIDER (abort → reap the hung subprocess). The next send()
   * recreates a fresh query loop. The abandoned consumer (if any) unblocks when
   * teardown closes the turn queue and its finally no-ops via the run guard.
   */
  async #recoverStalledRun(
    run: TurnRun,
    stallMs: number,
    opts?: { continuingCurrentSend?: boolean },
  ): Promise<void> {
    if (this.#activeRun !== run) return; // already ended / recovered

    console.error(
      `[codeoid/session ${this.id}] turn stalled — no provider events for ${stallMs}ms; force-recovering`,
    );

    // Stop any spinning UI and release waiters BEFORE we tear down.
    this.#completeActiveTools();
    this.#flushActiveAssistant();
    this.#finalizeActiveThinking();
    this.#chunker?.onTurnEnd();
    this.#pendingMidTurnCount = 0;
    if (this.#pendingApprovals.size > 0) {
      const systemAuth: AuthContext = { sub: "system", scopes: [], delegationDepth: 0, accountId: this.accountId, projectId: this.projectId };
      for (const [aid, resolveFn] of this.#pendingApprovals.entries()) {
        resolveFn({ approved: false });
        this.#dismissStaleApproval(aid, systemAuth);
      }
      this.#pendingApprovals.clear();
    }

    // Drop the wedged run so a concurrent send() doesn't queue into it.
    this.#activeRun = null;
    this.#eventConsumerTask = null;

    const msg = this.#makeMessage(
      "system",
      opts?.continuingCurrentSend
        ? `⚠️ Previous turn timed out — no activity for ${Math.round(stallMs / 1000)}s. The session was reset and your latest message is being retried in a fresh turn.`
        : `⚠️ Turn timed out — no activity for ${Math.round(stallMs / 1000)}s. The session was reset; send your message again to continue.`,
      SYSTEM_IDENTITY,
      undefined,
      undefined,
      { event: "turn_stalled", errorCode: "turn_stalled" },
    );
    this.#persistAndBuffer(msg);
    this.#broadcastRaw(msg);
    this.#setStatus("idle");

    // Hard teardown: abort the controller and reap the (presumed hung)
    // subprocess. Safe to await here — provider.teardown() awaits the
    // PROVIDER's own pump, never this session's consumer.
    try {
      await this.#provider.teardown();
    } catch (e) {
      console.error(
        `[codeoid/session ${this.id}] provider teardown during stall recovery failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async #handleProviderEvent(event: ProviderEvent): Promise<void> {
    // Subagent text/thinking (parentToolUseId set) is not part of the primary
    // conversation: streaming it into the primary assistant message corrupts
    // both the visible transcript and the canonical history, and a subagent
    // text_done would clobber the primary message mid-stream (#82). The
    // subagent's work still surfaces via its tool_call messages and the
    // spawning tool's result. Shared with the canonical accumulator's guard.
    if (isSubagentEvent(event)) return;
    switch (event.type) {
      case "text_delta": {
        if (!this.#activeAssistantMsg) {
          this.#activeAssistantMsg = this.#makeMessage("assistant", "", this.#agentIdentity, []);
          // Scrollback only — no transcript row, no chunker event. The buffer
          // holds the message by reference so clients attaching mid-stream see
          // it grow; the durable row and the chunker event are emitted once,
          // with final content, by #commitStreamed. Feeding the chunker an
          // empty assistant message here would emit a promptless half-episode.
          this.#scrollback.push(this.#activeAssistantMsg);
          this.#broadcastRaw(this.#activeAssistantMsg);
          if (this.#status === "tool_running") this.#setStatus("thinking");
        }
        this.#activeAssistantMsg.content += event.content;
        const delta: SessionMessageDelta = {
          type: "session.message.delta",
          sessionId: this.id,
          messageId: this.#activeAssistantMsg.messageId,
          contentAppend: event.content,
          timestamp: new Date().toISOString(),
        };
        this.#broadcastRaw(delta);
        break;
      }

      case "text_done": {
        this.#accumulator.handleEvent(event);
        // NOTE: do NOT call #completeActiveTools() here.
        // In the real SDK the committed assistant message (which fires text_done)
        // is emitted BEFORE the user/tool_result message (which fires tool_complete).
        // Calling completeActiveTools here cancels tools that are still executing.
        // Cleanup is handled solely by the #consumeEvents finally block.
        if (this.#activeAssistantMsg) {
          this.#activeAssistantMsg.content = event.content;
          this.#activeAssistantMsg.parts = [{ kind: "text", text: event.content, markdown: true }];
          this.#commitStreamed(this.#activeAssistantMsg);
          this.#broadcastRaw(this.#activeAssistantMsg);
          this.#activeAssistantMsg = null;
        } else if (event.content) {
          // No preceding text_delta — the SDK returned the response as a batch
          // (happens for mid-turn now-priority continuations). Simulate streaming
          // so the UI shows a typing animation instead of an instant text pop-in.
          await this.#artificiallyStreamText(event.content);
        }
        break;
      }

      case "thinking_delta": {
        this.#accumulator.handleEvent(event);
        if (this.#status === "tool_running") this.#setStatus("thinking");
        if (this.#activeThinkingIndex !== event.blockIndex || !this.#activeThinkingMsg) {
          this.#finalizeActiveThinking();
          this.#activeThinkingMsg = this.#makeMessage("thinking", "", this.#agentIdentity, []);
          this.#activeThinkingIndex = event.blockIndex ?? null;
          // Scrollback only — see the text_delta note; committed by
          // #finalizeActiveThinking → #commitStreamed.
          this.#scrollback.push(this.#activeThinkingMsg);
          this.#broadcastRaw(this.#activeThinkingMsg);
        }
        if (event.content) {
          this.#activeThinkingMsg.content += event.content;
          const delta: SessionMessageDelta = {
            type: "session.message.delta",
            sessionId: this.id,
            messageId: this.#activeThinkingMsg.messageId,
            contentAppend: event.content,
            timestamp: new Date().toISOString(),
          };
          this.#broadcastRaw(delta);
        }
        break;
      }

      case "thinking_done": {
        this.#finalizeActiveThinking();
        break;
      }

      case "tool_start": {
        this.#accumulator.handleEvent(event);
        // NOTE: do NOT call #completeActiveTools() here. It would cancel all
        // currently in-flight tools, which is correct for sequential calls but
        // silently kills parallel tool calls from concurrent subagents.
        // Cleanup is handled solely by the #consumeEvents finally block.
        // Await the ZeroID registration fence so sub-agent identity is resolved
        // before we attribute this tool call. Bounded by a 5s timeout so a
        // hung ZeroID service can't stall the event loop indefinitely.
        if (event.sdkAgentId) {
          const fence = this.#subagentRegistrations.get(event.sdkAgentId);
          if (fence) {
            const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
            try { await Promise.race([fence, timeout]); } catch { /* use placeholder */ }
          }
        }
        const emittingIdentity = event.sdkAgentId
          ? (this.#subagents.get(event.sdkAgentId)?.identity ?? this.#agentIdentity)
          : this.#agentIdentity;
        // Side-effect-free peek — budget decrement happens in canUseTool via
        // #shouldAutoApprove. Using #shouldAutoApprove here would decrement
        // twice per tool call (this handler runs in the same microtask batch
        // as canUseTool's synchronous section, always after it).
        const autoApprove = this.#peekAutoApprove(event.name);
        const toolMsg = this.#makeMessage(
          "tool_call",
          `${event.name}(${Object.keys(event.input).join(", ")})`,
          emittingIdentity,
          undefined,
          {
            toolId: event.toolId,
            name: event.name,
            input: event.input,
            state: autoApprove
              ? ({ phase: "executing", input: event.input } as unknown as ToolState)
              : ({
                  phase: "waiting_confirmation",
                  input: event.input,
                  description: `${event.name}(${Object.keys(event.input).join(", ")})`,
                  approvalId: event.approvalId,
                } as unknown as ToolState),
          },
        );
        this.#activeToolMsgIds.push(toolMsg.messageId);
        this.#toolCallMessages.set(toolMsg.messageId, toolMsg);
        this.#toolUseIdToMessageId.set(event.sdkToolUseId, toolMsg.messageId);
        this.#messageIdToToolUseId.set(toolMsg.messageId, event.sdkToolUseId);
        this.#approvalIdToMessageId.set(event.approvalId, toolMsg.messageId);
        // Provider-declared form fields — consumed by the approval sanitizer.
        if (event.patchableKeys && event.patchableKeys.length > 0) {
          this.#approvalPatchKeys.set(event.approvalId, event.patchableKeys);
        }
        this.#persistAndBuffer(toolMsg);
        this.#broadcastRaw(toolMsg);
        if (!autoApprove) this.#setStatus("waiting_approval");
        break;
      }

      case "tool_complete": {
        this.#accumulator.handleEvent(event);
        const msgId = this.#toolUseIdToMessageId.get(event.sdkToolUseId);
        if (msgId) {
          const toolMsg = this.#toolCallMessages.get(msgId);
          if (toolMsg?.tool) {
            const completedState = {
              phase: "completed",
              success: event.success,
              output: event.output,
            } as unknown as ToolState;
            this.#scrollback.updateMessage(msgId, (m) => {
              const sm = m as SessionMessage;
              if (sm.tool) sm.tool.state = completedState;
            });
            const completedMsg: SessionMessage = {
              ...toolMsg,
              tool: { ...toolMsg.tool, state: completedState },
              timestamp: new Date().toISOString(),
            };
            this.#transcriptStore.append(this.id, completedMsg, this.#seq++).catch(() => {});
            this.#broadcastRaw({
              type: "session.message.delta",
              sessionId: this.id,
              messageId: msgId,
              toolStateUpdate: completedState,
              timestamp: completedMsg.timestamp,
            });
            this.#toolCallMessages.delete(msgId);
            this.#messageIdToToolUseId.delete(msgId);
            const idx = this.#activeToolMsgIds.indexOf(msgId);
            if (idx >= 0) this.#activeToolMsgIds.splice(idx, 1);
          }
          this.#toolUseIdToMessageId.delete(event.sdkToolUseId);
        }
        if (this.#status === "tool_running") this.#setStatus("thinking");
        break;
      }

      case "subagent_start": {
        const agentId = event.agentId;
        const agentType = event.agentType;
        const childIdentity: MessageIdentity = { sub: `anonymous:subagent:${agentId}`, name: agentType, type: "subagent" };
        this.#subagents.set(agentId, { identity: childIdentity, agentType, spawnedAt: Date.now(), active: true });
        const im = this.#identityManager;
        if (im) {
          const fence = im.registerSubagent(this.id, agentId, agentType).then((result) => {
            const subagentEntry = this.#subagents.get(agentId);
            if (subagentEntry) subagentEntry.identity = { sub: result.wimseUri, name: agentType, type: "subagent" };
          }).catch((err) => {
            console.error(`[codeoid] subagent register failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          this.#subagentRegistrations.set(agentId, fence);
        }
        const infoMsg = this.#makeMessage("info", `Sub-agent spawned: ${agentType}`, this.#agentIdentity, undefined, undefined, {
          event: "subagent.spawned",
          subagentUri: childIdentity.sub,
          agentType,
          parentAgent: this.#agentIdentity.sub,
        });
        this.#persistAndBuffer(infoMsg);
        this.#broadcastRaw(infoMsg);
        this.#broadcastInfoUpdate();
        break;
      }

      case "subagent_stop": {
        const agentId = event.agentId;
        void this.#identityManager?.deactivateSubagent(this.id, agentId);
        this.#subagentRegistrations.delete(agentId);
        if (this.#subagents.delete(agentId)) {
          this.#broadcastInfoUpdate();
        }
        break;
      }

      case "mcp_init": {
        this.#sdkMcpStatus.clear();
        this.#sdkMcpTools.clear();
        for (const [name, status] of Object.entries(event.servers)) {
          this.#sdkMcpStatus.set(name, status);
          this.#sdkMcpTools.set(name, []);
        }
        for (const [server, tools] of Object.entries(event.tools)) {
          this.#sdkMcpTools.set(server, tools);
        }
        const toolCount = Object.values(event.tools).flat().length;
        const serverNames = Object.keys(event.servers).join(", ");
        if (toolCount > 0 || serverNames) {
          const infoMsg = this.#makeMessage("info", `MCP ready: ${serverNames} (${toolCount} tools)`, SYSTEM_IDENTITY, undefined, undefined, {
            event: "mcp.init",
            servers: event.servers,
            tools: event.tools,
          });
          this.#persistAndBuffer(infoMsg);
          this.#broadcastRaw(infoMsg);
        }
        break;
      }

      case "llm_call": {
        if (event.isPrimary) {
          this.#primaryTurnCalls.push(event.usage);
        } else {
          this.#subagentTurnCalls.push(event.usage);
        }
        break;
      }

      case "api_retry": {
        const retryMsg = this.#makeMessage("info",
          `API retry attempt ${event.attempt ?? "?"} (delay: ${event.retryDelayMs ?? 0}ms, status: ${event.errorStatus ?? "?"})`,
          SYSTEM_IDENTITY, undefined, undefined,
          { event: "api_retry", attempt: event.attempt, retryDelayMs: event.retryDelayMs, errorStatus: event.errorStatus },
        );
        this.#persistAndBuffer(retryMsg);
        this.#broadcastRaw(retryMsg);
        break;
      }

      case "tool_progress": {
        // Best-effort broadcast — tool is still running.
        break;
      }

      case "custom_message": {
        // Provider-authored standalone message (extension output, status
        // cards, rich widgets). Not part of the LLM conversation — the
        // canonical accumulator never sees it — but persisted + broadcast
        // like any other message so it replays on attach and survives
        // restarts. `content` is the plain fallback; `parts` carries the
        // rich blocks for capable clients.
        const role = event.role ?? "info";
        const msg = this.#makeMessage(
          role,
          event.content,
          role === "system" ? SYSTEM_IDENTITY : this.#agentIdentity,
          event.parts,
          undefined,
          // Fixed tag last so provider metadata can never override it —
          // clients identify provider messages by this key.
          { ...event.metadata, event: "provider.message" },
        );
        this.#persistAndBuffer(msg);
        this.#broadcastRaw(msg);
        break;
      }

      case "turn_done": {
        this.#accumulator.handleEvent(event);
        this.#recordTurnFromResult(event.result);
        if (event.result.isError) {
          const errText = event.result.errorMessage ?? "Turn ended with an error";
          const errorMsg = this.#makeMessage("system", `Error: ${errText}`, SYSTEM_IDENTITY, undefined, undefined, { event: "agent_error" });
          this.#persistAndBuffer(errorMsg);
          this.#broadcastRaw(errorMsg);
          this.#setStatus("error");
        } else if (this.#status !== "error") {
          this.#setStatus("idle");
        }
        break;
      }

      case "error": {
        console.error(`[codeoid/session ${this.id}] provider error:`, event.message);
        this.#setStatus("error");
        const errorMsg = this.#makeMessage("system", `Error: ${event.message}`, SYSTEM_IDENTITY, undefined, undefined, { event: "agent_error" });
        this.#persistAndBuffer(errorMsg);
        this.#broadcastRaw(errorMsg);
        break;
      }
    }
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
    this.#commitStreamed(m);
    this.#broadcastRaw(m);
  }

  /**
   * Emit text as artificial streaming deltas so the UI shows a typing animation
   * for responses the SDK returned as a single batch (no preceding text_delta).
   * This happens for mid-turn now-priority continuations where the SDK skips
   * streaming and emits only an `assistant` message.
   *
   * Scales step size to yield ~30 animation frames at 16ms each (~480ms total),
   * so the animation looks natural across any response length without adding
   * meaningful latency.
   *
   * Interrupt safety: each loop iteration checks whether #activeAssistantMsg
   * still points to the message we created; if interrupt() ran between frames
   * (#flushActiveAssistant nulled it), we return early — the partial content was
   * already committed by the flush.
   */
  async #artificiallyStreamText(content: string): Promise<void> {
    const FRAME_MS = 16;
    const steps = Math.min(30, content.length);
    const charsPerStep = Math.ceil(content.length / steps);

    const msg = this.#makeMessage("assistant", "", this.#agentIdentity, []);
    this.#activeAssistantMsg = msg;
    // Scrollback only — committed with final content below.
    this.#scrollback.push(msg);
    this.#broadcastRaw(msg);

    for (let pos = 0; pos < content.length; pos += charsPerStep) {
      if (this.#activeAssistantMsg !== msg) return; // interrupted between frames
      const chunk = content.slice(pos, pos + charsPerStep);
      msg.content += chunk;
      const delta: SessionMessageDelta = {
        type: "session.message.delta",
        sessionId: this.id,
        messageId: msg.messageId,
        contentAppend: chunk,
        timestamp: new Date().toISOString(),
      };
      this.#broadcastRaw(delta);
      await new Promise<void>((r) => setTimeout(r, FRAME_MS));
    }

    if (this.#activeAssistantMsg !== msg) return; // interrupted on last frame
    msg.content = content;
    msg.parts = [{ kind: "text", text: content, markdown: true }];
    this.#commitStreamed(msg);
    this.#broadcastRaw(msg);
    this.#activeAssistantMsg = null;
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
    this.#commitStreamed(m);
    this.#broadcastRaw(m);
  }

  /** Mark any still-open tool calls as cancelled — skips ones already closed with a real tool_result. */
  #completeActiveTools(): void {
    for (const msgId of this.#activeToolMsgIds) {
      if (this.#toolCallsClosedByResult.has(msgId)) continue;
      this._applyInterruptedStateToTool(msgId);
    }
    this.#activeToolMsgIds = [];
  }

  /**
   * Apply `cancelled/interrupted` terminal state to one orphaned tool call:
   * update the scrollback entry in-place, persist to transcript, and broadcast
   * the state delta to attached clients.
   *
   * TypeScript-private (not `#`) so unit tests can exercise this path directly
   * without a live SDK turn — call via `(session as SessionInternal)._applyInterruptedStateToTool(msgId)`.
   * Do NOT call from production code outside this class.
   */
  private _applyInterruptedStateToTool(msgId: string): void {
    // A tool reaching this fallback never produced a real tool_result — it was
    // interrupted mid-flight. Use `cancelled/interrupted` (not `completed/false`)
    // so clients render it as a cancellation, not a failure with no message.
    const cancelledState = { phase: "cancelled" as const, reason: "interrupted" as const };
    let updated: SessionMessage | null = null;
    this.#scrollback.updateMessage(msgId, (msg) => {
      const sm = msg as SessionMessage;
      if (sm.tool) {
        sm.tool.state = cancelledState;
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
      toolStateUpdate: cancelledState,
      timestamp: new Date().toISOString(),
    });

    // Clean up correlation maps. tool_complete normally does this; for
    // denied/interrupted tools it never fires, so we do it here to prevent
    // these maps growing without bound across many interrupts in long sessions.
    const sdkToolUseId = this.#messageIdToToolUseId.get(msgId);
    if (sdkToolUseId) {
      this.#toolUseIdToMessageId.delete(sdkToolUseId);
      this.#messageIdToToolUseId.delete(msgId);
    }
    this.#toolCallMessages.delete(msgId);
    // Drop the provider-declared patch whitelist for this tool's approval —
    // the approval will never resolve now.
    for (const [approvalId, mappedMsgId] of this.#approvalIdToMessageId) {
      if (mappedMsgId === msgId) this.#approvalPatchKeys.delete(approvalId);
    }
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

  /**
   * Commit the final content of a streamed message. The message was pushed
   * into scrollback (by reference) at stream start and grew in place via
   * deltas; ScrollbackBuffer.push upserts by messageId, so this re-accounts
   * the existing entry — or re-adds it if it was evicted mid-stream — without
   * ever creating a duplicate. A second entry per messageId corrupts
   * scrollback.replay: clients render the message twice and virtualizers
   * keyed on messageId collide (the #50 bug class). The durable transcript
   * row and the memory-chunker event are emitted here exactly once, with
   * final content, so plain turns produce one user+assistant episode instead
   * of two half-episodes.
   */
  #commitStreamed(msg: SessionMessage): void {
    this.#scrollback.push(msg);
    this.#transcriptStore.append(this.id, msg, this.#seq++).catch((e) => {
      console.error(
        `[codeoid/session ${this.id}] transcript append failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    this.#chunker?.onMessage(msg);
  }

  /** Persist to transcript + scrollback buffer + memory chunker */
  #persistAndBuffer(msg: SessionMessage): void {
    this.#scrollback.push(msg);
    // Log instead of swallowing — a silently-dropped transcript write means a
    // turn that's missing on resume with no trace. (Scrollback above is the
    // in-memory handoff source and is synchronous, so device-handoff replay
    // is unaffected; this is the durable-persistence path.)
    this.#transcriptStore.append(this.id, msg, this.#seq++).catch((e) => {
      console.error(
        `[codeoid/session ${this.id}] transcript append failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    this.#chunker?.onMessage(msg);
  }

  /** Broadcast any DaemonMessage to all attached clients */
  #broadcastRaw(msg: DaemonMessage): void {
    // Stamp the session cursor (`replay.resume`) onto outbound streaming
    // frames. Deltas mutate their target message in place, so the buffer
    // entry's seq must advance with each one — touch() is the single point
    // that both records the mutation and yields the frame's seq. Full
    // messages already carry the seq assigned by scrollback.push(). O(1),
    // no re-serialization — safe on the per-token hot path.
    if (msg.type === "session.message.delta") {
      const seq = this.#scrollback.touch(msg.messageId);
      if (seq !== undefined) msg.seq = seq;
    }
    for (const client of this.#clients.values()) {
      try {
        client.send(msg);
      } catch {
        this.#clients.delete(client.id);
      }
    }
  }

  /**
   * Duplicate-send guard (`send.idempotency`). Returns true when this
   * clientMsgId was already accepted for this session — the caller should
   * ack without dispatching a second turn (a duplicated user prompt is a
   * duplicated LLM turn: real token spend). Records the id on first sight.
   */
  markClientMsgSeen(clientMsgId: string): boolean {
    if (this.#seenClientMsgIds.has(clientMsgId)) return true;
    this.#seenClientMsgIds.add(clientMsgId);
    if (this.#seenClientMsgIds.size > 256) {
      const oldest = this.#seenClientMsgIds.values().next().value;
      if (oldest !== undefined) this.#seenClientMsgIds.delete(oldest);
    }
    return false;
  }

  #setStatus(status: SessionStatus): void {
    // Many call sites re-assert the current value (thinking → thinking
    // between the tool calls of a long turn). Those carry no information
    // for clients or for resume — skip the persistence AND the broadcast.
    if (status === this.#status) return;
    this.#status = status;

    // Persisted status exists for restart resume (and the session list).
    // Terminal / parked states (idle, waiting_approval, error) mark durable
    // turn boundaries, so they write through immediately — shutdown's
    // drain() polls in-memory status to idle and then closes the store, so
    // the idle write must not sit behind a timer. The ACTIVE pair flips on
    // every tool call; coalesce those behind a short trailing debounce so a
    // 200-tool-call turn costs a handful of writes instead of hundreds of
    // sync UPDATEs + meta temp-file renames on the shared event loop. A
    // crash can lose at most the debounce window of thinking/tool_running —
    // states resume reconciles as interrupted anyway.
    if (isActiveStatus(status)) {
      this.#statusPersistTimer ??= setTimeout(() => {
        this.#statusPersistTimer = null;
        this.#persistStatus();
      }, STATUS_PERSIST_DEBOUNCE_MS);
    } else {
      this.#persistStatus();
    }

    this.#broadcastRaw({
      type: "session.status_change",
      sessionId: this.id,
      status,
      timestamp: new Date().toISOString(),
    });

    // Daemon-side observer (dispatcher worker-watching). After the broadcast
    // so observers see the same ordering clients do; never throws into the
    // status path.
    if (this.#onStatusChange) {
      try {
        this.#onStatusChange(this.id, status);
      } catch (err) {
        console.error(
          `[codeoid/session ${this.id}] onStatusChange observer failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Write the CURRENT status through to the sessions DB + transcript meta,
   * cancelling any pending debounced write (it would be redundant). */
  #persistStatus(): void {
    if (this.#statusPersistTimer) {
      clearTimeout(this.#statusPersistTimer);
      this.#statusPersistTimer = null;
    }
    try {
      this.#store.updateSessionStatus(this.id, this.#status);
    } catch (err) {
      // A debounced write can fire after shutdown closed the DB (or after a
      // test tore the store down). Losing an in-flight active status is
      // harmless — resume reconciles those — and must not crash the daemon.
      // Terminal states DO matter for restart resume, so surface those.
      if (!isActiveStatus(this.#status)) {
        console.error(
          `[codeoid/session ${this.id}] status persist failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.#transcriptStore.saveMeta({
      sessionId: this.id,
      sessionName: this.name,
      workdir: this.workdir,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      lastStatus: this.#status,
      lastActivityAt: new Date().toISOString(),
      accountId: this.accountId,
      projectId: this.projectId,
      role: this.role,
      providerId: this.#provider.id,
    }).catch(() => {});
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
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function isSafeTool(name: string): boolean {
  if (SAFE_TOOLS.has(name)) return true;
  // All memory recall tools are read-only.
  if (name.startsWith("mcp__codeoid_memory__")) return true;
  return false;
}

const SAFE_TOOLS = new Set<string>(["Read", "Grep", "Glob"]);

/**
 * Per-tool whitelist for the `updatedInput` patch a client may send
 * with `session.approve`.
 *
 * The shallow-merge inside `canUseTool` would otherwise let any
 * client field land in the SDK's tool input — including overriding
 * the very fields the user just inspected and approved. We allow
 * patches only for tools where the user's response IS a form input,
 * and even then restrict the keys:
 *
 *   - `patchableKeys` (provider-declared on `tool_start`) wins when
 *     present: only those keys pass, values verbatim. This is how
 *     non-Claude backends with form-style tools opt in without the
 *     daemon hardcoding their tool names.
 *   - Otherwise the built-in AskUserQuestion whitelist applies.
 *
 * Returns `undefined` when the patch should be ignored entirely
 * (binary-approve tools, or empty input). Returns the sanitized
 * subset of fields the tool legitimately needs from approval.
 */
function sanitizeApprovalPatch(
  toolName: string,
  patch: Record<string, unknown> | undefined,
  patchableKeys?: readonly string[],
): Record<string, unknown> | undefined {
  if (!patch || typeof patch !== "object") return undefined;
  if (patchableKeys && patchableKeys.length > 0) {
    const clean: Record<string, unknown> = {};
    for (const key of patchableKeys) {
      if (Object.hasOwn(patch, key)) clean[key] = patch[key];
    }
    return Object.keys(clean).length > 0 ? clean : undefined;
  }
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
