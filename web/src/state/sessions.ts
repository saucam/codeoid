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

/** Cheap deep equality for small JSON-shaped values (session list fields). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false; // primitives were already compared by reference
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Sync the store to the daemon's authoritative payload.
 *
 * Merges PER-ID instead of wholesale-replacing `byId`: unchanged sessions
 * keep their store object identity, so Solid's fine-grained reactivity
 * doesn't tear down and re-create every SessionRow on each periodic
 * refresh — only fields that actually changed trigger updates.
 */
export function ingestSessionList(items: readonly SessionInfo[]): void {
  batch(() => {
    setState(
      produce<SessionsState>((s) => {
        const seen = new Set<string>();
        for (const it of items) {
          seen.add(it.id);
          const existing = s.byId[it.id];
          if (!existing) {
            s.byId[it.id] = it;
            continue;
          }
          // Update changed fields in place. Skip prototype-polluting keys:
          // the payload is network-sourced and JSON.parse produces
          // "__proto__" as a plain own property — assigning it through a
          // computed key would rewrite the object's prototype.
          const target = existing as unknown as Record<string, unknown>;
          const source = it as unknown as Record<string, unknown>;
          for (const k of Object.keys(source)) {
            if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
            // Object-valued fields (usage, subagents, pinnedFiles) arrive as
            // fresh references on every list refresh; reassigning them when
            // deep-equal would notify their subscribers for nothing.
            if (target[k] !== source[k] && !jsonEqual(target[k], source[k])) {
              target[k] = source[k];
            }
          }
          // Drop fields the daemon no longer sends (e.g. an optional
          // `model` that was unset). Object.hasOwn (not `in`) so inherited
          // keys like "constructor" can't mask a legitimate delete.
          for (const k of Object.keys(target)) {
            if (!Object.hasOwn(source, k)) delete target[k];
          }
        }
        // Delete sessions missing from the authoritative list.
        for (const id of Object.keys(s.byId)) {
          if (!seen.has(id)) delete s.byId[id];
        }
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
  batch(() => {
    clearSessionMessages(id);
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
