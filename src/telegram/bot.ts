/**
 * Telegram bot — mobile interface to Codeoid.
 *
 * Commands:
 *   /auth <api_key>               Authenticate with ZeroID
 *   /ls                           List sessions
 *   /new <name> <workdir>         Create session
 *   /attach <name>                Attach to session (receive output)
 *   /detach                       Detach from current session
 *   /interrupt                    Interrupt current session
 *   /destroy <name>               Destroy session
 *   (any text)                    Send to attached session
 *   (voice message)               Transcribe and send to attached session
 *
 * Auth tokens are cached per Telegram user ID in the daemon's store.
 */

import { Bot, type Context, InputFile } from "grammy";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { CodeoidConfig } from "../config.js";
import type { ClientMessage, DaemonMessage, SessionInfo } from "../protocol/types.js";

interface UserState {
  ws: WebSocket | null;
  token: string | null;
  authenticated: boolean;
  attachedSessionId: string | null;
  attachedSessionName: string | null;
  pending: Map<string, (msg: DaemonMessage) => void>;
}

export class TelegramBot {
  #bot: Bot;
  #config: CodeoidConfig;
  #users = new Map<number, UserState>();
  #allowedUserIds: Set<number>;

  constructor(config: CodeoidConfig, botToken: string, allowedUserIds: number[]) {
    this.#config = config;
    this.#bot = new Bot(botToken);
    this.#allowedUserIds = new Set(allowedUserIds);
    this.#setupHandlers();
  }

  async start(): Promise<void> {
    console.log("[codeoid] telegram bot starting...");
    await this.#bot.start();
  }

  stop(): void {
    this.#bot.stop();
    for (const state of this.#users.values()) {
      state.ws?.close();
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  #setupHandlers(): void {
    // Gate: only allowed Telegram user IDs
    this.#bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.#allowedUserIds.has(userId)) {
        await ctx.reply("Unauthorized. Your Telegram user ID is not in the allowlist.");
        return;
      }
      await next();
    });

    this.#bot.command("auth", (ctx) => this.#handleAuth(ctx));
    this.#bot.command("ls", (ctx) => this.#handleList(ctx));
    this.#bot.command("new", (ctx) => this.#handleNew(ctx));
    this.#bot.command("attach", (ctx) => this.#handleAttach(ctx));
    this.#bot.command("detach", (ctx) => this.#handleDetach(ctx));
    this.#bot.command("interrupt", (ctx) => this.#handleInterrupt(ctx));
    this.#bot.command("destroy", (ctx) => this.#handleDestroy(ctx));
    this.#bot.command("start", (ctx) =>
      ctx.reply(
        "Codeoid — control your AI agents from here.\n\n" +
          "/auth <api_key> — authenticate\n" +
          "/ls — list sessions\n" +
          "/new <name> <workdir> — create session\n" +
          "/attach <name> — attach\n" +
          "/detach — detach\n" +
          "/interrupt — interrupt agent\n" +
          "/destroy <name> — destroy session\n\n" +
          "Send text or voice to talk to your attached session.",
      ),
    );

    // Voice messages
    this.#bot.on("message:voice", (ctx) => this.#handleVoice(ctx));

    // Text messages (not commands) → send to attached session
    this.#bot.on("message:text", (ctx) => this.#handleText(ctx));
  }

  async #handleAuth(ctx: Context): Promise<void> {
    const userId = ctx.from!.id;
    const apiKey = ctx.message?.text?.split(/\s+/)[1];

    if (!apiKey) {
      await ctx.reply("Usage: /auth <zid_sk_...>");
      return;
    }

    // Delete the message containing the API key for security
    try {
      await ctx.deleteMessage();
    } catch {
      // May not have permission to delete
    }

    try {
      // Exchange API key for JWT
      let token = apiKey;
      if (apiKey.startsWith("zid_sk_")) {
        const resp = await fetch(`${this.#config.zeroidUrl}/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "api_key", api_key: apiKey }),
        });
        if (!resp.ok) {
          await ctx.reply("Authentication failed. Check your API key.");
          return;
        }
        const data = (await resp.json()) as { access_token: string };
        token = data.access_token;
      }

      // Connect to daemon
      const state = this.#getOrCreateState(userId);
      state.token = token;
      await this.#connectToDaemon(userId, ctx);
      await ctx.reply("Authenticated. Use /ls to see sessions.");
    } catch (err) {
      await ctx.reply(`Auth error: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  async #handleList(ctx: Context): Promise<void> {
    const state = this.#getState(ctx);
    if (!state) return;

    const resp = await this.#request(state, { type: "session.list", id: randomUUID() });
    if (resp.type === "session.list.result") {
      if (resp.sessions.length === 0) {
        await ctx.reply("No active sessions.");
        return;
      }
      const lines = resp.sessions.map(
        (s) => `*${this.#escape(s.name)}* — ${s.status} — \`${s.workdir}\``,
      );
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    } else {
      await this.#replyError(ctx, resp);
    }
  }

  async #handleNew(ctx: Context): Promise<void> {
    const state = this.#getState(ctx);
    if (!state) return;

    const parts = ctx.message?.text?.split(/\s+/) ?? [];
    const name = parts[1];
    const workdir = parts[2];

    if (!name || !workdir) {
      await ctx.reply("Usage: /new <name> <workdir>");
      return;
    }

    const resp = await this.#request(state, {
      type: "session.create",
      id: randomUUID(),
      name,
      workdir,
    });

    if (resp.type === "response.ok") {
      const data = resp.data as SessionInfo;
      await ctx.reply(`Session *${this.#escape(data.name)}* created.`, { parse_mode: "Markdown" });
    } else {
      await this.#replyError(ctx, resp);
    }
  }

  async #handleAttach(ctx: Context): Promise<void> {
    const state = this.#getState(ctx);
    if (!state) return;

    const name = ctx.message?.text?.split(/\s+/)[1];
    if (!name) {
      await ctx.reply("Usage: /attach <name>");
      return;
    }

    const sessionId = await this.#resolveSession(state, name);
    if (!sessionId) {
      await ctx.reply(`Session not found: ${name}`);
      return;
    }

    const resp = await this.#request(state, {
      type: "session.attach",
      id: randomUUID(),
      sessionId,
    });

    if (resp.type === "response.ok") {
      state.attachedSessionId = sessionId;
      state.attachedSessionName = name;
      await ctx.reply(`Attached to *${this.#escape(name)}*. Send messages here.`, {
        parse_mode: "Markdown",
      });
    } else {
      await this.#replyError(ctx, resp);
    }
  }

  async #handleDetach(ctx: Context): Promise<void> {
    const state = this.#getState(ctx);
    if (!state) return;

    if (!state.attachedSessionId) {
      await ctx.reply("Not attached to any session.");
      return;
    }

    await this.#request(state, {
      type: "session.detach",
      id: randomUUID(),
      sessionId: state.attachedSessionId,
    });

    const name = state.attachedSessionName;
    state.attachedSessionId = null;
    state.attachedSessionName = null;
    await ctx.reply(`Detached from ${name}.`);
  }

  async #handleInterrupt(ctx: Context): Promise<void> {
    const state = this.#getState(ctx);
    if (!state) return;

    if (!state.attachedSessionId) {
      await ctx.reply("Not attached to any session.");
      return;
    }

    await this.#request(state, {
      type: "session.interrupt",
      id: randomUUID(),
      sessionId: state.attachedSessionId,
    });

    await ctx.reply("Interrupted.");
  }

  async #handleDestroy(ctx: Context): Promise<void> {
    const state = this.#getState(ctx);
    if (!state) return;

    const name = ctx.message?.text?.split(/\s+/)[1];
    if (!name) {
      await ctx.reply("Usage: /destroy <name>");
      return;
    }

    const sessionId = await this.#resolveSession(state, name);
    if (!sessionId) {
      await ctx.reply(`Session not found: ${name}`);
      return;
    }

    await this.#request(state, {
      type: "session.destroy",
      id: randomUUID(),
      sessionId,
    });

    if (state.attachedSessionId === sessionId) {
      state.attachedSessionId = null;
      state.attachedSessionName = null;
    }
    await ctx.reply(`Session *${this.#escape(name)}* destroyed.`, { parse_mode: "Markdown" });
  }

  async #handleText(ctx: Context): Promise<void> {
    const state = this.#getState(ctx);
    if (!state) return;

    const text = ctx.message?.text;
    if (!text || !state.attachedSessionId) {
      if (!state.attachedSessionId) {
        await ctx.reply("Not attached. Use /attach <name> first.");
      }
      return;
    }

    // Handle approval responses
    if (text.toLowerCase() === "yes" || text.toLowerCase() === "approve") {
      await this.#request(state, {
        type: "session.approve",
        id: randomUUID(),
        sessionId: state.attachedSessionId,
        approved: true,
      });
      return;
    }
    if (text.toLowerCase() === "no" || text.toLowerCase() === "deny") {
      await this.#request(state, {
        type: "session.approve",
        id: randomUUID(),
        sessionId: state.attachedSessionId,
        approved: false,
      });
      return;
    }

    await this.#request(state, {
      type: "session.send",
      id: randomUUID(),
      sessionId: state.attachedSessionId,
      text,
    });
  }

  async #handleVoice(ctx: Context): Promise<void> {
    const state = this.#getState(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name> first.");
      return;
    }

    await ctx.reply("Voice transcription not yet implemented. Send text for now.");
    // TODO: Download voice file via ctx.getFile(), send to Whisper API, then forward text
  }

  // ── Connection management ─────────────────────────────────────────────

  #getOrCreateState(userId: number): UserState {
    let state = this.#users.get(userId);
    if (!state) {
      state = {
        ws: null,
        token: null,
        authenticated: false,
        attachedSessionId: null,
        attachedSessionName: null,
        pending: new Map(),
      };
      this.#users.set(userId, state);
    }
    return state;
  }

  #getState(ctx: Context): UserState | null {
    const userId = ctx.from!.id;
    const state = this.#users.get(userId);
    if (!state?.authenticated) {
      ctx.reply("Not authenticated. Use /auth <api_key> first.").catch(() => {});
      return null;
    }
    return state;
  }

  async #connectToDaemon(userId: number, ctx: Context): Promise<void> {
    const state = this.#getOrCreateState(userId);
    const chatId = ctx.chat!.id;

    // Close existing connection
    state.ws?.close();

    return new Promise((resolve, reject) => {
      state.ws = new WebSocket(this.#config.daemonUrl);

      state.ws.on("open", () => {
        state.ws!.send(JSON.stringify({ token: state.token }));
      });

      state.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as DaemonMessage & { type: string; requestId?: string };

        if (msg.type === "auth.ok") {
          state.authenticated = true;
          resolve();
          return;
        }

        // Pending request
        if (msg.requestId && state.pending.has(msg.requestId)) {
          const handler = state.pending.get(msg.requestId)!;
          state.pending.delete(msg.requestId);
          handler(msg as DaemonMessage);
          return;
        }

        // Stream events → send to Telegram chat
        this.#forwardToTelegram(chatId, msg as DaemonMessage).catch(() => {});
      });

      state.ws.on("close", () => {
        state.authenticated = false;
        state.ws = null;
      });

      state.ws.on("error", (err) => {
        reject(err);
      });
    });
  }

  async #forwardToTelegram(chatId: number, msg: DaemonMessage): Promise<void> {
    switch (msg.type) {
      case "agent.output":
        // Chunk long messages (Telegram limit: 4096 chars)
        for (let i = 0; i < msg.content.length; i += 4000) {
          const chunk = msg.content.slice(i, i + 4000);
          await this.#bot.api.sendMessage(chatId, chunk);
        }
        break;
      case "agent.tool_call":
        await this.#bot.api.sendMessage(chatId, `🔧 *${this.#escape(msg.tool)}*`, {
          parse_mode: "Markdown",
        });
        break;
      case "agent.approval_request":
        await this.#bot.api.sendMessage(
          chatId,
          `⚠️ *Permission needed*\n\nTool: \`${this.#escape(msg.tool)}\`\nInput: \`${this.#escape(msg.input.slice(0, 500))}\`\n\nReply *yes* or *no*`,
          { parse_mode: "Markdown" },
        );
        break;
      case "agent.status_change":
        await this.#bot.api.sendMessage(chatId, `Status: ${msg.status}`);
        break;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  #request(state: UserState, msg: ClientMessage): Promise<DaemonMessage> {
    return new Promise((resolve, reject) => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to daemon"));
        return;
      }

      const timeout = setTimeout(() => {
        state.pending.delete(msg.id);
        reject(new Error("Request timeout"));
      }, 30_000);

      state.pending.set(msg.id, (resp) => {
        clearTimeout(timeout);
        resolve(resp);
      });

      state.ws.send(JSON.stringify(msg));
    });
  }

  async #resolveSession(state: UserState, name: string): Promise<string | null> {
    const resp = await this.#request(state, { type: "session.list", id: randomUUID() });
    if (resp.type === "session.list.result") {
      return resp.sessions.find((s) => s.name === name)?.id ?? null;
    }
    return null;
  }

  async #replyError(ctx: Context, resp: DaemonMessage): Promise<void> {
    if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
    }
  }

  #escape(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
  }
}
