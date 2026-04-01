import type { Scope } from "./scopes.js";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type SessionStatus = "idle" | "working" | "waiting_approval" | "error";

export interface SessionInfo {
  id: string;
  name: string;
  workdir: string;
  status: SessionStatus;
  createdBy: string; // ZeroID subject URI
  createdAt: string; // ISO 8601
  attachedClients: number;
}

// ---------------------------------------------------------------------------
// Client → Daemon messages
// ---------------------------------------------------------------------------

export type ClientMessage =
  | SessionCreateMsg
  | SessionListMsg
  | SessionAttachMsg
  | SessionDetachMsg
  | SessionSendMsg
  | SessionInterruptMsg
  | SessionApproveMsg
  | SessionDestroyMsg;

interface BaseClientMsg {
  id: string; // request ID for correlating responses
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
}

export interface SessionInterruptMsg extends BaseClientMsg {
  type: "session.interrupt";
  sessionId: string;
}

export interface SessionApproveMsg extends BaseClientMsg {
  type: "session.approve";
  sessionId: string;
  /** JSON-RPC style: correlate to the specific approval request. */
  requestId: string;
  approved: boolean;
}

export interface SessionDestroyMsg extends BaseClientMsg {
  type: "session.destroy";
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Daemon → Client messages
// ---------------------------------------------------------------------------

export type DaemonMessage =
  | AuthOkMsg
  | ResponseOkMsg
  | ResponseErrorMsg
  | SessionListResultMsg
  | SessionMessageMsg
  | AgentApprovalRequestMsg
  | AgentStatusChangeMsg
  | ScrollbackReplayMsg;

export interface AuthOkMsg {
  type: "auth.ok";
  sub: string;
  name?: string;
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

// ---------------------------------------------------------------------------
// Session messages — the core content protocol.
//
// Every piece of content in a session is a SessionMessageMsg with a `role`
// and structured `content`. This is extensible — new roles and content types
// can be added without breaking existing frontends.
// ---------------------------------------------------------------------------

/** Roles that produce messages. Extensible — add new roles as needed. */
export type MessageRole =
  | "user"        // Human sent a prompt
  | "assistant"   // Agent's text response
  | "tool_call"   // Agent invoked a tool
  | "tool_result" // Tool execution result
  | "system"      // System-generated (errors, retries, status)
  | "info";       // Informational (session events, agent identity changes)

/**
 * Unified message type for all session content.
 * Frontends render based on `role` — each role gets distinct styling.
 */
export interface SessionMessageMsg {
  type: "session.message";
  sessionId: string;
  role: MessageRole;
  /** Primary text content. */
  content: string;
  /** Structured metadata — varies by role. Frontends can use or ignore. */
  metadata?: MessageMetadata;
  /** ISO 8601 timestamp. */
  timestamp: string;
}

/** Role-specific metadata. All fields optional — frontends degrade gracefully. */
export interface MessageMetadata {
  /** For role=user: the ZeroID subject who sent it. */
  sender?: string;
  /** For role=user: human-readable sender name. */
  senderName?: string;
  /** For role=tool_call: tool name. */
  tool?: string;
  /** For role=tool_call: tool input as JSON string. */
  toolInput?: string;
  /** For role=tool_call: human-readable description of what the tool does. */
  toolDescription?: string;
  /** For role=tool_result: whether the tool succeeded. */
  toolSuccess?: boolean;
  /** For role=system: error code if applicable. */
  errorCode?: string;
  /** For role=info: event type (e.g. "identity.registered", "retry"). */
  event?: string;
}

/**
 * Permission request with JSON-RPC correlation.
 * Each request has a unique approvalId. Clients respond with session.approve
 * referencing that approvalId. First response wins.
 */
export interface AgentApprovalRequestMsg {
  type: "agent.approval_request";
  sessionId: string;
  approvalId: string;
  tool: string;
  input: string;
  description?: string;
  timestamp: string;
}

export interface AgentStatusChangeMsg {
  type: "agent.status_change";
  sessionId: string;
  status: SessionStatus;
  timestamp: string;
}

/**
 * Sent on client attach — replays recent session messages so the
 * client sees what happened while disconnected (device handoff).
 */
export interface ScrollbackReplayMsg {
  type: "scrollback.replay";
  sessionId: string;
  messages: DaemonMessage[];
}

// ---------------------------------------------------------------------------
// Auth context attached to every verified connection
// ---------------------------------------------------------------------------

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
