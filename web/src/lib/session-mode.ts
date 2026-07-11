/**
 * Session execution-mode helpers.
 *
 * The daemon boots every session in `guarded` (src/daemon/session.ts:
 * `#mode = "guarded"`), and `SessionInfo.mode` is optional on the wire for
 * legacy daemons that predate it. Every "mode missing → show something"
 * fallback must therefore say "guarded" — three call sites independently
 * defaulted to "interactive" and misreported the daemon's actual behaviour.
 */

import type { SessionInfo, SessionMode } from "../protocol/types";

/** Daemon-canonical default mode for sessions that don't report one. */
export const DEFAULT_SESSION_MODE: SessionMode = "guarded";

/** The mode a session is effectively running in, per the daemon's default. */
export function effectiveMode(s: SessionInfo | undefined | null): SessionMode {
  return s?.mode ?? DEFAULT_SESSION_MODE;
}
