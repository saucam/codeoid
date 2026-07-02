/**
 * Per-session message store + delta reducer.
 *
 * Mirrors the Rust TUI's `MessageStore` semantics:
 *   - upsert by `messageId` so re-broadcasts and replays are idempotent
 *   - `applyDelta` patches `content`, `parts`, `tool.state`, `timestamp`
 *   - `version` map bumped on every mutation so downstream renderers can
 *     short-circuit cache reads
 *   - `replaceScrollback` runs on attach / re-attach with the daemon's
 *     authoritative replay
 *
 * Pure SolidJS — components subscribe via `messagesFor(sessionId)` (a
 * memoised slice). The reducer never sees the WS layer; the connection
 * module wires broadcasts in.
 */

import { batch, createMemo } from "solid-js";
import { createStore, produce } from "solid-js/store";

import type {
  ContentPart,
  SessionMessage,
  SessionMessageDelta,
  ToolState,
} from "../protocol/types";

interface MessagesState {
  /** sessionId -> messages array (in arrival order). */
  bySession: Record<string, SessionMessage[]>;
  /** messageId -> monotonic version counter. */
  versions: Record<string, number>;
  /**
   * Per-session epoch counter, bumped on EVERY mutation that touches a
   * session — including in-place delta patches. Use this signal to
   * trigger effects that need to re-fire on streaming content updates,
   * not just on array-reference changes (Solid's store reactivity is
   * path-grained, so mutating `buf[idx].content` in place won't
   * re-trigger an `on(messages, …)` effect).
   */
  epochBySession: Record<string, number>;
}

const [state, setState] = createStore<MessagesState>({
  bySession: {},
  versions: {},
  epochBySession: {},
});

// O(1) existence index — maintained in parallel with bySession so
// applyDelta can skip the O(N) buf.some() scan on every streaming delta.
// Stored outside the Solid store (plain Map) so mutations don't create
// fine-grained reactive overhead; hasMessage intentionally reads it
// without tracking.
const idsBySession = new Map<string, Set<string>>();

/** Reactive slice — components consume this. */
export function messagesFor(sessionId: string): SessionMessage[] {
  return state.bySession[sessionId] ?? EMPTY;
}

/** Reactive memo — same as messagesFor but for use inside JSX `<For each>`. */
export function createMessages(sessionId: () => string | null) {
  return createMemo<SessionMessage[]>(() => {
    const id = sessionId();
    return id ? state.bySession[id] ?? EMPTY : EMPTY;
  });
}

/**
 * Singleton memo for the focused session's messages.
 *
 * Multiple components (Transcript, ApprovalBar, WorkerIndicator,
 * desktop-notifications) used to each call `createMessages(
 * focusedSessionId)`, instantiating four separate memos that
 * recomputed on every delta and each held their own subscriber. This
 * shared accessor is the single computation; consumers all hang off
 * one node in the dependency graph instead of four.
 *
 * Wiring runs once via `setFocusedSessionAccessor()` from `sessions.ts`
 * during its module-init so we avoid a top-level import cycle (this
 * file holds the message store; `sessions.ts` already pokes at it on
 * session-destroy and would otherwise import-back).
 */
let focusedSessionIdAccessor: (() => string | null) | null = null;
let focusedMessagesMemo: (() => SessionMessage[]) | null = null;
export function setFocusedSessionAccessor(fn: () => string | null): void {
  focusedSessionIdAccessor = fn;
  focusedMessagesMemo = null; // re-bind on next call
}
export function focusedSessionMessages(): SessionMessage[] {
  if (!focusedSessionIdAccessor) return EMPTY;
  if (!focusedMessagesMemo) {
    focusedMessagesMemo = createMessages(focusedSessionIdAccessor);
  }
  return focusedMessagesMemo();
}

/** Monotonic version for a message (cache key). 0 = never seen. */
export function versionOf(messageId: string): number {
  return state.versions[messageId] ?? 0;
}

/**
 * Per-session epoch — reactive. Bumped on every applyMessage /
 * applyDelta / replaceScrollback so effects keyed on this signal
 * re-fire even when in-place mutation leaves the array reference
 * unchanged. Use as the trigger for auto-scroll, render-cache
 * invalidation, etc.
 */
export function epochOf(sessionId: string | null | undefined): number {
  if (!sessionId) return 0;
  return state.epochBySession[sessionId] ?? 0;
}

const EMPTY: SessionMessage[] = [];

// ---------- broadcast ingest ----------

export function applyMessage(msg: SessionMessage): void {
  // Keep the O(1) existence index in sync before the store mutation so
  // any concurrent hasMessage call (delta arriving in the same tick) sees
  // the correct answer immediately.
  let idSet = idsBySession.get(msg.sessionId);
  if (!idSet) {
    idSet = new Set();
    idsBySession.set(msg.sessionId, idSet);
  }
  idSet.add(msg.messageId);

  batch(() => {
    setState(
      produce<MessagesState>((s) => {
        const buf = (s.bySession[msg.sessionId] ??= []);
        const existing = buf.findIndex((m) => m.messageId === msg.messageId);
        if (existing >= 0) buf[existing] = msg;
        else buf.push(msg);
        s.versions[msg.messageId] = (s.versions[msg.messageId] ?? 0) + 1;
        s.epochBySession[msg.sessionId] =
          (s.epochBySession[msg.sessionId] ?? 0) + 1;
      }),
    );
  });
}

export function applyDelta(delta: SessionMessageDelta): void {
  // Only mutate if the parent message exists. Stale deltas (delivered
  // before scrollback replay or after eviction) are dropped silently —
  // the daemon's replay will resync us on attach.
  if (!hasMessage(delta.sessionId, delta.messageId)) return;
  batch(() => {
    setState(
      produce<MessagesState>((s) => {
        const buf = s.bySession[delta.sessionId];
        if (!buf) return;
        const idx = buf.findIndex((m) => m.messageId === delta.messageId);
        if (idx < 0) return;
        const target = buf[idx];
        if (!target) return;

        if (delta.contentAppend) {
          target.content = (target.content ?? "") + delta.contentAppend;
        }
        if (delta.partsAppend && delta.partsAppend.length > 0) {
          const parts: ContentPart[] = target.parts ? [...target.parts] : [];
          parts.push(...delta.partsAppend);
          target.parts = parts;
        }
        if (delta.partsUpdate && delta.partsUpdate.length > 0) {
          const parts: ContentPart[] = target.parts ? [...target.parts] : [];
          for (const upd of delta.partsUpdate) {
            const i = upd.index;
            if (i >= 0 && i < parts.length) parts[i] = upd.part;
            else parts.push(upd.part);
          }
          target.parts = parts;
        }
        if (delta.toolStateUpdate && target.tool) {
          // ToolState is a discriminated union; assigning replaces wholesale.
          target.tool = { ...target.tool, state: delta.toolStateUpdate satisfies ToolState };
        }
        target.timestamp = delta.timestamp;

        s.versions[delta.messageId] = (s.versions[delta.messageId] ?? 0) + 1;
        s.epochBySession[delta.sessionId] =
          (s.epochBySession[delta.sessionId] ?? 0) + 1;
      }),
    );
  });
}

export function replaceScrollback(sessionId: string, messages: readonly SessionMessage[]): void {
  // Defensive dedupe by messageId — the daemon can replay duplicate entries
  // for the same messageId (known daemon bug, fixed separately). Mirror the
  // upsert semantics of applyMessage: the message keeps the position of its
  // FIRST occurrence, but the LAST occurrence's content wins.
  const deduped: SessionMessage[] = [];
  const posById = new Map<string, number>();
  for (const m of messages) {
    const at = posById.get(m.messageId);
    if (at !== undefined) {
      deduped[at] = m;
    } else {
      posById.set(m.messageId, deduped.length);
      deduped.push(m);
    }
  }

  // Rebuild the O(1) existence index for this session before touching the
  // store — applyDelta calls hasMessage which reads idsBySession directly.
  idsBySession.set(sessionId, new Set(posById.keys()));

  batch(() => {
    setState(
      produce<MessagesState>((s) => {
        s.bySession[sessionId] = deduped;
        // Per-message version bumps are intentionally omitted here. A full
        // scrollback replay replaces the array reference entirely — the
        // session epoch bump below is the cache-invalidation signal for
        // session-level consumers. Bumping N individual version counters
        // inside produce() creates O(N) fine-grained store mutations that
        // slow down large replays without any downstream benefit (versionOf
        // is not used in any render path).
        s.epochBySession[sessionId] = (s.epochBySession[sessionId] ?? 0) + 1;
      }),
    );
  });
}

/** Check whether a (sessionId, messageId) pair exists in the store. O(1). */
export function hasMessage(sessionId: string, messageId: string): boolean {
  return idsBySession.get(sessionId)?.has(messageId) ?? false;
}

/**
 * Session-destroy cache pruners. Components holding per-message caches
 * keyed by `${sessionId}:${messageId}` (e.g. the Transcript virtualizer's
 * itemSizeCache) register here so a DESTROYED session's keys are evicted.
 * Deliberately NOT invoked on mere focus switches — caches surviving
 * revisits is a feature (#73).
 */
type SessionCachePruner = (sessionId: string) => void;
const sessionCachePruners = new Set<SessionCachePruner>();
export function registerSessionCachePruner(fn: SessionCachePruner): () => void {
  sessionCachePruners.add(fn);
  return () => sessionCachePruners.delete(fn);
}

/**
 * Remove all message state for a session. Call when a session is destroyed
 * so its entries don't accumulate in memory indefinitely.
 */
export function clearSessionMessages(sessionId: string): void {
  const ids = idsBySession.get(sessionId);
  idsBySession.delete(sessionId);
  batch(() => {
    setState(
      produce<MessagesState>((s) => {
        // Per-message version counters are keyed by messageId, not by
        // session — without this loop they leak for every destroyed
        // session's messages.
        if (ids) {
          for (const id of ids) delete s.versions[id];
        }
        delete s.bySession[sessionId];
        delete s.epochBySession[sessionId];
      }),
    );
  });
  for (const prune of sessionCachePruners) {
    try {
      prune(sessionId);
    } catch (err) {
      console.warn("[codeoid] session cache pruner failed:", err);
    }
  }
}

// Test hook — reset the entire store between tests.
export function _resetMessagesForTest(): void {
  setState({ bySession: {}, versions: {}, epochBySession: {} });
  idsBySession.clear();
}
