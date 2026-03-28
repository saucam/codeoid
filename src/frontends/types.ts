/**
 * Frontend plugin interface.
 *
 * Every frontend (Telegram, Web UI, Slack, Discord, …) implements this
 * interface. The daemon discovers and manages frontends — they share the
 * same SessionManager, Store, and auth config without going through the
 * network.
 */

import type { SessionManager } from "../daemon/session-manager.js";
import type { AuthConfig } from "../daemon/auth.js";
import type { Store } from "../daemon/store.js";
import type { Server } from "node:http";

/** Context provided to every frontend at startup. */
export interface FrontendContext {
  /** The shared session manager — direct access, no WebSocket needed. */
  manager: SessionManager;
  /** The shared SQLite store (audit log, session metadata). */
  store: Store;
  /** ZeroID auth config for token verification. */
  auth: AuthConfig;
  /** The daemon's HTTP server — frontends can mount routes on it. */
  httpServer: Server;
  /** Daemon host and port (for constructing URLs). */
  host: string;
  port: number;
}

/** A frontend plugin that the daemon can load and manage. */
export interface Frontend {
  /** Unique identifier, e.g. "telegram", "web", "slack". */
  readonly name: string;

  /**
   * Start the frontend. Called once after the daemon is ready.
   * Receives direct access to the session manager — no network hop.
   */
  start(ctx: FrontendContext): Promise<void>;

  /** Graceful shutdown. */
  stop(): Promise<void>;
}
