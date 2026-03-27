/**
 * Codeoid CLI — terminal interface to the daemon.
 *
 * Usage:
 *   codeoid start                         Start the daemon
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
  .description("Start the Codeoid daemon")
  .option("-p, --port <port>", "Port to listen on", "7400")
  .option("-h, --host <host>", "Host to bind to", "127.0.0.1")
  .action(async (opts) => {
    const config = loadConfig();
    const daemon = new DaemonServer({
      port: parseInt(opts.port, 10),
      host: opts.host,
      dbPath: config.dbPath,
      auth: config.auth,
    });

    process.on("SIGINT", async () => {
      await daemon.stop();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await daemon.stop();
      process.exit(0);
    });

    await daemon.start();
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
    // attachSession runs until the user detaches (Ctrl+C)
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
