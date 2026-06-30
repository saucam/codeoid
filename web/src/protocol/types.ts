/**
 * Wire-protocol types for the Codeoid daemon. Mirrors
 * `codeoid/src/protocol/types.ts` — keep them in sync.
 *
 * Only the subset the web UI consumes is imported. Unknown fields on
 * incoming messages are ignored gracefully (additive-safe protocol).
 */

export const PROTOCOL_VERSION = 1;

// -----------------------------------------------------------------------------
// Identity + auth
// -----------------------------------------------------------------------------

export type IdentityType = "human" | "agent" | "subagent" | "system";

export interface MessageIdentity {
  sub: string;
  name?: string;
  type: IdentityType;
}

// -----------------------------------------------------------------------------
// Sessions
// -----------------------------------------------------------------------------

// `working` + `waiting_approval` are what the daemon actually emits; the
// finer `thinking` / `tool_running` are kept for forward-compat in case the
// daemon ever splits the active state. Treat `working` as "active" in the UI.
export type SessionStatus =
  | "idle"
  | "working"
  | "waiting_approval"
  | "thinking"
  | "tool_running"
  | "error";
export type SessionMode = "interactive" | "guarded" | "autonomous";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  recentTurns?: TurnUsage[];
  peakInputTokens?: number;
  lastTurnInputTokens?: number;
  lastTurnOutputTokens?: number;
  lastTurnCostUsd?: number;
  lastTurnCacheHitRate?: number;
  /**
   * Resolved model's context window in tokens — denominator for the
   * ctx-occupancy display. Optional for back-compat with older daemons;
   * frontends fall back to a conservative constant when unset.
   */
  contextWindow?: number;
}

export interface TurnUsage {
  turnNumber: number;
  createdAt: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  durationMs: number;
  stopReason?: string;
  totalInputTokens: number;
  billableInputTokens: number;
  cacheHitRate: number;
}

// ── Usage analytics ───────────────────────────────────────────────────────────

export interface DailyUsageBucket {
  day: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  numSessions: number;
}

export interface LifetimeUsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  numSessions: number;
}

export interface Subagent {
  agentId: string;
  wimseUri?: string;
  agentType: string;
  spawnedAt: number;
  active: boolean;
}

export interface SessionInfo {
  id: string;
  name: string;
  workdir: string;
  status: SessionStatus;
  createdBy: string;
  createdAt: string;
  attachedClients: number;
  mode?: SessionMode;
  turnsRemaining?: number;
  pinnedFiles?: string[];
  agentUri?: string;
  subagents?: Subagent[];
  usage?: SessionUsage;
  rotation?: {
    count: number;
    lastRotatedAt: number | null;
    claudeCodeSessionId?: string;
  };
  queuedMessages?: number;
  model?: string;
  fallbackModel?: string;
}

// -----------------------------------------------------------------------------
// Message content
// -----------------------------------------------------------------------------

export type MessageRole =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "system"
  | "info";

export type ContentPart =
  | { kind: "text"; text: string; markdown?: boolean }
  | { kind: "code"; code: string; language?: string; filePath?: string }
  | {
      kind: "file_ref";
      path: string;
      lines?: [number, number];
      change?: { added: number; removed: number };
    }
  | {
      kind: "diff";
      path: string;
      added: number;
      removed: number;
      originalPath?: string;
    }
  | { kind: "tree"; label: string; children: TreeNode[] }
  | {
      kind: "button";
      label: string;
      action: string;
      data?: Record<string, unknown>;
      style?: "primary" | "secondary" | "danger";
    }
  | { kind: "progress"; message: string; percent?: number; elapsedMs?: number }
  | { kind: "image"; url: string; alt?: string }
  | { kind: "anchor"; uri: string; title: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

export interface TreeNode {
  label: string;
  type: "file" | "directory";
  path?: string;
  children?: TreeNode[];
}

// -----------------------------------------------------------------------------
// Tool lifecycle
// -----------------------------------------------------------------------------

export type ToolPhase =
  | "streaming"
  | "waiting_confirmation"
  | "executing"
  | "completed"
  | "cancelled";

export type ToolState =
  | { phase: "streaming"; partialInput?: unknown }
  | {
      phase: "waiting_confirmation";
      input: unknown;
      description: string;
      approvalId: string;
    }
  | { phase: "executing"; progress?: string; elapsedMs?: number }
  | {
      phase: "completed";
      success: boolean;
      output?: string;
      elapsedMs?: number;
      confirmedBy?: "user" | "auto" | "setting";
    }
  | {
      phase: "cancelled";
      reason: "denied" | "interrupted" | "timeout";
      message?: string;
    };

export interface ToolInfo {
  toolId: string;
  name: string;
  state: ToolState;
  /**
   * Original tool input from the model. Persists across phase
   * transitions so the diff renderer can show the proposed Edit /
   * Write even after the tool moves out of waiting_confirmation.
   */
  input?: unknown;
}

// -----------------------------------------------------------------------------
// Session messages
// -----------------------------------------------------------------------------

export interface SessionMessage {
  type: "session.message";
  sessionId: string;
  messageId: string;
  role: MessageRole;
  content: string;
  parts?: ContentPart[];
  identity: MessageIdentity;
  tool?: ToolInfo;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface SessionMessageDelta {
  type: "session.message.delta";
  sessionId: string;
  messageId: string;
  contentAppend?: string;
  partsAppend?: ContentPart[];
  partsUpdate?: { index: number; part: ContentPart }[];
  toolStateUpdate?: ToolState;
  timestamp: string;
}

// -----------------------------------------------------------------------------
// Client → Daemon messages
// -----------------------------------------------------------------------------

interface BaseClientMsg {
  id: string;
}

export interface SessionCreateMsg extends BaseClientMsg {
  type: "session.create";
  name: string;
  workdir: string;
}

export interface SessionRenameMsg extends BaseClientMsg {
  type: "session.rename";
  sessionId: string;
  name: string;
}

export interface SessionListMsg extends BaseClientMsg {
  type: "session.list";
}

export interface SessionAttachMsg extends BaseClientMsg {
  type: "session.attach";
  sessionId: string;
}

export interface SessionDetachMsg extends BaseClientMsg {
  type: "session.detach";
  sessionId: string;
}

export interface SessionSendMsg extends BaseClientMsg {
  type: "session.send";
  sessionId: string;
  text: string;
  attachments?: { path: string; content?: string; mimeType?: string; data?: string }[];
  priority?: "now" | "next" | "later";
}

export interface SessionInterruptMsg extends BaseClientMsg {
  type: "session.interrupt";
  sessionId: string;
}

export interface SessionApproveMsg extends BaseClientMsg {
  type: "session.approve";
  sessionId: string;
  approvalId: string;
  approved: boolean;
  /**
   * Patch shallow-merged into the original tool input before the SDK
   * runs the tool. Required for AskUserQuestion (carries `answers`).
   * Omitted for binary approvals.
   */
  updatedInput?: Record<string, unknown>;
}

export interface SessionDestroyMsg extends BaseClientMsg {
  type: "session.destroy";
  sessionId: string;
}

export interface SessionSetModeMsg extends BaseClientMsg {
  type: "session.set_mode";
  sessionId: string;
  mode: SessionMode;
  maxTurns?: number;
}

export interface SessionRotateMsg extends BaseClientMsg {
  type: "session.rotate";
  sessionId: string;
}

export interface SessionSetModelMsg extends BaseClientMsg {
  type: "session.set_model";
  sessionId: string;
  model: string;
  fallbackModel?: string | null;
}

export interface SessionSearchMsg extends BaseClientMsg {
  type: "session.search";
  query: string;
  scope?: "workspace" | "all";
  workdir?: string;
  limit?: number;
}

export interface FsListMsg extends BaseClientMsg {
  type: "fs.list";
  sessionId: string;
  /** Path relative to the session's workdir. "" / "." / "/" all = root. */
  path: string;
}

export interface FsReadMsg extends BaseClientMsg {
  type: "fs.read";
  sessionId: string;
  path: string;
  /** Hard cap in bytes; daemon ceiling is 10 MiB. Default 1 MiB. */
  maxBytes?: number;
}

export interface FsBrowseDirMsg extends BaseClientMsg {
  type: "fs.browse_dir";
  /** Absolute path to browse. Defaults to the daemon user's HOME. */
  path?: string;
}

export interface ClaudeConfigMsg extends BaseClientMsg {
  type: "claude.config";
  sessionId: string;
}

/** Ask the daemon for the live model catalog the backend supports. */
export interface ModelsListMsg extends BaseClientMsg {
  type: "models.list";
}

/** One selectable model as reported by the Claude Code backend. */
export interface ModelInfo {
  value: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

export interface ModelsListResultMsg {
  type: "models.list.result";
  requestId: string;
  models: ModelInfo[];
  live: boolean;
}

export interface SessionExportMsg extends BaseClientMsg {
  type: "session.export";
  sessionId: string;
  includeMemory?: boolean;
  includePinnedFiles?: boolean;
  aliasOverride?: string;
  toFile?: boolean;
}

export interface SessionImportMsg extends BaseClientMsg {
  type: "session.import";
  source: { kind: "inline"; bundle: unknown } | { kind: "file"; path: string };
  targetWorkdir: string;
  nameOverride?: string;
  writePinnedFiles?: boolean;
}

/** Liveness heartbeat — daemon replies with `response.ok`. */
export interface PingMsg extends BaseClientMsg {
  type: "ping";
}

export interface UsageDailyMsg extends BaseClientMsg {
  type: "usage.daily";
  days?: number;
}

export type ClientMessage =
  | PingMsg
  | SessionCreateMsg
  | SessionRenameMsg
  | SessionListMsg
  | SessionAttachMsg
  | SessionDetachMsg
  | SessionSendMsg
  | SessionInterruptMsg
  | SessionApproveMsg
  | SessionDestroyMsg
  | SessionSetModeMsg
  | SessionRotateMsg
  | SessionSetModelMsg
  | SessionSearchMsg
  | FsListMsg
  | FsReadMsg
  | FsBrowseDirMsg
  | ClaudeConfigMsg
  | ModelsListMsg
  | SessionExportMsg
  | SessionImportMsg
  | UsageDailyMsg;

// -----------------------------------------------------------------------------
// Daemon → Client messages
// -----------------------------------------------------------------------------

export interface AuthOkMsg {
  type: "auth.ok";
  identity: MessageIdentity;
  scopes: readonly string[];
  protocolVersion?: number;
}

export interface ResponseOkMsg {
  type: "response.ok";
  requestId: string;
  data?: unknown;
}

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "internal";

export interface ResponseErrorMsg {
  type: "response.error";
  requestId: string;
  error: string;
  code: ErrorCode;
}

export interface SessionListResultMsg {
  type: "session.list.result";
  requestId: string;
  sessions: SessionInfo[];
}

export interface SessionStatusChangeMsg {
  type: "session.status_change";
  sessionId: string;
  status: SessionStatus;
  timestamp: string;
}

export interface SessionInfoUpdateMsg {
  type: "session.info_update";
  session: SessionInfo;
  timestamp: string;
}

export interface ScrollbackReplayMsg {
  type: "scrollback.replay";
  sessionId: string;
  messages: SessionMessage[];
}

export interface SessionSearchSnippet {
  episodeId: string;
  kind: "user_turn" | "assistant_turn" | "tool_call" | "error";
  toolName?: string;
  summary: string;
  excerpt: string;
  createdAt: number;
  score: number;
  filePaths: string[];
}

export interface SessionSearchHit {
  sessionId: string;
  sessionName: string;
  workdir: string;
  matchCount: number;
  firstMatchAt: number;
  lastMatchAt: number;
  aggregateScore: number;
  snippets: SessionSearchSnippet[];
}

export interface SessionSearchResultMsg {
  type: "session.search.result";
  requestId: string;
  query: string;
  sessions: SessionSearchHit[];
  workspaceId: string;
  limit: number;
}

export interface FsEntry {
  name: string;
  /** Path relative to the session's workdir. */
  path: string;
  kind: "file" | "directory";
  size?: number;
  mtimeMs?: number;
  isSymlink?: boolean;
}

export interface FsListResultMsg {
  type: "fs.list.result";
  requestId: string;
  /** Echoed `path` (canonicalised, still relative to workdir). */
  path: string;
  entries: FsEntry[];
}

export interface FsReadResultMsg {
  type: "fs.read.result";
  requestId: string;
  path: string;
  /** UTF-8 text or base64-encoded binary; decide via `encoding`. */
  content: string;
  encoding: "utf-8" | "base64";
  /** Total size on disk; may exceed `content` length when `truncated`. */
  size: number;
  /** shiki-compatible language hint, when the daemon could detect one. */
  language?: string;
  truncated: boolean;
}

export interface FsBrowseDirResultMsg {
  type: "fs.browse_dir.result";
  requestId: string;
  path: string;
  root: string;
  parent: string | null;
  entries: FsEntry[];
}

export type ClaudeConfigScope = "global" | "workdir";

export interface ClaudeConfigAgent {
  name: string;
  description: string | null;
  path: string;
  scope: ClaudeConfigScope;
  tools?: string[];
}

export interface ClaudeConfigSkill {
  name: string;
  description: string | null;
  path: string;
  scope: ClaudeConfigScope;
}

export interface ClaudeConfigMcpServer {
  name: string;
  scope: ClaudeConfigScope;
  path: string;
  command: string | null;
  args: string[];
  envKeys: string[];
  url: string | null;
  type: string | null;
  /** HTTP-type MCP servers' header keys (values redacted at the daemon). */
  headerKeys?: string[];
  /** SDK-reported live connection status (e.g. "connected", "failed"). */
  liveStatus?: string;
  /** Fully-qualified MCP tool names exposed by this server in the active session. */
  liveTools?: string[];
}

export interface ClaudeConfigHook {
  event: string;
  scope: ClaudeConfigScope;
  path: string;
  matcher: string | null;
  kind: string;
  command: string;
}

export interface ClaudeConfigResultMsg {
  type: "claude.config.result";
  requestId: string;
  workdir: string;
  agents: ClaudeConfigAgent[];
  skills: ClaudeConfigSkill[];
  mcpServers: ClaudeConfigMcpServer[];
  hooks: ClaudeConfigHook[];
}

export interface SessionExportResultMsg {
  type: "session.export.result";
  requestId: string;
  manifest: {
    exportedAt: string;
    session: {
      id: string;
      name: string;
      createdAt: string;
      model?: string;
      mode?: string;
    };
    workdir: { alias: string; aliasSource: string; originalAbsolute: string };
    counts: {
      messages: number;
      episodes: number;
      turns: number;
      pinnedFiles: number;
    };
  };
  payload:
    | { kind: "inline"; bundle: unknown; sizeBytes: number }
    | { kind: "file"; path: string; sizeBytes: number };
}

export interface SessionImportResultMsg {
  type: "session.import.result";
  requestId: string;
  newSessionId: string;
  importedMessages: number;
  importedEpisodes: number;
  importedTurns: number;
  pinnedFilesWritten: number;
  warnings: string[];
}

export type DaemonMessage =
  | AuthOkMsg
  | ResponseOkMsg
  | ResponseErrorMsg
  | SessionListResultMsg
  | SessionMessage
  | SessionMessageDelta
  | SessionStatusChangeMsg
  | SessionInfoUpdateMsg
  | ScrollbackReplayMsg
  | SessionSearchResultMsg
  | FsListResultMsg
  | FsReadResultMsg
  | FsBrowseDirResultMsg
  | ClaudeConfigResultMsg
  | ModelsListResultMsg
  | SessionExportResultMsg
  | SessionImportResultMsg;
