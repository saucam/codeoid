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
  | AgentOutputMsg
  | AgentToolCallMsg
  | AgentApprovalRequestMsg
  | AgentStatusChangeMsg;

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
  | "internal";

export interface SessionListResultMsg {
  type: "session.list.result";
  requestId: string;
  sessions: SessionInfo[];
}

export interface AgentOutputMsg {
  type: "agent.output";
  sessionId: string;
  content: string;
  timestamp: string;
}

export interface AgentToolCallMsg {
  type: "agent.tool_call";
  sessionId: string;
  tool: string;
  input: string;
  timestamp: string;
}

export interface AgentApprovalRequestMsg {
  type: "agent.approval_request";
  sessionId: string;
  tool: string;
  input: string;
  timestamp: string;
}

export interface AgentStatusChangeMsg {
  type: "agent.status_change";
  sessionId: string;
  status: SessionStatus;
  timestamp: string;
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
