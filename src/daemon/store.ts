/**
 * SQLite-backed persistence for session metadata and audit log.
 *
 * Uses Bun's built-in SQLite (no native addon dependency).
 */

import { Database } from "bun:sqlite";
import type { SessionInfo, SessionStatus } from "../protocol/types.js";

export class Store {
  #db: Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
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
    `);
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
      .prepare(`DELETE FROM session_pins WHERE session_id = ? AND file_path = ?`)
      .run(sessionId, filePath);
  }

  listPins(sessionId: string): string[] {
    const rows = this.#db
      .prepare(
        `SELECT file_path FROM session_pins WHERE session_id = ? ORDER BY pinned_at ASC`,
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

  deleteSession(id: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // ── Audit ─────────────────────────────────────────────────────────────

  audit(subject: string, action: string, sessionId?: string, detail?: string): void {
    this.#db
      .prepare(
        "INSERT INTO audit_log (subject, session_id, action, detail) VALUES (?, ?, ?, ?)",
      )
      .run(subject, sessionId ?? null, action, detail ?? null);
  }

  close(): void {
    this.#db.close();
  }
}
