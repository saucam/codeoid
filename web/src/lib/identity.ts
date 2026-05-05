/**
 * Identity helpers — surface ZeroID provenance everywhere the TUI does.
 *
 * Every message carries a `MessageIdentity { sub, name?, type }` from the
 * daemon. The web UI must render the *real* label (name or short sub),
 * not a generic "you" / "agent". The full WIMSE URI stays available on
 * hover / click as proof of provenance.
 */

import type { IdentityType, MessageIdentity, SessionInfo } from "../protocol/types";

/**
 * Last path segment of a SPIFFE / WIMSE URI.
 *
 *   spiffe://highflame.ai/acct/proj/agent/codeoid-session-abc → codeoid-session-abc
 *   anonymous:session:abc → abc
 *   you@example.com       → you@example.com (passthrough)
 */
export function shortSub(uri: string | null | undefined): string {
  if (!uri) return "—";
  // Anonymous markers: anonymous:<kind>:<id>
  if (uri.startsWith("anonymous:")) {
    const tail = uri.split(":").pop();
    return tail || uri;
  }
  // SPIFFE / WIMSE: take everything after the last "/".
  const slashIdx = uri.lastIndexOf("/");
  if (slashIdx >= 0 && slashIdx < uri.length - 1) {
    return uri.slice(slashIdx + 1);
  }
  return uri;
}

/** Display label for an identity — name when present, else short sub. */
export function identityLabel(id: MessageIdentity | null | undefined): string {
  if (!id) return "—";
  if (id.name && id.name.trim().length > 0) return id.name.trim();
  return shortSub(id.sub);
}

/**
 * Truncate a WIMSE URI for inline display while keeping the head + tail
 * visible — e.g. `spiffe://highflame.ai/.../agent/codeoid-session-abc`.
 * The full URI stays available via the title attribute / hover popover.
 */
export function truncateWimseUri(uri: string, headChars = 24, tailChars = 28): string {
  if (uri.length <= headChars + tailChars + 3) return uri;
  return `${uri.slice(0, headChars)}…${uri.slice(-tailChars)}`;
}

/** Tailwind classes for the role pill — match the TUI palette intent. */
export function roleColorClass(role: string): string {
  switch (role) {
    case "user":
      return "text-role-user";
    case "assistant":
      return "text-role-assistant";
    case "tool_call":
    case "tool_result":
      return "text-role-tool";
    case "thinking":
      return "text-role-thinking";
    case "system":
      return "text-danger";
    case "info":
    default:
      return "text-fg-faint";
  }
}

/** Tailwind classes for an identity type — applied to the identity name. */
export function identityColorClass(type: IdentityType | null | undefined): string {
  switch (type) {
    case "human":
      return "text-role-user";
    case "agent":
      return "text-role-assistant";
    case "subagent":
      return "text-role-tool";
    case "system":
      return "text-fg-faint";
    default:
      return "text-fg-muted";
  }
}

/**
 * One-liner provenance for a session — agent URI when registered, else
 * a clearly-marked "anonymous". Used by the session header.
 */
export function sessionAgentLabel(s: SessionInfo): string {
  if (!s.agentUri) return "anonymous session";
  if (s.agentUri.startsWith("anonymous:")) return "anonymous session";
  return shortSub(s.agentUri);
}
