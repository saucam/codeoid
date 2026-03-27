/**
 * Codeoid permission scopes — mapped to ZeroID OAuth2 scopes.
 *
 * Scopes follow a resource:action pattern and are enforced at the daemon
 * on every inbound message, not just at connection time.
 */

export const SCOPES = {
  /** Create new agent sessions */
  SESSION_CREATE: "session:create",
  /** Attach to a session and receive streaming output */
  SESSION_ATTACH: "session:attach",
  /** Watch session output without ability to send messages */
  SESSION_WATCH: "session:watch",
  /** Send messages / prompts to an attached session */
  SESSION_SEND: "session:send",
  /** Interrupt a running agent mid-execution */
  SESSION_INTERRUPT: "session:interrupt",
  /** Approve or deny permission prompts from the agent */
  SESSION_APPROVE: "session:approve",
  /** Destroy a session and its agent process */
  SESSION_DESTROY: "session:destroy",
  /** List sessions and their status */
  SESSION_LIST: "session:list",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/** All scopes — convenience for admin/owner tokens */
export const ALL_SCOPES: readonly Scope[] = Object.values(SCOPES);

/** Read-only watcher — can list and watch output, nothing else */
export const WATCHER_SCOPES: readonly Scope[] = [
  SCOPES.SESSION_LIST,
  SCOPES.SESSION_WATCH,
];

/** Operator — full control except destroy */
export const OPERATOR_SCOPES: readonly Scope[] = [
  SCOPES.SESSION_LIST,
  SCOPES.SESSION_CREATE,
  SCOPES.SESSION_ATTACH,
  SCOPES.SESSION_WATCH,
  SCOPES.SESSION_SEND,
  SCOPES.SESSION_INTERRUPT,
  SCOPES.SESSION_APPROVE,
];

/** Check if a set of granted scopes includes the required scope */
export function hasScope(granted: readonly string[], required: Scope): boolean {
  return granted.includes(required);
}

/** Check if granted scopes include ALL required scopes */
export function hasAllScopes(
  granted: readonly string[],
  required: readonly Scope[],
): boolean {
  return required.every((s) => granted.includes(s));
}
