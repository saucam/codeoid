/**
 * SQLite-backed persistence for session metadata and audit log.
 *
 * Uses Bun's built-in SQLite (no native addon dependency).
 */

import { Database } from "bun:sqlite";
import type { ModelInfo, SessionInfo, SessionStatus } from "../protocol/types.js";

export class Store {
  #db: Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    // Under WAL the default is synchronous=FULL, which fsyncs the WAL on every
    // commit. audit() is a synchronous write on the hot path (fires per tool
    // call / attach / send), so FULL stalls the event loop. NORMAL only syncs
    // at checkpoints — safe under WAL (worst case loses the last few committed
    // txns on OS crash, never corruption). Matches the memory store.
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        workdir     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'idle',
        created_by  TEXT NOT NULL,
        account_id  TEXT NOT NULL,
        project_id  TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Rotation columns added post-launch. Use additive ALTER below.
    `);

    // Additive columns — SQLite ALTER TABLE ADD COLUMN is idempotent-ish
    // only via catch; use PRAGMA table_info to be deterministic.
    this.#addColumnIfMissing("sessions", "claude_code_session_id", "TEXT");
    this.#addColumnIfMissing("sessions", "rotation_count", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("sessions", "last_rotated_at", "INTEGER");
    // Model selection — persisted so /model choice survives daemon restart.
    this.#addColumnIfMissing("sessions", "model", "TEXT");
    this.#addColumnIfMissing("sessions", "fallback_model", "TEXT");

    this.#db.exec(`

      CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
        subject     TEXT NOT NULL,
        session_id  TEXT,
        action      TEXT NOT NULL,
        detail      TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id, project_id);

      CREATE TABLE IF NOT EXISTS session_pins (
        session_id  TEXT NOT NULL,
        file_path   TEXT NOT NULL,
        pinned_at   INTEGER NOT NULL,
        PRIMARY KEY (session_id, file_path),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_pins_session ON session_pins(session_id);

      -- Last live model catalog per provider (claude, gemini, openai, ...),
      -- as reported by that provider's backend. Served as the models.list
      -- fallback on boots where no session has run a turn yet, so the picker
      -- shows current model names instead of a baked-in list that goes stale
      -- between codeoid releases.
      CREATE TABLE IF NOT EXISTS provider_model_catalogs (
        provider_id TEXT PRIMARY KEY,
        models_json TEXT NOT NULL,
        cached_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Pre-release single-row predecessor of provider_model_catalogs — never
    // shipped in a tagged version; drop from dev databases that ran the branch.
    this.#db.exec("DROP TABLE IF EXISTS cached_model_catalog");
  }

  /**
   * Idempotent column-adder — skips when the column already exists. SQLite
   * lacks `ADD COLUMN IF NOT EXISTS`, so we check PRAGMA first.
   */
  #addColumnIfMissing(table: string, column: string, ddl: string): void {
    const cols = this.#db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  // ── Pinned attachments ────────────────────────────────────────────────

  pinFile(sessionId: string, filePath: string): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO session_pins (session_id, file_path, pinned_at)
         VALUES (?, ?, ?)`,
      )
      .run(sessionId, filePath, Date.now());
  }

  unpinFile(sessionId: string, filePath: string): void {
    this.#db
      .prepare("DELETE FROM session_pins WHERE session_id = ? AND file_path = ?")
      .run(sessionId, filePath);
  }

  listPins(sessionId: string): string[] {
    const rows = this.#db
      .prepare(
        "SELECT file_path FROM session_pins WHERE session_id = ? ORDER BY pinned_at ASC",
      )
      .all(sessionId) as Array<{ file_path: string }>;
    return rows.map((r) => r.file_path);
  }

  // ── Sessions ──────────────────────────────────────────────────────────

  createSession(session: SessionInfo & { accountId: string; projectId: string }): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO sessions (id, name, workdir, status, created_by, account_id, project_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.name,
        session.workdir,
        session.status,
        session.createdBy,
        session.accountId,
        session.projectId,
        session.createdAt,
      );
  }

  listSessions(accountId: string, projectId: string): SessionInfo[] {
    const rows = this.#db
      .prepare("SELECT * FROM sessions WHERE account_id = ? AND project_id = ?")
      .all(accountId, projectId) as Array<{
        id: string;
        name: string;
        workdir: string;
        status: string;
        created_by: string;
        created_at: string;
      }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      workdir: r.workdir,
      status: r.status as SessionStatus,
      createdBy: r.created_by,
      createdAt: r.created_at,
      attachedClients: 0,
    }));
  }

  getSession(id: string): SessionInfo | undefined {
    const row = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as {
        id: string;
        name: string;
        workdir: string;
        status: string;
        created_by: string;
        created_at: string;
      } | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      name: row.name,
      workdir: row.workdir,
      status: row.status as SessionStatus,
      createdBy: row.created_by,
      createdAt: row.created_at,
      attachedClients: 0,
    };
  }

  updateSessionStatus(id: string, status: SessionStatus): void {
    this.#db
      .prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);
  }

  /**
   * Claude Code backing session id — separate from codeoid's stable
   * session.id so we can rotate the underlying context without breaking
   * user-facing identifiers.
   */
  getClaudeCodeSessionId(id: string): string | null {
    const row = this.#db
      .prepare("SELECT claude_code_session_id AS cc FROM sessions WHERE id = ?")
      .get(id) as { cc: string | null } | undefined;
    return row?.cc ?? null;
  }

  setClaudeCodeSessionId(
    id: string,
    backingId: string,
    rotationDelta = 0,
    rotatedAt?: number,
  ): void {
    this.#db
      .prepare(
        `UPDATE sessions SET
           claude_code_session_id = ?,
           rotation_count = rotation_count + ?,
           last_rotated_at = COALESCE(?, last_rotated_at),
           updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(backingId, rotationDelta, rotatedAt ?? null, id);
  }

  /**
   * Get the persisted model selection for a session. Either field may be
   * null if never set — caller falls back to config defaults.
   */
  getSessionModel(id: string): { model: string | null; fallbackModel: string | null } {
    const row = this.#db
      .prepare(
        "SELECT model AS m, fallback_model AS f FROM sessions WHERE id = ?",
      )
      .get(id) as { m: string | null; f: string | null } | undefined;
    return { model: row?.m ?? null, fallbackModel: row?.f ?? null };
  }

  /**
   * Set the model selection for a session. Passing `null` for either field
   * clears it (next lookup will return null). Caller is responsible for
   * validating the id before calling — Store doesn't gatekeep strings.
   */
  setSessionModel(
    id: string,
    model: string | null,
    fallbackModel: string | null | undefined = undefined,
  ): void {
    if (fallbackModel === undefined) {
      // Only update primary model; leave fallback untouched.
      this.#db
        .prepare(
          `UPDATE sessions SET model = ?, updated_at = datetime('now') WHERE id = ?`,
        )
        .run(model, id);
      return;
    }
    this.#db
      .prepare(
        `UPDATE sessions SET model = ?, fallback_model = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(model, fallbackModel, id);
  }

  /** Rotation counters for a session (for UI display + diagnostics). */
  getRotationStats(id: string): { count: number; lastRotatedAt: number | null } {
    const row = this.#db
      .prepare(
        `SELECT rotation_count AS c, last_rotated_at AS t
         FROM sessions WHERE id = ?`,
      )
      .get(id) as { c: number | null; t: number | null } | undefined;
    return {
      count: row?.c ?? 0,
      lastRotatedAt: row?.t ?? null,
    };
  }

  deleteSession(id: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // ── Model catalog cache ───────────────────────────────────────────────

  /**
   * Persist the live model catalog a provider's backend reported. One row
   * per provider id — the latest report wins across daemon lifetimes.
   */
  saveModelCatalog(providerId: string, models: readonly ModelInfo[]): void {
    this.#db
      .prepare(
        `INSERT INTO provider_model_catalogs (provider_id, models_json, cached_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(provider_id) DO UPDATE SET
           models_json = excluded.models_json,
           cached_at = excluded.cached_at`,
      )
      .run(providerId, JSON.stringify(models));
  }

  /**
   * The last persisted live model catalog for a provider, or null when that
   * provider has never reported one (first-ever boot) or the stored JSON is
   * unreadable.
   */
  getModelCatalog(providerId: string): ModelInfo[] | null {
    const row = this.#db
      .prepare("SELECT models_json FROM provider_model_catalogs WHERE provider_id = ?")
      .get(providerId) as { models_json: string } | null;
    if (!row) return null;
    try {
      const parsed: unknown = JSON.parse(row.models_json);
      if (!Array.isArray(parsed)) return null;
      // Structural validation — a row written by a future/older version with
      // a different shape degrades to the next fallback tier instead of
      // serving malformed entries to pickers.
      const valid = parsed.filter(
        (m): m is ModelInfo =>
          !!m &&
          typeof m === "object" &&
          typeof (m as ModelInfo).value === "string" &&
          typeof (m as ModelInfo).displayName === "string",
      );
      return valid.length > 0 ? valid : null;
    } catch {
      return null;
    }
  }

  // ── Audit ─────────────────────────────────────────────────────────────

  audit(subject: string, action: string, sessionId?: string, detail?: string): void {
    // An audit write must NEVER crash the daemon. The session_id FK can fail
    // when the referenced session is no longer in the sessions table — e.g. a
    // client disconnect audited after the session was destroyed, or a resumed
    // session whose row isn't present. That used to throw out of a sync WS
    // close handler → uncaughtException → full daemon shutdown.
    try {
      this.#db
        .prepare(
          "INSERT INTO audit_log (subject, session_id, action, detail) VALUES (?, ?, ?, ?)",
        )
        .run(subject, sessionId ?? null, action, detail ?? null);
    } catch {
      // Retry unlinked (FK can't fail) so the entry is still recorded; fold
      // the orphaned session id into the detail. Swallow anything further.
      try {
        const d = sessionId ? `${detail ?? ""} [session=${sessionId}]`.trim() : detail ?? null;
        this.#db
          .prepare(
            "INSERT INTO audit_log (subject, session_id, action, detail) VALUES (?, NULL, ?, ?)",
          )
          .run(subject, action, d);
      } catch (err) {
        console.error(
          `[codeoid/store] audit write failed (swallowed): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  close(): void {
    this.#db.close();
  }
}
