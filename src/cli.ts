#!/usr/bin/env bun
/**
 * Codeoid CLI — terminal interface + daemon launcher.
 *
 * Usage:
 *   codeoid start                         Start daemon (+ Telegram + Web UI)
 *   codeoid ls                            List active sessions
 *   codeoid new <name> <workdir>          Create a new session
 *   codeoid attach <name|id>              Attach to a session (streaming)
 *   codeoid send <name|id> <message>      Send a one-shot message
 *   codeoid interrupt <name|id>           Interrupt a running agent
 *   codeoid approve <name|id> [yes|no]    Approve/deny pending permission
 *   codeoid destroy <name|id>             Destroy a session
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { program } from "commander";
import { DaemonServer } from "./daemon/server.js";
import { TerminalClient } from "./terminal/client.js";
import {
  getConfigDir,
  loadConfig,
  resolveZeroidUrl,
  ZEROID_PRESETS,
} from "./config.js";

program
  .name("codeoid")
  .description("Identity-first remote control plane for AI coding agents")
  .version("0.1.0");

// ── Daemon ────────────────────────────────────────────────────────────────────

program
  .command("start")
  .description("Start the Codeoid daemon with all frontends")
  .option("-p, --port <port>", "Port to listen on", "7400")
  .option("--host <host>", "Host to bind to", "127.0.0.1")
  .option("--no-telegram", "Disable Telegram bot")
  .option("--no-web", "Disable Web UI")
  .action(async (opts) => {
    const config = loadConfig();
    const daemon = new DaemonServer({
      port: parseInt(opts.port, 10),
      host: opts.host,
      dbPath: config.dbPath,
      transcriptDir: config.transcriptDir,
      auth: config.auth,
      oauth: config.oauth,
      agentIdentity: config.agentIdentity,
      memory: config.memory?.enabled
        ? {
            dbPath: config.memory.dbPath,
            model: config.memory.model,
            modelCacheDir: config.memory.modelCacheDir,
          }
        : undefined,
      // Forward the full config so session-level features (compress, etc.)
      // get the parsed shape rather than re-reading env/file.
      fullConfig: config,
    });

    // ── Register frontends ────────────────────────────────────────

    // Web UI (always enabled unless --no-web) — the SolidJS app at /ui,
    // single-origin so one HTTPS tunnel also serves as a Telegram Mini App.
    if (opts.web !== false) {
      const { WebUiFrontend } = await import("./frontends/web-ui/index.js");
      daemon.use(new WebUiFrontend());
    }

    // Telegram (enabled when TELEGRAM_BOT_TOKEN is set)
    if (opts.telegram !== false) {
      const botToken = process.env["TELEGRAM_BOT_TOKEN"];
      const allowedIds = (process.env["TELEGRAM_ALLOWED_USER_IDS"] ?? "")
        .split(",")
        .map(Number)
        .filter(Boolean);

      if (botToken && allowedIds.length > 0) {
        const { TelegramFrontend } = await import("./frontends/telegram/index.js");
        daemon.use(new TelegramFrontend(botToken, allowedIds));
      } else if (botToken) {
        console.log("[codeoid] TELEGRAM_BOT_TOKEN set but TELEGRAM_ALLOWED_USER_IDS missing — skipping Telegram");
      }
    }

    await daemon.start();

    if (opts.web !== false) {
      const url = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}/ui/`;
      console.log(`[codeoid] web UI: ${url}`);
    }
  });

// ── Auth ──────────────────────────────────────────────────────────────────────

/** The full scope set codeoid asks ZeroID to mint for a session-driving key. */
const CODEOID_LOGIN_SCOPES = [
  "session:create",
  "session:list",
  "session:attach",
  "session:watch",
  "session:send",
  "session:interrupt",
  "session:approve",
  "session:destroy",
  "fs:read",
  "tools:read",
  "tools:write",
  "tools:execute",
  "tools:agent",
].join(" ");

/** Read a secret from the TTY without echoing it (handles paste + backspace). */
function readSecret(promptText: string): Promise<string> {
  process.stdout.write(promptText);
  const stdin = process.stdin;
  // Non-TTY (piped) input: read a single line plainly.
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c: string) => {
        buf += c;
      });
      stdin.on("end", () => resolve(buf.trim()));
    });
  }
  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(buf.trim());
          return;
        }
        if (ch === "\u0003") process.exit(130); // Ctrl-C
        else if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Merge-write the raw config.json (preserves existing keys, no defaults baked in). */
function writeConfigKeys(updates: Record<string, unknown>): string {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      // Corrupt file — refuse to clobber silently.
      throw new Error(`Existing ${path} is not valid JSON; fix or remove it first.`);
    }
  }
  const merged = { ...current, ...updates };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return path;
}

program
  .command("login [apiKey]")
  .description(
    "Authenticate with a ZeroID key (mint one in Studio's Code Agents screen). Stores it in ~/.codeoid/config.json.",
  )
  .option(
    "--zeroid <preset-or-url>",
    `ZeroID issuer: ${Object.keys(ZEROID_PRESETS).join(" | ")} | <url> (default: highflame SaaS)`,
  )
  .option("--no-verify", "Skip the token-exchange check and just save the key")
  .action(
    async (
      apiKeyArg: string | undefined,
      opts: { zeroid?: string; verify?: boolean },
    ) => {
      // Resolve the issuer: explicit --zeroid wins, else whatever config resolves to.
      const issuerInput = opts.zeroid;
      const baseUrl = issuerInput
        ? resolveZeroidUrl(issuerInput)
        : loadConfig().zeroidUrl;

      const apiKey =
        apiKeyArg ??
        process.env["CODEOID_API_KEY"] ??
        (await readSecret("Paste your ZeroID key (zid_sk_...): "));
      if (!apiKey) {
        console.error("No key provided.");
        process.exit(1);
      }

      // Verify by exchanging the key for a token (unless --no-verify).
      if (opts.verify !== false) {
        process.stdout.write(`Verifying against ${baseUrl} ... `);
        try {
          const res = await fetch(`${baseUrl}/oauth2/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              grant_type: "api_key",
              api_key: apiKey,
              scope: CODEOID_LOGIN_SCOPES,
            }),
          });
          if (!res.ok) {
            console.error(`failed (HTTP ${res.status}).`);
            console.error(`  ${(await res.text()).slice(0, 300)}`);
            process.exit(1);
          }
          const body = (await res.json()) as { access_token?: string };
          if (!body.access_token) {
            console.error("failed: no access_token in response.");
            process.exit(1);
          }
          const claims = JSON.parse(
            Buffer.from(body.access_token.split(".")[1] ?? "", "base64").toString("utf8"),
          ) as { sub?: string; scope?: string[]; scopes?: string[] };
          console.log("ok.");
          console.log(`  subject: ${claims.sub ?? "(unknown)"}`);
          const scopes = claims.scope ?? claims.scopes ?? [];
          console.log(`  scopes:  ${scopes.length ? scopes.join(", ") : "(none)"}`);
        } catch (err) {
          console.error(`failed: ${err instanceof Error ? err.message : String(err)}`);
          console.error(`  (Is ${baseUrl} reachable? Override with --zeroid.)`);
          process.exit(1);
        }
      }

      // Persist. Store the issuer symbolically (preset name or URL as given) so
      // the file stays readable; only touch zeroidUrl when --zeroid was passed.
      const updates: Record<string, unknown> = { apiKey };
      if (issuerInput) updates["zeroidUrl"] = issuerInput;
      const path = writeConfigKeys(updates);
      console.log(`Saved to ${path} (mode 600).`);
      console.log("Run `codeoid start` to launch the daemon.");
    },
  );

// ── Session commands ──────────────────────────────────────────────────────────

program
  .command("ls")
  .description("List active sessions")
  .action(async () => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.listSessions();
    client.disconnect();
  });

program
  .command("new <name> [workdir]")
  .description("Create a new agent session. With --worktree, auto-spawns a git worktree.")
  .option(
    "--worktree <branch>",
    "Create a git worktree for <branch> and run the session there. Requires being inside a git repo (or pass --repo).",
  )
  .option(
    "--repo <path>",
    "Path to the source git repo (defaults to current directory when --worktree is set).",
  )
  .option(
    "--worktree-dir <path>",
    "Override the worktree directory (default: <repo>.wt-<branch>).",
  )
  .action(
    async (
      name: string,
      workdir: string | undefined,
      opts: { worktree?: string; repo?: string; worktreeDir?: string },
    ) => {
      const config = loadConfig();
      let resolvedWorkdir = workdir;
      if (opts.worktree) {
        const { createWorktree } = await import("./worktree.js");
        resolvedWorkdir = await createWorktree({
          branch: opts.worktree,
          repo: opts.repo ?? process.cwd(),
          workdir: opts.worktreeDir,
        });
        console.log(`[codeoid] worktree ready: ${resolvedWorkdir}`);
      }
      if (!resolvedWorkdir) {
        console.error("workdir is required (pass as argument or use --worktree).");
        process.exit(1);
      }
      const client = new TerminalClient(config);
      await client.connect();
      await client.createSession(name, resolvedWorkdir);
      client.disconnect();
    },
  );

program
  .command("attach <session>")
  .description("Attach to a session (interactive streaming)")
  .action(async (session: string) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.attachSession(session);
  });

program
  .command("tui")
  .description("Interactive multi-session cockpit (Ink-based TUI)")
  .action(async () => {
    const config = loadConfig();
    const { startTui } = await import("./tui/index.js");
    await startTui(config);
  });

program
  .command("send <session> <message...>")
  .description("Send a message to a session")
  .action(async (session: string, messageParts: string[]) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.sendMessage(session, messageParts.join(" "));
    client.disconnect();
  });

program
  .command("interrupt <session>")
  .description("Interrupt a running agent")
  .action(async (session: string) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.interruptSession(session);
    client.disconnect();
  });

program
  .command("approve <session>")
  .description("Approve a pending permission request")
  .option("--deny", "Deny instead of approve")
  .action(async (session: string, opts: { deny?: boolean }) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.approveSession(session, !opts.deny);
    client.disconnect();
  });

program
  .command("destroy <session>")
  .description("Destroy a session")
  .action(async (session: string) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.destroySession(session);
    client.disconnect();
  });

program.parse();
