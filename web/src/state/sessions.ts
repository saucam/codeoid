/**
 * Sessions store. Daemon-canonical: signals are pure projections of the
 * `session.list.result` + `session.info_update` + `session.status_change`
 * broadcasts. Local mutations are forbidden — the store is read-only to
 * components except via the action functions in this module, which only
 * exist so the connection layer can ingest broadcasts.
 */

import { batch, createMemo, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";

import type { SessionInfo, SessionStatus } from "../protocol/types";
import { clearSessionMessages, setFocusedSessionAccessor } from "./messages";

interface SessionsState {
  byId: Record<string, SessionInfo>;
}

const [state, setState] = createStore<SessionsState>({ byId: {} });
const [focusedId, setFocusedId] = createSignal<string | null>(null);

/** Sorted list — most recent activity first. */
export const sessionList = createMemo<SessionInfo[]>(() => {
  const items = Object.values(state.byId);
  items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return items;
});

/** Currently-focused session id (null if none). */
export const focusedSessionId = focusedId;

// Wire the singleton focused-messages memo in messages.ts. Done once
// at module load so all consumers can pull the shared accessor
// instead of each one creating its own memo.
setFocusedSessionAccessor(focusedSessionId);

/** Currently-focused session record (null if missing or none focused). */
export const focusedSession = createMemo<SessionInfo | null>(() => {
  const id = focusedId();
  if (!id) return null;
  return state.byId[id] ?? null;
});

/** Look up by id without subscribing the caller. */
export function getSession(id: string): SessionInfo | undefined {
  return state.byId[id];
}

/** Snapshot of the full id-keyed map (read-only). */
export function sessionsSnapshot(): Readonly<Record<string, SessionInfo>> {
  return state.byId;
}

// ---------- broadcast ingest ----------

/** Replace the entire list with the daemon's authoritative payload. */
export function ingestSessionList(items: readonly SessionInfo[]): void {
  batch(() => {
    setState(
      produce<SessionsState>((s) => {
        const next: Record<string, SessionInfo> = {};
        for (const it of items) next[it.id] = it;
        s.byId = next;
      }),
    );
    // Auto-focus the most recently-created session if nothing is focused.
    const cur = focusedId();
    if (!cur || !state.byId[cur]) {
      const sorted = [...items].sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      );
      setFocusedId(sorted[0]?.id ?? null);
    }
  });
}

/**
 * Merge a partial or full session info into the store. Used for
 * `session.info_update` (full) and `session.status_change` (partial —
 * we patch only the status field).
 *
 * `next` may be a full SessionInfo or a partial with at least `id`.
 */
export function mergeSession(next: Partial<SessionInfo> & { id: string }): void {
  setState(
    "byId",
    next.id,
    produce<SessionInfo>((s) => {
      // If the entry doesn't exist, create it from `next` (caller must
      // have provided enough fields). Solid's produce requires `s` to be
      // an object even on first write — we're inside the byId proxy
      // path, so `s` materialises lazily.
      Object.assign(s ?? ({} as SessionInfo), next);
    }),
  );
}

/** Apply a status-only update from `session.status_change`. */
export function setSessionStatus(id: string, status: SessionStatus): void {
  if (!state.byId[id]) return;
  setState("byId", id, "status", status);
}

export function removeSession(id: string): void {
  clearSessionMessages(id);
  batch(() => {
    setState(
      "byId",
      produce<Record<string, SessionInfo>>((m) => {
        delete m[id];
      }),
    );
    if (focusedId() === id) {
      const remaining = sessionList();
      setFocusedId(remaining[0]?.id ?? null);
    }
  });
}

// ---------- focus actions ----------

export function focusSession(id: string | null): void {
  setFocusedId(id);
}

export function focusNext(): void {
  const list = sessionList();
  if (list.length === 0) return;
  const cur = focusedId();
  const idx = list.findIndex((s) => s.id === cur);
  const next = list[(idx + 1) % list.length];
  if (next) setFocusedId(next.id);
}

export function focusPrev(): void {
  const list = sessionList();
  if (list.length === 0) return;
  const cur = focusedId();
  const idx = list.findIndex((s) => s.id === cur);
  const prev = list[(idx - 1 + list.length) % list.length];
  if (prev) setFocusedId(prev.id);
}

// Test hook — reset the entire store between tests.
export function _resetSessionsForTest(): void {
  batch(() => {
    setState({ byId: {} });
    setFocusedId(null);
  });
}
