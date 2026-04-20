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
