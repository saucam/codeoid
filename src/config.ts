/**
 * Configuration loader — reads from env vars and ~/.codeoid/config.json.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AuthConfig } from "./daemon/auth.js";
import type { OAuthConfig } from "./daemon/oauth.js";

export interface CodeoidConfig {
  /** Daemon WebSocket URL */
  daemonUrl: string;
  /** SQLite database path */
  dbPath: string;
  /** Transcript directory for JSONL persistence */
  transcriptDir: string;
  /** ZeroID auth config */
  auth: AuthConfig;
  /** OAuth authorization server config */
  oauth?: OAuthConfig;
  /** ZeroID API key for token exchange (client-side, legacy) */
  apiKey?: string;
  /** ZeroID base URL for token exchange */
  zeroidUrl: string;
  /** ZeroID tenant for agent identity registration */
  agentIdentity?: {
    accountId: string;
    projectId: string;
  };
  /** Memory / recall config — when enabled, stores episodes and exposes recall() to Claude. */
  memory?: {
    enabled: boolean;
    dbPath: string;
    model?: string;
    modelCacheDir?: string;
  };
}

const CONFIG_DIR = join(homedir(), ".codeoid");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function loadConfig(): CodeoidConfig {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  let config: Partial<CodeoidConfig> = {};

  if (existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    } catch {
      // Ignore malformed config
    }
  }

  const zeroidUrl = process.env["ZEROID_URL"] ?? config.zeroidUrl ?? "http://localhost:8899";
  const hmacSecret = process.env["CODEOID_HMAC_SECRET"] ?? config.oauth?.hmacSecret;
  const accountId = process.env["ZEROID_ACCOUNT_ID"] ?? config.agentIdentity?.accountId ?? "personal";
  const projectId = process.env["ZEROID_PROJECT_ID"] ?? config.agentIdentity?.projectId ?? "dev";

  const memoryEnabled =
    process.env["CODEOID_MEMORY"] !== undefined
      ? process.env["CODEOID_MEMORY"] === "1" ||
        process.env["CODEOID_MEMORY"]?.toLowerCase() === "true"
      : (config.memory?.enabled ?? true);
  const memoryDbPath =
    process.env["CODEOID_MEMORY_DB_PATH"] ??
    config.memory?.dbPath ??
    join(CONFIG_DIR, "memory.db");
  const memoryModel = process.env["CODEOID_MEMORY_MODEL"] ?? config.memory?.model;
  const memoryCacheDir =
    process.env["CODEOID_MEMORY_CACHE_DIR"] ??
    config.memory?.modelCacheDir ??
    join(CONFIG_DIR, "models");

  return {
    daemonUrl: process.env["CODEOID_DAEMON_URL"] ?? config.daemonUrl ?? "ws://127.0.0.1:7400",
    dbPath: process.env["CODEOID_DB_PATH"] ?? config.dbPath ?? join(CONFIG_DIR, "codeoid.db"),
    transcriptDir: process.env["CODEOID_TRANSCRIPT_DIR"] ?? config.transcriptDir ?? join(CONFIG_DIR, "transcripts"),
    auth: {
      baseUrl: zeroidUrl,
      issuer: process.env["ZEROID_ISSUER"] ?? config.auth?.issuer,
      audience: process.env["ZEROID_AUDIENCE"] ?? config.auth?.audience,
    },
    oauth: hmacSecret ? {
      hmacSecret,
      issuer: process.env["ZEROID_ISSUER"] ?? config.oauth?.issuer ?? "https://auth.zeroid.dev",
      tokenEndpoint: `${zeroidUrl}/oauth2/token`,
      clientId: process.env["CODEOID_OAUTH_CLIENT_ID"] ?? config.oauth?.clientId ?? "codeoid",
      accountId,
      projectId,
      allowedRedirectUris: [
        "http://localhost:7400/auth/callback",
        "http://127.0.0.1:7400/auth/callback",
      ],
      defaultScopes: [
        "session:create", "session:list", "session:attach", "session:watch",
        "session:send", "session:interrupt", "session:approve", "session:destroy",
      ],
    } : undefined,
    apiKey: process.env["CODEOID_API_KEY"] ?? config.apiKey,
    zeroidUrl,
    agentIdentity: (process.env["ZEROID_ACCOUNT_ID"] || config.agentIdentity)
      ? { accountId, projectId }
      : undefined,
    memory: {
      enabled: memoryEnabled,
      dbPath: memoryDbPath,
      model: memoryModel,
      modelCacheDir: memoryCacheDir,
    },
  };
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
