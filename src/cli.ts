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

import { program } from "commander";
import { DaemonServer } from "./daemon/server.js";
import { TerminalClient } from "./terminal/client.js";
import { loadConfig } from "./config.js";

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
      agentIdentity: config.agentIdentity,
    });

    // ── Register frontends ────────────────────────────────────────

    // Web UI (always enabled unless --no-web)
    if (opts.web !== false) {
      const { WebFrontend } = await import("./frontends/web/index.js");
      const web = new WebFrontend();
      daemon.use(web);
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
      const url = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}/app`;
      console.log(`[codeoid] web UI: ${url}`);
    }
  });

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
  .command("new <name> <workdir>")
  .description("Create a new agent session")
  .action(async (name: string, workdir: string) => {
    const config = loadConfig();
    const client = new TerminalClient(config);
    await client.connect();
    await client.createSession(name, workdir);
    client.disconnect();
  });

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
