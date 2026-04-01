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
  "agent.approval_request",
  "agent.status_change",
]);

export class TranscriptStore {
  #dir: string;

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

    // Append to JSONL file
    const file = Bun.file(path);
    const existing = await file.exists() ? await file.text() : "";
    await Bun.write(path, existing + line);
  }

  /**
   * Write a user prompt to the transcript BEFORE the API call.
   * This ensures prompts survive crashes.
   */
  async appendUserPrompt(sessionId: string, text: string, sender: string, seq: number): Promise<void> {
    const entry: TranscriptEntry = {
      seq,
      timestamp: new Date().toISOString(),
      message: {
        type: "session.message",
        sessionId,
        role: "user",
        content: text,
        metadata: { sender },
        timestamp: new Date().toISOString(),
      },
    };

    const path = this.transcriptPath(sessionId);
    const line = JSON.stringify(entry) + "\n";
    const file = Bun.file(path);
    const existing = await file.exists() ? await file.text() : "";
    await Bun.write(path, existing + line);
  }

  /**
   * Save session metadata for fast resume.
   */
  async saveMeta(meta: TranscriptMeta): Promise<void> {
    const path = this.metaPath(meta.sessionId);
    await Bun.write(path, JSON.stringify(meta, null, 2));
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
   */
  async loadTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    const path = this.transcriptPath(sessionId);
    const file = Bun.file(path);

    if (!await file.exists()) return [];

    const text = await file.text();
    const entries: TranscriptEntry[] = [];

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip corrupted lines
      }
    }

    return entries;
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
