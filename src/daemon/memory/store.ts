/**
 * SqliteEpisodeStore — durable episode storage + hybrid retrieval primitives.
 *
 * Storage model:
 *   - `episodes` table holds structured columns + full content + embedding BLOB
 *   - `episodes_fts` FTS5 virtual table mirrors summary + content for BM25 keyword search
 *   - `file_reads` table indexes content-hashed file reads for cross-session dedup
 *
 * Vector search is brute-force cosine over an in-memory Float32Array matrix,
 * lazy-loaded on the first recall() and refreshed when new episodes are added.
 * Fine up to ~100k episodes on a laptop; swap to a real ANN index behind the
 * same interface if we outgrow it.
 */

import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { resolve, isAbsolute } from "node:path";
import type { Episode, FileReadRecord, RecallQuery } from "./types.js";
import type { TurnUsage } from "../../protocol/types.js";

/** Row shape as stored in SQLite. */
interface EpisodeRow {
  id: string;
  workspace_id: string;
  session_id: string;
  kind: string;
  tool_name: string | null;
  summary: string;
  content: string;
  file_paths: string;
  token_estimate: number;
  embedding: Uint8Array | null;
  embedding_model: string | null;
  created_at: number;
  created_by: string;
}

/**
 * Derive a stable workspace ID from a working directory.
 *
 * For git repos, we anchor on `git rev-parse --git-common-dir` — the shared
 * .git directory that's identical across all worktrees of the same repo. That
 * way two sessions running in separate worktrees of the same codebase
 * (e.g. `/Workspace/codeoid` and `/Workspace/codeoid.wt-feat-x`) share one
 * workspace and cross-pollinate memory. For non-git directories, we fall back
 * to hashing the absolute workdir path.
 */
export function workspaceIdFromPath(workdir: string): string {
  const normalized = workdir.replace(/\/+$/, "");

  try {
    const out = execSync("git rev-parse --git-common-dir", {
      cwd: normalized,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) {
      const absolute = isAbsolute(out) ? out : resolve(normalized, out);
      const hash = createHash("sha256").update(absolute).digest("hex");
      return `ws_${hash.slice(0, 16)}`;
    }
  } catch {
    // Not a git repo, or git not installed — fall through.
  }

  const hash = createHash("sha256").update(normalized).digest("hex");
  return `ws_${hash.slice(0, 16)}`;
}

export class SqliteEpisodeStore {
  #db: Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        session_id      TEXT NOT NULL,
        kind            TEXT NOT NULL,
        tool_name       TEXT,
        summary         TEXT NOT NULL,
        content         TEXT NOT NULL,
        file_paths      TEXT NOT NULL DEFAULT '[]',
        token_estimate  INTEGER NOT NULL,
        embedding       BLOB,
        embedding_model TEXT,
        created_at      INTEGER NOT NULL,
        created_by      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_workspace
        ON episodes(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_episodes_session
        ON episodes(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_episodes_tool
        ON episodes(workspace_id, tool_name);

      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
        summary, content, tool_name,
        content='episodes',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS episodes_fts_insert
        AFTER INSERT ON episodes BEGIN
          INSERT INTO episodes_fts(rowid, summary, content, tool_name)
          VALUES (new.rowid, new.summary, new.content, coalesce(new.tool_name, ''));
        END;

      CREATE TRIGGER IF NOT EXISTS episodes_fts_delete
        AFTER DELETE ON episodes BEGIN
          INSERT INTO episodes_fts(episodes_fts, rowid, summary, content, tool_name)
          VALUES ('delete', old.rowid, old.summary, old.content, coalesce(old.tool_name, ''));
        END;

      CREATE TRIGGER IF NOT EXISTS episodes_fts_update
        AFTER UPDATE ON episodes BEGIN
          INSERT INTO episodes_fts(episodes_fts, rowid, summary, content, tool_name)
          VALUES ('delete', old.rowid, old.summary, old.content, coalesce(old.tool_name, ''));
          INSERT INTO episodes_fts(rowid, summary, content, tool_name)
          VALUES (new.rowid, new.summary, new.content, coalesce(new.tool_name, ''));
        END;

      CREATE TABLE IF NOT EXISTS turn_usage (
        workspace_id                    TEXT NOT NULL,
        session_id                      TEXT NOT NULL,
        turn_number                     INTEGER NOT NULL,
        created_at                      INTEGER NOT NULL,
        input_tokens                    INTEGER NOT NULL DEFAULT 0,
        output_tokens                   INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens               INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens           INTEGER NOT NULL DEFAULT 0,
        total_cost_usd                  REAL    NOT NULL DEFAULT 0,
        duration_ms                     INTEGER NOT NULL DEFAULT 0,
        stop_reason                     TEXT,
        primary_max_call_input_tokens   INTEGER,
        PRIMARY KEY (session_id, turn_number)
      );

      CREATE INDEX IF NOT EXISTS idx_turn_usage_session
        ON turn_usage(session_id, turn_number DESC);
      CREATE INDEX IF NOT EXISTS idx_turn_usage_workspace
        ON turn_usage(workspace_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS file_reads (
        workspace_id   TEXT NOT NULL,
        file_path      TEXT NOT NULL,
        content_hash   TEXT NOT NULL,
        mtime_ms       INTEGER,
        read_at        INTEGER NOT NULL,
        episode_id     TEXT NOT NULL,
        PRIMARY KEY (workspace_id, file_path, content_hash),
        FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_file_reads_recent
        ON file_reads(workspace_id, file_path, read_at DESC);
    `);

    // Idempotent migration: add primary_max_call_input_tokens column to
    // turn_usage tables created before that field existed. SQLite has no
    // "ADD COLUMN IF NOT EXISTS"; pragma_table_info gives us the same
    // effect cheaply.
    const hasPrimaryMaxCol = (
      this.#db
        .prepare(
          "SELECT COUNT(*) AS n FROM pragma_table_info('turn_usage') WHERE name = 'primary_max_call_input_tokens'",
        )
        .get() as { n: number } | undefined
    )?.n ?? 0;
    if (!hasPrimaryMaxCol) {
      this.#db.exec(
        "ALTER TABLE turn_usage ADD COLUMN primary_max_call_input_tokens INTEGER",
      );
    }
  }

  // ── Writes ────────────────────────────────────────────────────────────

  insert(episode: Omit<Episode, "id"> & { id?: string }): Episode {
    const id = episode.id ?? randomUUID();
    const embeddingBuf = episode.embedding
      ? new Uint8Array(episode.embedding.buffer, episode.embedding.byteOffset, episode.embedding.byteLength)
      : null;

    this.#db
      .prepare(
        `INSERT INTO episodes (
          id, workspace_id, session_id, kind, tool_name, summary, content,
          file_paths, token_estimate, embedding, embedding_model, created_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        episode.workspaceId,
        episode.sessionId,
        episode.kind,
        episode.toolName ?? null,
        episode.summary,
        episode.content,
        JSON.stringify(episode.filePaths),
        episode.tokenEstimate,
        embeddingBuf,
        episode.embeddingModel ?? null,
        episode.createdAt,
        episode.createdBy,
      );

    return { ...episode, id };
  }

  setEmbedding(episodeId: string, embedding: Float32Array, model: string): void {
    const buf = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.#db
      .prepare("UPDATE episodes SET embedding = ?, embedding_model = ? WHERE id = ?")
      .run(buf, model, episodeId);
  }

  // ── Turn usage (persistent token/cost tracking) ─────────────────────────

  /**
   * Upsert a per-turn usage row. Idempotent on (session_id, turn_number).
   * Keeps the DB as the source of truth — an in-memory #usage object on
   * Session is just a cache rebuilt from DB on resume.
   */
  recordTurnUsage(input: {
    workspaceId: string;
    sessionId: string;
    turn: TurnUsage;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO turn_usage (
          workspace_id, session_id, turn_number, created_at,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          total_cost_usd, duration_ms, stop_reason, primary_max_call_input_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, turn_number) DO UPDATE SET
          created_at = excluded.created_at,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          cache_creation_tokens = excluded.cache_creation_tokens,
          total_cost_usd = excluded.total_cost_usd,
          duration_ms = excluded.duration_ms,
          stop_reason = excluded.stop_reason,
          primary_max_call_input_tokens = excluded.primary_max_call_input_tokens`,
      )
      .run(
        input.workspaceId,
        input.sessionId,
        input.turn.turnNumber,
        input.turn.createdAt,
        input.turn.inputTokens,
        input.turn.outputTokens,
        input.turn.cacheReadTokens,
        input.turn.cacheCreationTokens,
        input.turn.totalCostUsd,
        input.turn.durationMs,
        input.turn.stopReason ?? null,
        input.turn.primaryMaxCallInputTokens ?? null,
      );
  }

  /** Recent turns for a session (newest first). */
  listTurnsForSession(sessionId: string, limit = 20): TurnUsage[] {
    const rows = this.#db
      .prepare(
        `SELECT turn_number, created_at, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens,
                total_cost_usd, duration_ms, stop_reason,
                primary_max_call_input_tokens
         FROM turn_usage
         WHERE session_id = ?
         ORDER BY turn_number DESC
         LIMIT ?`,
      )
      .all(sessionId, limit) as Array<{
        turn_number: number;
        created_at: number;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
        total_cost_usd: number;
        duration_ms: number;
        stop_reason: string | null;
        primary_max_call_input_tokens: number | null;
      }>;

    return rows.map((r) => this.#rowToTurnUsage(r));
  }

  /**
   * Roll up a session's turn history into a cumulative totals object.
   * Returns zeros if the session has no turn records yet.
   */
  sessionUsageTotals(sessionId: string): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalCostUsd: number;
    durationMs: number;
    numTurns: number;
    peakInputTokens: number;
  } {
    const row = this.#db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0)           AS input_tokens,
           COALESCE(SUM(output_tokens), 0)          AS output_tokens,
           COALESCE(SUM(cache_read_tokens), 0)      AS cache_read_tokens,
           COALESCE(SUM(cache_creation_tokens), 0)  AS cache_creation_tokens,
           COALESCE(SUM(total_cost_usd), 0)         AS total_cost_usd,
           COALESCE(SUM(duration_ms), 0)            AS duration_ms,
           COUNT(*)                                  AS num_turns,
           COALESCE(MAX(
             COALESCE(
               primary_max_call_input_tokens,
               input_tokens + cache_read_tokens + cache_creation_tokens
             )
           ), 0) AS peak_input_tokens
         FROM turn_usage WHERE session_id = ?`,
      )
      .get(sessionId) as {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
        total_cost_usd: number;
        duration_ms: number;
        num_turns: number;
        peak_input_tokens: number;
      } | null;

    return {
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      cacheReadTokens: row?.cache_read_tokens ?? 0,
      cacheCreationTokens: row?.cache_creation_tokens ?? 0,
      totalCostUsd: row?.total_cost_usd ?? 0,
      durationMs: row?.duration_ms ?? 0,
      numTurns: row?.num_turns ?? 0,
      peakInputTokens: row?.peak_input_tokens ?? 0,
    };
  }

  /** Max turn_number recorded for a session (0 if none). Used to resume numbering. */
  nextTurnNumber(sessionId: string): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(MAX(turn_number), 0) AS last_turn
         FROM turn_usage WHERE session_id = ?`,
      )
      .get(sessionId) as { last_turn: number } | null;
    return (row?.last_turn ?? 0) + 1;
  }

  #rowToTurnUsage(row: {
    turn_number: number;
    created_at: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_cost_usd: number;
    duration_ms: number;
    stop_reason: string | null;
    primary_max_call_input_tokens: number | null;
  }): TurnUsage {
    // Anthropic's input_tokens counts NEW bytes only. `total` here SUMS
    // across the multiple internal Messages-API calls a tool-using turn
    // makes — correct for billing, but overstates single-shot context
    // size. `primaryMaxCallInputTokens` (when populated) is the honest
    // per-turn ctx size for "% of window" displays.
    const total =
      row.input_tokens + row.cache_read_tokens + row.cache_creation_tokens;
    const billable = row.input_tokens + row.cache_creation_tokens;
    const hit = total > 0 ? row.cache_read_tokens / total : 0;
    return {
      turnNumber: row.turn_number,
      createdAt: row.created_at,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      totalCostUsd: row.total_cost_usd,
      durationMs: row.duration_ms,
      stopReason: row.stop_reason ?? undefined,
      totalInputTokens: total,
      billableInputTokens: billable,
      cacheHitRate: hit,
      ...(row.primary_max_call_input_tokens != null
        ? { primaryMaxCallInputTokens: row.primary_max_call_input_tokens }
        : {}),
    };
  }

  recordFileRead(record: FileReadRecord): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO file_reads
         (workspace_id, file_path, content_hash, mtime_ms, read_at, episode_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.workspaceId,
        record.filePath,
        record.contentHash,
        record.mtimeMs ?? null,
        record.readAt,
        record.episodeId,
      );
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  getEpisode(id: string): Episode | null {
    const row = this.#db
      .prepare("SELECT * FROM episodes WHERE id = ?")
      .get(id) as EpisodeRow | null;
    return row ? this.#rowToEpisode(row) : null;
  }

  listRecent(workspaceId: string, limit: number): Episode[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM episodes WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(workspaceId, limit) as EpisodeRow[];
    return rows.map((r) => this.#rowToEpisode(r));
  }

  /** All episodes for one session, oldest first — used by share.pack. */
  listEpisodesForSession(sessionId: string): Episode[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM episodes WHERE session_id = ? ORDER BY created_at ASC",
      )
      .all(sessionId) as EpisodeRow[];
    return rows.map((r) => this.#rowToEpisode(r));
  }

  /**
   * Workspace-level counters used by the index builder. One round-trip; cheap
   * even on many-thousand-episode stores because the idx_episodes_workspace
   * index covers both the count and the min/max aggregates.
   */
  workspaceStats(workspaceId: string): {
    episodeCount: number;
    sessionCount: number;
    firstCreatedAt: number | null;
    lastCreatedAt: number | null;
  } {
    const row = this.#db
      .prepare(
        `SELECT
          COUNT(*)                      AS episode_count,
          COUNT(DISTINCT session_id)    AS session_count,
          MIN(created_at)               AS first_created_at,
          MAX(created_at)               AS last_created_at
         FROM episodes WHERE workspace_id = ?`,
      )
      .get(workspaceId) as {
        episode_count: number;
        session_count: number;
        first_created_at: number | null;
        last_created_at: number | null;
      } | null;

    return {
      episodeCount: row?.episode_count ?? 0,
      sessionCount: row?.session_count ?? 0,
      firstCreatedAt: row?.first_created_at ?? null,
      lastCreatedAt: row?.last_created_at ?? null,
    };
  }

  /**
   * Top-N files by touch count across the workspace. Uses json_each to
   * unnest file_paths (stored as a JSON array) so we can aggregate without
   * pulling full rows into TS. Scales to ~50k episodes in <50ms.
   */
  hotFiles(
    workspaceId: string,
    limit: number,
  ): Array<{ path: string; touches: number; lastTouchedAt: number }> {
    const rows = this.#db
      .prepare(
        `SELECT
           json_each.value        AS path,
           COUNT(*)               AS touches,
           MAX(e.created_at)      AS last_touched_at
         FROM episodes e, json_each(e.file_paths)
         WHERE e.workspace_id = ?
         GROUP BY json_each.value
         ORDER BY touches DESC, last_touched_at DESC
         LIMIT ?`,
      )
      .all(workspaceId, limit) as Array<{
        path: string;
        touches: number;
        last_touched_at: number;
      }>;

    return rows.map((r) => ({
      path: r.path,
      touches: r.touches,
      lastTouchedAt: r.last_touched_at,
    }));
  }

  /**
   * Most-recent sessions in the workspace, with a one-line descriptor drawn
   * from the first user_turn episode of each session (falls back to the
   * first episode of any kind if no user_turn exists yet).
   */
  sessionSummaries(
    workspaceId: string,
    limit: number,
  ): Array<{
    sessionId: string;
    firstSummary: string;
    firstCreatedAt: number;
    lastActivityAt: number;
    episodeCount: number;
  }> {
    // Aggregate per-session counters first, ordered by recency.
    const sessionRows = this.#db
      .prepare(
        `SELECT
           session_id           AS session_id,
           MIN(created_at)      AS first_created_at,
           MAX(created_at)      AS last_activity_at,
           COUNT(*)             AS episode_count
         FROM episodes
         WHERE workspace_id = ?
         GROUP BY session_id
         ORDER BY last_activity_at DESC
         LIMIT ?`,
      )
      .all(workspaceId, limit) as Array<{
        session_id: string;
        first_created_at: number;
        last_activity_at: number;
        episode_count: number;
      }>;
    if (sessionRows.length === 0) return [];

    // Per-session: prefer the first user_turn's summary as the intent marker.
    const pickSummary = this.#db.prepare(
      `SELECT summary FROM episodes
       WHERE workspace_id = ? AND session_id = ?
       ORDER BY
         CASE kind WHEN 'user_turn' THEN 0 ELSE 1 END,
         created_at ASC
       LIMIT 1`,
    );

    return sessionRows.map((r) => {
      const summaryRow = pickSummary.get(workspaceId, r.session_id) as
        | { summary: string }
        | null;
      return {
        sessionId: r.session_id,
        firstSummary: summaryRow?.summary ?? "(no summary)",
        firstCreatedAt: r.first_created_at,
        lastActivityAt: r.last_activity_at,
        episodeCount: r.episode_count,
      };
    });
  }

  /** FTS5 keyword search returning top-K rows with BM25 scores. */
  ftsSearch(workspaceId: string, query: string, limit: number): Array<{ id: string; bm25: number }> {
    if (!query.trim()) return [];
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const rows = this.#db
      .prepare(
        `SELECT e.id AS id, bm25(episodes_fts) AS bm25
         FROM episodes_fts
         JOIN episodes e ON e.rowid = episodes_fts.rowid
         WHERE episodes_fts MATCH ? AND e.workspace_id = ?
         ORDER BY bm25
         LIMIT ?`,
      )
      .all(sanitized, workspaceId, limit) as Array<{ id: string; bm25: number }>;

    return rows;
  }

  /** Build or return the cached (rowid → embedding) matrix for a workspace. */
  loadVectorMatrix(workspaceId: string): { ids: string[]; vectors: Float32Array[] } {
    const rows = this.#db
      .prepare(
        `SELECT id, embedding FROM episodes
         WHERE workspace_id = ? AND embedding IS NOT NULL`,
      )
      .all(workspaceId) as Array<{ id: string; embedding: Uint8Array }>;

    const ids: string[] = [];
    const vectors: Float32Array[] = [];
    for (const row of rows) {
      ids.push(row.id);
      vectors.push(uint8ToFloat32(row.embedding));
    }
    return { ids, vectors };
  }

  /** Look up a recent file read by path + content hash (dedup hit). */
  findFileRead(
    workspaceId: string,
    filePath: string,
    contentHash: string,
  ): FileReadRecord | null {
    const row = this.#db
      .prepare(
        `SELECT workspace_id, file_path, content_hash, mtime_ms, read_at, episode_id
         FROM file_reads
         WHERE workspace_id = ? AND file_path = ? AND content_hash = ?`,
      )
      .get(workspaceId, filePath, contentHash) as
      | {
          workspace_id: string;
          file_path: string;
          content_hash: string;
          mtime_ms: number | null;
          read_at: number;
          episode_id: string;
        }
      | null;

    if (!row) return null;
    return {
      workspaceId: row.workspace_id,
      filePath: row.file_path,
      contentHash: row.content_hash,
      mtimeMs: row.mtime_ms ?? undefined,
      readAt: row.read_at,
      episodeId: row.episode_id,
    };
  }

  /** Apply post-retrieval filters from RecallQuery. */
  filter(ids: string[], query: RecallQuery): Episode[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.#db
      .prepare(`SELECT * FROM episodes WHERE id IN (${placeholders})`)
      .all(...ids) as EpisodeRow[];

    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered: Episode[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) continue;
      const ep = this.#rowToEpisode(row);
      if (!matchesQuery(ep, query)) continue;
      ordered.push(ep);
    }
    return ordered;
  }

  close(): void {
    this.#db.close();
  }

  // ── Internals ─────────────────────────────────────────────────────────

  #rowToEpisode(row: EpisodeRow): Episode {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      kind: row.kind as Episode["kind"],
      toolName: row.tool_name ?? undefined,
      summary: row.summary,
      content: row.content,
      filePaths: safeJsonArray(row.file_paths),
      tokenEstimate: row.token_estimate,
      embedding: row.embedding ? uint8ToFloat32(row.embedding) : undefined,
      embeddingModel: row.embedding_model ?? undefined,
      createdAt: row.created_at,
      createdBy: row.created_by,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function uint8ToFloat32(buf: Uint8Array): Float32Array {
  // Make a copy into a fresh backing buffer — the SQLite-returned Uint8Array
  // may not be 4-byte aligned, which breaks a direct Float32Array view.
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

function safeJsonArray(s: string): string[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Escape FTS5 operators and wrap terms to survive user input. */
function sanitizeFtsQuery(q: string): string {
  // Strip control chars and trailing punctuation; split on whitespace; drop empties.
  const terms = q
    .replace(/[\u0000-\u001f]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, "").trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return "";
  // Quote each term to prevent FTS5 operator interpretation; join with implicit AND.
  return terms.map((t) => `"${t}"`).join(" ");
}

function matchesQuery(ep: Episode, q: RecallQuery): boolean {
  if (q.sessionId && ep.sessionId !== q.sessionId) return false;
  if (q.excludeSessionId && ep.sessionId === q.excludeSessionId) return false;
  if (q.toolName && ep.toolName !== q.toolName) return false;
  if (q.before && ep.createdAt >= q.before) return false;
  if (q.after && ep.createdAt <= q.after) return false;
  if (q.filePaths && q.filePaths.length > 0) {
    const has = ep.filePaths.some((p) => q.filePaths!.includes(p));
    if (!has) return false;
  }
  return true;
}
