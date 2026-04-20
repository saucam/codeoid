/**
 * Codeoid Server Protocol v2
 *
 * Design principles:
 *   1. Every message is self-contained, serializable JSON — no observables, no callbacks
 *   2. Every message carries identity (who produced it) — auditable top to bottom
 *   3. Discriminated unions with `kind` fields — frontends switch on kind, ignore unknown
 *   4. Simple frontends (Telegram) use role + content string, rich frontends use parts[]
 *   5. Tool calls are state machines — streaming → confirmation → executing → completed
 *   6. Streaming via delta messages — reference a messageId, append content
 *   7. Extensible — new roles, content parts, tool states added without breaking existing frontends
 *
 * Inspired by VS Code's IChatProgress union and tool invocation state machine.
 * Adapted for network transport (JSON over WebSocket) and multi-frontend/multi-user.
 */

import type { Scope } from "./scopes.js";

// =============================================================================
// Session metadata
// =============================================================================

export type SessionStatus = "idle" | "working" | "waiting_approval" | "error";

/**
 * Execution mode — controls tool approval and autonomous budgeting.
 *
 * - `interactive` (default): every tool call asks for approval
 * - `auto-allow`: Read/Grep/Glob/memory/recall are auto-approved; Write/Edit/Bash still ask
 * - `autonomous`: every tool auto-approved until the turn budget (`maxTurns`) is exhausted;
 *   session then reverts to `interactive` and interrupts
 */
export type SessionMode = "interactive" | "auto-allow" | "autonomous";

export interface SessionInfo {
  id: string;
  name: string;
  workdir: string;
  status: SessionStatus;
  createdBy: string;
  createdAt: string;
  attachedClients: number;
  /** Current execution mode (default "interactive"). */
  mode?: SessionMode;
  /** Remaining turns budget for autonomous mode (undefined = unbounded, 0 = exhausted). */
  turnsRemaining?: number;
  /** Files pinned to the session — prepended to every turn's prompt. */
  pinnedFiles?: string[];
  /** SPIFFE/WIMSE URI of the primary session agent (falls back to anonymous:session:<id>). */
  agentUri?: string;
  /** Active sub-agents for the identity chain display. */
  subagents?: Subagent[];
}

export interface Subagent {
  /** SDK-side agent id (opaque handle). */
  agentId: string;
  /** ZeroID WIMSE URI if registered, else undefined. */
  wimseUri?: string;
  /** Subagent type label (e.g. "general-purpose", "code-reviewer", "Explorer"). */
  agentType: string;
  /** Unix ms when the sub-agent started. */
  spawnedAt: number;
  /** True while the sub-agent is running; false after SubagentStop. */
  active: boolean;
}

// =============================================================================
// Identity — WHO produced a message. On every message, always.
// =============================================================================

export type IdentityType = "human" | "agent" | "subagent" | "system";

export interface MessageIdentity {
  /** ZeroID WIMSE URI (e.g. spiffe://zeroid.dev/personal/dev/agent/codeoid-session-abc) */
  sub: string;
  /** Human-readable display name */
  name?: string;
  /** What kind of entity produced this */
  type: IdentityType;
}

/** System identity — used for daemon-generated messages */
export const SYSTEM_IDENTITY: MessageIdentity = {
  sub: "system:codeoid",
  name: "Codeoid",
  type: "system",
};

// =============================================================================
// Message roles
// =============================================================================

/**
 * Every message has a role. Simple frontends render based on role alone.
 * Extensible — add new roles without breaking existing frontends.
 */
export type MessageRole =
  | "user"           // Human sent a prompt
  | "assistant"      // Agent's text response
  | "thinking"       // Agent's reasoning / extended thinking
  | "tool_call"      // Agent invoked a tool
  | "tool_result"    // Tool execution output
  | "system"         // Errors, retries, warnings
  | "info";          // Informational (identity changes, session events)

// =============================================================================
// Content parts — rich, structured content within a message.
//
// Frontends that support rich rendering use parts[].
// Simple frontends (Telegram) fall back to the `content` string.
// Discriminated on `kind` — ignore unknown kinds gracefully.
// =============================================================================

export type ContentPart =
  | TextPart
  | CodePart
  | FileRefPart
  | DiffPart
  | TreePart
  | ButtonPart
  | ProgressPart
  | ImagePart
  | AnchorPart
  | TablePart;

/** Markdown or plain text */
export interface TextPart {
  kind: "text";
  text: string;
  /** If true, text contains markdown. Default: true for assistant role. */
  markdown?: boolean;
}

/** Fenced code block with optional language */
export interface CodePart {
  kind: "code";
  code: string;
  language?: string;
  /** Optional file path this code belongs to */
  filePath?: string;
}

/** Reference to a file (clickable in rich frontends) */
export interface FileRefPart {
  kind: "file_ref";
  path: string;
  /** Optional line range */
  lines?: [start: number, end: number];
  /** Change summary if this is a modified file */
  change?: { added: number; removed: number };
}

/** File diff summary */
export interface DiffPart {
  kind: "diff";
  path: string;
  added: number;
  removed: number;
  /** Original file URI (for multi-diff views) */
  originalPath?: string;
}

/** File tree node */
export interface TreeNode {
  label: string;
  type: "file" | "directory";
  path?: string;
  children?: TreeNode[];
}

export interface TreePart {
  kind: "tree";
  label: string;
  children: TreeNode[];
}

/** Clickable button / action */
export interface ButtonPart {
  kind: "button";
  label: string;
  /** Action identifier — frontends handle based on this */
  action: string;
  /** Additional data for the action */
  data?: Record<string, unknown>;
  /** Visual style hint */
  style?: "primary" | "secondary" | "danger";
}

/** Progress indicator */
export interface ProgressPart {
  kind: "progress";
  message: string;
  /** 0-100 if deterministic, undefined if indeterminate */
  percent?: number;
  /** Elapsed time in milliseconds */
  elapsedMs?: number;
}

/** Inline image */
export interface ImagePart {
  kind: "image";
  url: string;
  alt?: string;
}

/** Hyperlink / anchor */
export interface AnchorPart {
  kind: "anchor";
  uri: string;
  title: string;
}

/** Structured table (for tabular data without markdown) */
export interface TablePart {
  kind: "table";
  headers: string[];
  rows: string[][];
}

// =============================================================================
// Tool invocation state machine
//
// Tool calls are NOT single events — they have a lifecycle.
// Each state transition is sent as a delta update referencing the tool's toolId.
//
// Lifecycle:
//   streaming → waiting_confirmation → executing → completed
//                                   → cancelled
//
// Inspired by VS Code's IChatToolInvocation.StateKind.
// =============================================================================

export type ToolPhase =
  | "streaming"              // LM is still generating the tool call input
  | "waiting_confirmation"   // Awaiting user approval
  | "executing"              // Tool is running
  | "completed"              // Tool finished (success or error)
  | "cancelled";             // User denied or interrupted

export type ToolState =
  | ToolStreamingState
  | ToolWaitingConfirmationState
  | ToolExecutingState
  | ToolCompletedState
  | ToolCancelledState;

export interface ToolStreamingState {
  phase: "streaming";
  /** Partial input as the LM generates it */
  partialInput?: unknown;
}

export interface ToolWaitingConfirmationState {
  phase: "waiting_confirmation";
  /** Complete tool input */
  input: unknown;
  /** Human-readable description of what the tool will do */
  description: string;
  /** Unique ID for this confirmation — client responds with this */
  approvalId: string;
}

export interface ToolExecutingState {
  phase: "executing";
  /** Progress message from the tool */
  progress?: string;
  /** Elapsed time in milliseconds */
  elapsedMs?: number;
}

export interface ToolCompletedState {
  phase: "completed";
  success: boolean;
  /** Tool output (may be truncated for large outputs) */
  output?: string;
  /** Elapsed time in milliseconds */
  elapsedMs?: number;
  /** How the tool was confirmed */
  confirmedBy?: "user" | "auto" | "setting";
}

export interface ToolCancelledState {
  phase: "cancelled";
  reason: "denied" | "interrupted" | "timeout";
  /** Optional explanation */
  message?: string;
}

/** Tool call metadata on a session message */
export interface ToolInfo {
  /** Unique ID for this tool invocation — correlate updates via this */
  toolId: string;
  /** Tool name (e.g. "Bash", "Read", "Edit") */
  name: string;
  /** Current state */
  state: ToolState;
}

// =============================================================================
// Session messages — the core of the protocol.
// =============================================================================

/**
 * A complete session message. Self-contained, serializable, auditable.
 *
 * Every message carries:
 *   - `role` — what kind of message (user, assistant, tool_call, etc.)
 *   - `content` — string fallback for simple frontends
 *   - `parts` — rich content for capable frontends
 *   - `identity` — who produced this message
 *   - `tool` — tool lifecycle (only for role=tool_call)
 *   - `messageId` — unique, for delta updates and cross-references
 */
export interface SessionMessage {
  type: "session.message";
  sessionId: string;
  /** Unique message ID — used by deltas to reference this message */
  messageId: string;
  role: MessageRole;
  /** Plain text content — always present, usable by any frontend */
  content: string;
  /** Rich content parts — optional, for frontends that support them */
  parts?: ContentPart[];
  /** Who produced this message */
  identity: MessageIdentity;
  /** Tool invocation metadata (only when role=tool_call) */
  tool?: ToolInfo;
  /** Extensible metadata — frontends ignore unknown keys */
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Incremental update to an existing message.
 *
 * For streaming: the assistant's response arrives token by token.
 * For tool lifecycle: tool state transitions (executing → completed).
 *
 * Frontends apply deltas to the message with matching messageId.
 * If a frontend doesn't have the message (late attach), it can ignore deltas
 * and rely on the scrollback replay to get the complete state.
 */
export interface SessionMessageDelta {
  type: "session.message.delta";
  sessionId: string;
  /** References the original SessionMessage.messageId */
  messageId: string;
  /** Append to the content string */
  contentAppend?: string;
  /** Append new content parts */
  partsAppend?: ContentPart[];
  /** Replace content parts at a specific index */
  partsUpdate?: { index: number; part: ContentPart }[];
  /** Update tool state (state machine transition) */
  toolStateUpdate?: ToolState;
  timestamp: string;
}

// =============================================================================
// Client → Daemon messages
// =============================================================================

export type ClientMessage =
  | SessionCreateMsg
  | SessionListMsg
  | SessionAttachMsg
  | SessionDetachMsg
  | SessionSendMsg
  | SessionInterruptMsg
  | SessionApproveMsg
  | SessionDestroyMsg
  | SessionSetModeMsg
  | SessionPinMsg
  | SessionUnpinMsg;

interface BaseClientMsg {
  /** Request ID for correlating responses */
  id: string;
}

export interface SessionCreateMsg extends BaseClientMsg {
  type: "session.create";
  name: string;
  workdir: string;
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
  /**
   * One-shot attachments for this turn only. Daemon resolves each path
   * (relative to the session's workdir), reads and prepends the content
   * to the effective prompt. Missing or oversized files are surfaced as
   * inline error markers rather than silently dropped.
   */
  attachments?: Attachment[];
}

export interface Attachment {
  /** File path, absolute or relative to the session workdir. */
  path: string;
  /**
   * Optional inlined content. When provided, daemon skips the file read
   * and uses this directly — useful for paste-from-clipboard flows or
   * remote editors that push the bytes over the wire.
   */
  content?: string;
}

export interface SessionInterruptMsg extends BaseClientMsg {
  type: "session.interrupt";
  sessionId: string;
}

export interface SessionApproveMsg extends BaseClientMsg {
  type: "session.approve";
  sessionId: string;
  /** Correlates to ToolWaitingConfirmationState.approvalId */
  approvalId: string;
  approved: boolean;
}

export interface SessionDestroyMsg extends BaseClientMsg {
  type: "session.destroy";
  sessionId: string;
}

export interface SessionSetModeMsg extends BaseClientMsg {
  type: "session.set_mode";
  sessionId: string;
  mode: SessionMode;
  /** Only meaningful for `autonomous`; undefined = unbounded. */
  maxTurns?: number;
}

/**
 * Manage the session's pinned-files list. Pinned files get prepended to
 * every turn until unpinned — useful for keeping a spec document or
 * acceptance criteria in Claude's attention across a long task.
 */
export interface SessionPinMsg extends BaseClientMsg {
  type: "session.pin";
  sessionId: string;
  /** File path (absolute or relative to the session workdir). */
  path: string;
}

export interface SessionUnpinMsg extends BaseClientMsg {
  type: "session.unpin";
  sessionId: string;
  path: string;
}

// =============================================================================
// Daemon → Client messages
// =============================================================================

export type DaemonMessage =
  | AuthOkMsg
  | ResponseOkMsg
  | ResponseErrorMsg
  | SessionListResultMsg
  | SessionMessage
  | SessionMessageDelta
  | SessionStatusChangeMsg
  | SessionInfoUpdateMsg
  | ScrollbackReplayMsg;

export interface AuthOkMsg {
  type: "auth.ok";
  /** Authenticated identity */
  identity: MessageIdentity;
  scopes: readonly string[];
}

export interface ResponseOkMsg {
  type: "response.ok";
  requestId: string;
  data?: unknown;
}

export interface ResponseErrorMsg {
  type: "response.error";
  requestId: string;
  error: string;
  code: ErrorCode;
}

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "internal";

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

/**
 * Broadcast when non-status fields of a SessionInfo change (e.g. execution
 * mode, turns-remaining). Carries the full updated SessionInfo so clients
 * can merge without a separate list refresh.
 */
export interface SessionInfoUpdateMsg {
  type: "session.info_update";
  session: SessionInfo;
  timestamp: string;
}

/**
 * Sent on client attach — replays recent session messages so the
 * client sees what happened while disconnected (device handoff).
 *
 * Contains full SessionMessage objects (not deltas). The scrollback
 * buffer merges deltas into complete messages before replay.
 */
export interface ScrollbackReplayMsg {
  type: "scrollback.replay";
  sessionId: string;
  messages: SessionMessage[];
}

// =============================================================================
// Auth context — attached to every verified connection
// =============================================================================

export interface AuthContext {
  /** ZeroID subject URI (WIMSE) */
  sub: string;
  /** Human-readable name */
  name?: string;
  /** Granted scopes for this connection */
  scopes: readonly Scope[];
  /** Delegation depth (0 = direct, >0 = delegated) */
  delegationDepth: number;
  /** Who delegated (if delegated) */
  delegatedBy?: string;
  /** Account ID (multi-tenant) */
  accountId: string;
  /** Project ID */
  projectId: string;
}

/**
 * Convert an AuthContext to a MessageIdentity.
 * Uses delegation depth to infer identity type.
 */
export function authToIdentity(auth: AuthContext): MessageIdentity {
  return {
    sub: auth.sub,
    name: auth.name,
    type: auth.delegationDepth === 0 ? "human" : "agent",
  };
}
