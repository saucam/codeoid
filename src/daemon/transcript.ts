/**
 * JSONL transcript persistence — enables session resume after daemon restart.
 *
 * Production pattern from Claude Code: sessionStorage.ts
 *
 * Each session gets a JSONL file. Every DaemonMessage broadcast to clients is
 * also appended here. On daemon restart, transcripts are replayed to rebuild
 * the scrollback buffer and session state.
 *
 * Design decisions:
 *   - Write before API call (user messages) so crashes don't lose prompts
 *   - Exclude ephemeral progress events from persistence
 *   - Use append-only JSONL — no reads on the hot path
 */

import { existsSync, mkdirSync } from "node:fs";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonMessage, SessionStatus } from "../protocol/types.js";

/** Persistent entry in the transcript. */
export interface TranscriptEntry {
  /** Monotonic sequence number for ordering. */
  seq: number;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** The message that was broadcast. */
  message: DaemonMessage;
}

/** Session metadata stored alongside transcript for fast resume. */
export interface TranscriptMeta {
  sessionId: string;
  sessionName: string;
  workdir: string;
  createdBy: string;
  createdAt: string;
  lastStatus: SessionStatus;
  lastActivityAt: string;
  accountId: string;
  projectId: string;
}

/** Types we persist. Skip ephemeral events like heartbeats. */
const PERSISTED_TYPES = new Set([
  "session.message",
  "session.status_change",
]);

export class TranscriptStore {
  #dir: string;
  /**
   * Per-session promise chain for `saveMeta`. setStatus fires many
   * times per turn (working → waiting_approval → working → idle),
   * each as a fire-and-forget `saveMeta`; without serialization two
   * overlapping writes interleave the open(O_WRONLY|O_TRUNC) +
   * write sequence, leaving a truncated JSON file. `loadAllMeta`
   * silently drops unparseable files, so the session goes missing
   * on next restart. Chaining + atomic temp+rename eliminates the
   * window.
   */
  #metaWriteChain = new Map<string, Promise<void>>();
  /** Per-session promise chain for `append()`. See append() docs. */
  #appendChain = new Map<string, Promise<void>>();

  constructor(transcriptDir: string) {
    this.#dir = transcriptDir;
    if (!existsSync(this.#dir)) {
      mkdirSync(this.#dir, { recursive: true });
    }
  }

  /** Path to a session's transcript file. */
  transcriptPath(sessionId: string): string {
    return join(this.#dir, `${sessionId}.jsonl`);
  }

  /** Path to a session's metadata file. */
  metaPath(sessionId: string): string {
    return join(this.#dir, `${sessionId}.meta.json`);
  }

  /**
   * Append a message to the session's transcript.
   * Non-blocking — uses Bun.write for fast I/O.
   */
  async append(sessionId: string, msg: DaemonMessage, seq: number): Promise<void> {
    if (!PERSISTED_TYPES.has(msg.type)) return;

    const entry: TranscriptEntry = {
      seq,
      timestamp: "timestamp" in msg ? (msg as { timestamp: string }).timestamp : new Date().toISOString(),
      message: msg,
    };

    const path = this.transcriptPath(sessionId);
    const line = JSON.stringify(entry) + "\n";

    // True append. The previous implementation read the entire file
    // and rewrote it with the new line concatenated — O(n) per append,
    // O(n²) over a session lifetime. A 5 000-message session burned
    // tens of MB of write amplification for nothing. `appendFile`
    // resolves to a single open(O_APPEND) + write under the hood.
    //
    // CONCURRENCY: callers fire-and-forget multiple appends per turn
    // with monotonically-increasing `seq`. `appendFile`'s O_APPEND
    // makes individual writes atomic, but the LOGICAL order of
    // overlapping calls isn't guaranteed — so a `seq=42` write can
    // hit disk before `seq=41`'s. `loadTranscript` then merges by
    // messageId in file order; "later" tool state may be replaced
    // by "earlier" state, leaving tool calls stuck `executing` after
    // restart. Chain per-session so writes for the same session
    // serialize. Different sessions still write in parallel.
    const prev = this.#appendChain.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => appendFile(path, line, "utf-8"));
    this.#appendChain.set(
      sessionId,
      next.finally(() => {
        if (this.#appendChain.get(sessionId) === next) {
          this.#appendChain.delete(sessionId);
        }
      }),
    );
    return next;
  }

  /**
   * Write a user prompt to the transcript BEFORE the API call.
   * This ensures prompts survive crashes.
   */
  /** @deprecated Use append() directly — session.ts now builds the full SessionMessage. */
  async appendUserPrompt(_sessionId: string, _text: string, _sender: string, _seq: number): Promise<void> {
    // No-op — session.ts now calls persistAndBuffer() which calls append()
  }

  /**
   * Save session metadata for fast resume. Atomic + serialized:
   *
   * - **Atomic.** Writes to `.meta.json.tmp` then `rename`s — POSIX
   *   guarantees rename-over-existing is atomic, so a crash mid-
   *   write leaves either the old or the new file, never a partial
   *   one.
   * - **Serialized per session.** `setStatus` fires fire-and-forget,
   *   often multiple times per turn. Two concurrent `Bun.write`s
   *   used to open+truncate+write twice and interleave; the second
   *   could clobber the first half-written. Chain on the existing
   *   promise so writes for the same session run end-to-end.
   *
   * Different sessions still write in parallel — the chain map is
   * keyed by sessionId.
   */
  async saveMeta(meta: TranscriptMeta): Promise<void> {
    const id = meta.sessionId;
    const prev = this.#metaWriteChain.get(id) ?? Promise.resolve();
    const next = prev.then(() => this.#writeMetaAtomic(meta));
    this.#metaWriteChain.set(
      id,
      next.finally(() => {
        // Clear the chain entry once this leaf settles, so the map
        // doesn't grow without bound for sessions whose metas land
        // in steady state.
        if (this.#metaWriteChain.get(id) === next) {
          this.#metaWriteChain.delete(id);
        }
      }),
    );
    return next;
  }

  async #writeMetaAtomic(meta: TranscriptMeta): Promise<void> {
    const path = this.metaPath(meta.sessionId);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2), "utf-8");
    await rename(tmp, path);
  }

  /**
   * Load all session metadata files — used on daemon restart.
   * Returns sessions that were active when daemon last stopped.
   */
  async loadAllMeta(): Promise<TranscriptMeta[]> {
    const glob = new Bun.Glob("*.meta.json");
    const metas: TranscriptMeta[] = [];

    for await (const path of glob.scan(this.#dir)) {
      try {
        const file = Bun.file(join(this.#dir, path));
        const text = await file.text();
        metas.push(JSON.parse(text));
      } catch {
        // Skip corrupted meta files
      }
    }

    return metas;
  }

  /**
   * Load a session's transcript entries — used for scrollback replay on resume.
   *
   * Entries with the same messageId are applied in order (append-only log).
   * Later entries for the same messageId are updates (e.g. tool state transitions).
   * Returns the final merged state of each unique message.
   */
  async loadTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    const path = this.transcriptPath(sessionId);
    const file = Bun.file(path);

    if (!await file.exists()) return [];

    const text = await file.text();
    const raw: TranscriptEntry[] = [];

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        raw.push(JSON.parse(line));
      } catch {
        // Skip corrupted lines
      }
    }

    // Merge entries by messageId — later entries update earlier ones
    const byMessageId = new Map<string, TranscriptEntry>();
    const order: string[] = [];

    for (const entry of raw) {
      const msg = entry.message;
      const messageId = (msg as { messageId?: string }).messageId;

      if (!messageId) {
        // No messageId (e.g. status_change) — keep as-is with synthetic key
        const key = `_seq_${entry.seq}`;
        byMessageId.set(key, entry);
        order.push(key);
        continue;
      }

      if (byMessageId.has(messageId)) {
        // Update: merge the newer entry over the older one
        const existing = byMessageId.get(messageId)!;
        const existingMsg = existing.message as unknown as Record<string, unknown>;
        const newMsg = msg as unknown as Record<string, unknown>;

        // Shallow merge — newer fields overwrite older, preserving what's not in the update
        for (const [k, v] of Object.entries(newMsg)) {
          if (v !== undefined) existingMsg[k] = v;
        }
        // Deep merge tool state specifically
        if (newMsg["tool"] && existingMsg["tool"]) {
          Object.assign(existingMsg["tool"] as Record<string, unknown>, newMsg["tool"] as Record<string, unknown>);
        }
        existing.seq = entry.seq; // update seq to latest
      } else {
        // First occurrence — insert
        byMessageId.set(messageId, { ...entry, message: { ...msg as object } as typeof msg });
        order.push(messageId);
      }
    }

    return order.map((key) => byMessageId.get(key)!);
  }

  /**
   * Delete a session's transcript and metadata.
   */
  async delete(sessionId: string): Promise<void> {
    const { unlinkSync } = await import("node:fs");
    const transcriptPath = this.transcriptPath(sessionId);
    const metaPath = this.metaPath(sessionId);

    try { unlinkSync(transcriptPath); } catch { /* ignore */ }
    try { unlinkSync(metaPath); } catch { /* ignore */ }
  }
}
