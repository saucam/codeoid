/**
 * Per-session attach lifecycle + older-history paging state (#152).
 *
 * Attach used to be fire-and-forget: `App.tsx` dispatched `session.attach`
 * and failures were only console.warn'd, so the transcript's empty-state
 * ("No messages yet") showed while a large scrollback replay was still in
 * flight — and forever after a failed attach. This store tracks the
 * lifecycle per session:
 *
 *   idle → pending (attach dispatched)
 *        → settled (first `scrollback.replay` frame, or the attach
 *                   response for empty sessions, which get no frame)
 *        → failed  (attach request rejected; error retained for the UI)
 *
 * It also owns the `scrollback.paging` client state: whether older history
 * exists beyond the tail-first replay window (`hasOlderHistory`, from the
 * replay frame's `tail`/`hasMore`), plus busy/error signals for the
 * `scrollback.page` backfill fetch (`loadOlderHistory`).
 *
 * Import direction: `connection.ts` statically imports this module (to note
 * replay frames in `routeBroadcast`), so the transport is reached via a
 * dynamic `import("./connection")` — the same cycle-avoidance pattern
 * connection.ts itself uses for `models.ts`.
 */

import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";

import type {
  ScrollbackPageResultMsg,
  ScrollbackReplayMsg,
  SessionInfo,
} from "../protocol/types";

import { messagesFor, prependMessages } from "./messages";

export type AttachPhase = "idle" | "pending" | "settled" | "failed";

interface AttachEntry {
  phase: AttachPhase;
  /** Attach failure reason (phase === "failed"). */
  error: string | null;
  /** True when history older than the replayed tail window exists
   * (`scrollback.replay` with `tail: true` + `hasMore: true`). */
  hasOlderHistory: boolean;
  /** A `scrollback.page` backfill request is in flight. */
  pagingBusy: boolean;
  /** Last backfill failure reason (cleared on the next attempt). */
  pagingError: string | null;
}

const DEFAULT_ENTRY: AttachEntry = {
  phase: "idle",
  error: null,
  hasOlderHistory: false,
  pagingBusy: false,
  pagingError: null,
};

const [state, setState] = createStore<Record<string, AttachEntry>>({});

function patch(sessionId: string, p: Partial<AttachEntry>): void {
  setState(
    produce((s) => {
      const entry = (s[sessionId] ??= { ...DEFAULT_ENTRY });
      Object.assign(entry, p);
    }),
  );
}

// ---------- reactive accessors ----------

export function attachState(sessionId: string | null | undefined): AttachPhase {
  return sessionId ? state[sessionId]?.phase ?? "idle" : "idle";
}

export function attachError(sessionId: string | null | undefined): string | null {
  return sessionId ? state[sessionId]?.error ?? null : null;
}

export function hasOlderHistory(sessionId: string | null | undefined): boolean {
  return sessionId ? state[sessionId]?.hasOlderHistory ?? false : false;
}

export function pagingBusy(sessionId: string | null | undefined): boolean {
  return sessionId ? state[sessionId]?.pagingBusy ?? false : false;
}

export function pagingError(sessionId: string | null | undefined): string | null {
  return sessionId ? state[sessionId]?.pagingError ?? null : null;
}

/**
 * The OLDEST messageId the client holds for a session — the anchor for the
 * next `scrollback.page`. Computed from the message store: the buffer is
 * ordered oldest→newest (replay order; backfill pages prepend), so the
 * first entry is the oldest. Reactive (reads the store).
 */
export function oldestMessageId(sessionId: string): string | undefined {
  return messagesFor(sessionId)[0]?.messageId;
}

// ---------- attach lifecycle ----------

export function markAttachPending(sessionId: string): void {
  patch(sessionId, { phase: "pending", error: null });
}

export function markAttachSettled(sessionId: string): void {
  patch(sessionId, { phase: "settled", error: null });
}

export function markAttachFailed(sessionId: string, error: string): void {
  patch(sessionId, { phase: "failed", error });
}

/**
 * Called by connection routing for EVERY `scrollback.replay` frame. The
 * first frame settles a pending attach (idempotent for later chunks); a
 * tail-first frame (`tail: true`) additionally carries whether older
 * history exists beyond the window. Non-tail frames (legacy daemon, or an
 * incremental resume) leave `hasOlderHistory` untouched.
 */
export function noteAttachReplay(msg: ScrollbackReplayMsg): void {
  const p: Partial<AttachEntry> = { phase: "settled", error: null };
  if (msg.tail === true) p.hasOlderHistory = msg.hasMore === true;
  patch(msg.sessionId, p);
}

/**
 * Dispatch `session.attach` with lifecycle tracking. Resolves with the
 * attach response payload (the session's current SessionInfo) and rethrows
 * failures so the caller (App.tsx) can undo its attached-set bookkeeping.
 *
 * "Settled" latches on EITHER the first `scrollback.replay` frame (which
 * for non-empty sessions arrives before this promise resolves) OR the
 * attach response itself — an empty session with no resume cursor gets no
 * replay frame at all, and would otherwise show "loading transcript…"
 * forever.
 */
export async function attachSession(
  sessionId: string,
  resume?: { key: string; sinceSeq: number },
): Promise<unknown> {
  markAttachPending(sessionId);
  // Dynamic import — see module docblock (connection.ts imports us).
  const { newRequestId, request } = await import("./connection");
  try {
    const data = await request({
      type: "session.attach",
      id: newRequestId(),
      sessionId,
      ...(resume ? { resume } : {}),
    });
    markAttachSettled(sessionId);
    return data as Partial<SessionInfo> | undefined;
  } catch (err) {
    markAttachFailed(sessionId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

// Retry epoch — bumped by the transcript's retry affordance. App.tsx's
// attach effect tracks this signal, so a bump re-runs the dispatch for the
// focused session (its `attached`-set entry was removed on failure). Keeping
// the dispatch in ONE place (App's effect) means retries can't race a
// parallel attach path.
const [retryEpoch, setRetryEpoch] = createSignal(0);
export const attachRetryEpoch = retryEpoch;

export function requestAttachRetry(sessionId: string): void {
  patch(sessionId, { phase: "idle", error: null });
  setRetryEpoch((n) => n + 1);
}

// ---------- older-history backfill ----------

/**
 * Fetch one page of history older than what the client holds and PREPEND it
 * into the message store. Single-flight per session (re-entrant calls while
 * busy are dropped — the IntersectionObserver sentinel can fire repeatedly).
 *
 * `hooks.onBeforePrepend` / `onAfterPrepend` bracket the store mutation
 * synchronously so the caller (Transcript) can capture scroll geometry and
 * restore an anchored position — capturing before the AWAIT would go stale
 * if the user scrolls while the request is in flight.
 */
export async function loadOlderHistory(
  sessionId: string,
  hooks: { onBeforePrepend?: () => void; onAfterPrepend?: () => void } = {},
): Promise<void> {
  if (state[sessionId]?.pagingBusy) return;
  const anchor = oldestMessageId(sessionId);
  if (anchor === undefined) return; // nothing held yet — attach replay owns first paint
  patch(sessionId, { pagingBusy: true, pagingError: null });
  try {
    const { getClient, newRequestId } = await import("./connection");
    const id = newRequestId();
    const result = await getClient().request<ScrollbackPageResultMsg>(
      { type: "scrollback.page", id, sessionId, beforeMessageId: anchor },
      {
        waitForResult: (m) =>
          m.type === "scrollback.page.result" && m.requestId === id ? m : undefined,
      },
    );
    hooks.onBeforePrepend?.();
    prependMessages(sessionId, result.messages ?? []);
    patch(sessionId, { hasOlderHistory: result.hasMore === true });
    hooks.onAfterPrepend?.();
  } catch (err) {
    patch(sessionId, {
      pagingError: err instanceof Error ? err.message : String(err),
    });
  } finally {
    patch(sessionId, { pagingBusy: false });
  }
}

// Test hook — reset the entire store between tests.
export function _resetAttachForTest(): void {
  setState(
    produce((s) => {
      for (const key of Object.keys(s)) delete s[key];
    }),
  );
  setRetryEpoch(0);
}
