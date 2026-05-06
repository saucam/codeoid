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

import { createMemo, untrack } from "solid-js";
import { batch } from "solid-js";
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
  batch(() => {
    setState(
      produce<MessagesState>((s) => {
        s.bySession[sessionId] = [...messages];
        for (const m of messages) {
          s.versions[m.messageId] = (s.versions[m.messageId] ?? 0) + 1;
        }
        s.epochBySession[sessionId] = (s.epochBySession[sessionId] ?? 0) + 1;
      }),
    );
  });
}

/** Check whether a (sessionId, messageId) pair exists in the store. */
export function hasMessage(sessionId: string, messageId: string): boolean {
  return untrack(() => {
    const buf = state.bySession[sessionId];
    return !!buf && buf.some((m) => m.messageId === messageId);
  });
}

// Test hook — reset the entire store between tests.
export function _resetMessagesForTest(): void {
  setState({ bySession: {}, versions: {}, epochBySession: {} });
}
