/**
 * Configuration loader — reads from env vars and ~/.codeoid/config.json.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AuthConfig } from "./daemon/auth.js";

export interface CodeoidConfig {
  /** Daemon WebSocket URL */
  daemonUrl: string;
  /** SQLite database path */
  dbPath: string;
  /** ZeroID auth config */
  auth: AuthConfig;
  /** ZeroID API key for token exchange (client-side) */
  apiKey?: string;
  /** ZeroID base URL for token exchange */
  zeroidUrl: string;
}

const CONFIG_DIR = join(homedir(), ".codeoid");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function loadConfig(): CodeoidConfig {
  // Ensure config dir exists
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // Defaults
  let config: Partial<CodeoidConfig> = {};

  // Load from file if exists
  if (existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    } catch {
      // Ignore malformed config
    }
  }

  // Env vars override
  const zeroidUrl = process.env["ZEROID_URL"] ?? config.zeroidUrl ?? "http://localhost:8899";

  return {
    daemonUrl: process.env["CODEOID_DAEMON_URL"] ?? config.daemonUrl ?? "ws://127.0.0.1:7400",
    dbPath: process.env["CODEOID_DB_PATH"] ?? config.dbPath ?? join(CONFIG_DIR, "codeoid.db"),
    auth: {
      baseUrl: zeroidUrl,
      issuer: process.env["ZEROID_ISSUER"] ?? config.auth?.issuer,
      audience: process.env["ZEROID_AUDIENCE"] ?? config.auth?.audience,
    },
    apiKey: process.env["CODEOID_API_KEY"] ?? config.apiKey,
    zeroidUrl,
  };
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
