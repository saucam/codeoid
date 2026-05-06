/**
 * Cross-component handoff for "jump to a specific match after search."
 *
 * SearchModal sets a pending target (sessionId + the query/excerpt to look
 * for); the Transcript component watches both this signal and the
 * messages stream for that session, and once it can find a message whose
 * content contains the query (or, failing that, the snippet's excerpt
 * substring), it scrolls that row into view, briefly highlights it, and
 * clears the pending target. If no match shows up within a small window
 * after attach (the daemon's replay can race), we give up silently — the
 * user still ended up on the right session, just not the right row.
 */
import { createSignal } from "solid-js";

export interface PendingSearchJump {
  sessionId: string;
  /** The exact user-typed query — preferred matcher. */
  query: string;
  /** The snippet excerpt the daemon returned — fallback matcher. */
  excerpt?: string;
  /** Wall-clock ms when the jump was queued, used to expire stale jumps. */
  setAt: number;
}

const [pendingSearchJump, setPendingSearchJumpSignal] =
  createSignal<PendingSearchJump | null>(null);

export { pendingSearchJump };

export function setPendingSearchJump(
  jump: Omit<PendingSearchJump, "setAt"> | null,
): void {
  setPendingSearchJumpSignal(jump ? { ...jump, setAt: Date.now() } : null);
}

/**
 * Pick the best message to scroll to. Returns the messageId if a confident
 * match is found, else null. Matching is case-insensitive substring on
 * `content`; we walk newest-first so the most recent match wins (search
 * results are ranked by recency anyway).
 */
export function findJumpTarget(
  messages: ReadonlyArray<{ messageId: string; content: string }>,
  jump: PendingSearchJump,
): string | null {
  const query = jump.query.trim().toLowerCase();
  const excerpt = jump.excerpt?.trim().toLowerCase() ?? "";
  if (!query && !excerpt) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const c = (m.content ?? "").toLowerCase();
    if (query && c.includes(query)) return m.messageId;
  }
  if (excerpt) {
    // Excerpts often contain ellipsis or truncated highlights — try a
    // shorter prefix to give the substring search a fair shot.
    const probe = excerpt.slice(0, Math.min(40, excerpt.length));
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m) continue;
      const c = (m.content ?? "").toLowerCase();
      if (c.includes(probe)) return m.messageId;
    }
  }
  return null;
}
