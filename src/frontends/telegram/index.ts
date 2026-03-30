/**
 * Telegram frontend plugin.
 *
 * Runs inside the daemon process — talks directly to the SessionManager,
 * no WebSocket hop. Enabled when TELEGRAM_BOT_TOKEN is set.
 *
 * Commands:
 *   /auth <api_key>          Authenticate with ZeroID
 *   /ls                      List sessions
 *   /new <name> <workdir>    Create session
 *   /attach <name>           Attach (receive streaming output)
 *   /detach                  Detach from current session
 *   /interrupt               Interrupt running agent
 *   /destroy <name>          Destroy session
 *   (any text)               Send to attached session
 *   (voice)                  Transcribe and send (future)
 */

import { Bot, type Context } from "grammy";
import { randomUUID } from "node:crypto";
import { verifyToken } from "../../daemon/auth.js";
import { ALL_SCOPES_STRING } from "../../protocol/scopes.js";
import type { Frontend, FrontendContext } from "../types.js";
import type { SessionManager } from "../../daemon/session-manager.js";
import type { AuthConfig } from "../../daemon/auth.js";
import type { AuthContext, DaemonMessage } from "../../protocol/types.js";
import type { AttachedClient } from "../../daemon/session.js";

interface UserState {
  auth: AuthContext | null;
  attachedSessionId: string | null;
  attachedSessionName: string | null;
  clientId: string;
}

export class TelegramFrontend implements Frontend {
  readonly name = "telegram";

  #bot: Bot;
  #allowedUserIds: Set<number>;
  #manager!: SessionManager;
  #authConfig!: AuthConfig;
  #users = new Map<number, UserState>();

  constructor(botToken: string, allowedUserIds: number[]) {
    this.#bot = new Bot(botToken);
    this.#allowedUserIds = new Set(allowedUserIds);
  }

  async start(ctx: FrontendContext): Promise<void> {
    this.#manager = ctx.manager;
    this.#authConfig = ctx.auth;
    this.#setupHandlers();
    // Don't await — long-polling runs forever
    this.#bot.start().catch((err) => {
      console.error("[codeoid:telegram] bot crashed:", err);
    });
  }

  async stop(): Promise<void> {
    this.#bot.stop();
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  #setupHandlers(): void {
    // Gate: only allowed Telegram user IDs
    this.#bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.#allowedUserIds.has(userId)) {
        await ctx.reply("Unauthorized.");
        return;
      }
      await next();
    });

    this.#bot.command("start", (ctx) =>
      ctx.reply(
        "🔮 *Codeoid* — control your AI agents from here\\.\n\n" +
          "/auth `<api_key>` — authenticate\n" +
          "/ls — list sessions\n" +
          "/new `<name>` `<workdir>` — create session\n" +
          "/attach `<name>` — attach\n" +
          "/detach — detach\n" +
          "/interrupt — interrupt agent\n" +
          "/destroy `<name>` — destroy session\n\n" +
          "Send text to talk to your attached session\\.",
        { parse_mode: "MarkdownV2" },
      ),
    );

    this.#bot.command("auth", (ctx) => this.#handleAuth(ctx));
    this.#bot.command("ls", (ctx) => this.#handleList(ctx));
    this.#bot.command("new", (ctx) => this.#handleNew(ctx));
    this.#bot.command("attach", (ctx) => this.#handleAttach(ctx));
    this.#bot.command("detach", (ctx) => this.#handleDetach(ctx));
    this.#bot.command("interrupt", (ctx) => this.#handleInterrupt(ctx));
    this.#bot.command("destroy", (ctx) => this.#handleDestroy(ctx));

    this.#bot.on("message:voice", (ctx) => this.#handleVoice(ctx));
    this.#bot.on("message:text", (ctx) => this.#handleText(ctx));
  }

  // ── Auth ──────────────────────────────────────────────────────────────

  async #handleAuth(ctx: Context): Promise<void> {
    const userId = ctx.from!.id;
    const apiKey = ctx.message?.text?.split(/\s+/)[1];

    if (!apiKey) {
      await ctx.reply("Usage: /auth <zid_sk_...>");
      return;
    }

    // Delete message containing the API key
    try { await ctx.deleteMessage(); } catch { /* may lack permission */ }

    try {
      let token = apiKey;
      if (apiKey.startsWith("zid_sk_")) {
        const zeroidUrl = this.#authConfig.baseUrl;
        const resp = await fetch(`${zeroidUrl}/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "api_key", api_key: apiKey, scope: ALL_SCOPES_STRING }),
        });
        if (!resp.ok) {
          await ctx.reply("Authentication failed. Check your API key.");
          return;
        }
        token = ((await resp.json()) as { access_token: string }).access_token;
      }

      const auth = await verifyToken(token, this.#authConfig);
      const state = this.#getOrCreate(userId);
      state.auth = auth;

      await ctx.reply(`Authenticated as ${auth.name ?? auth.sub}. Use /ls to see sessions.`);
    } catch (err) {
      await ctx.reply(`Auth error: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  // ── Session commands (direct to SessionManager, no network) ───────────

  async #handleList(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;

    const resp = await this.#manager.handle(
      { type: "session.list", id: randomUUID() },
      state.auth!,
      this.#makeClient(state, ctx),
    );

    if (resp.type === "session.list.result") {
      if (resp.sessions.length === 0) {
        await ctx.reply("No active sessions.");
        return;
      }
      const lines = resp.sessions.map((s) => {
        const icon = s.status === "idle" ? "🟢" : s.status === "working" ? "🟡" : "🔴";
        return `${icon} *${esc(s.name)}* — ${s.status}\n   \`${s.workdir}\``;
      });
      await ctx.reply(lines.join("\n\n"), { parse_mode: "MarkdownV2" });
    }
  }

  async #handleNew(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;

    const parts = ctx.message?.text?.split(/\s+/) ?? [];
    const name = parts[1];
    const workdir = parts[2];
    if (!name || !workdir) {
      await ctx.reply("Usage: /new <name> <workdir>");
      return;
    }

    const resp = await this.#manager.handle(
      { type: "session.create", id: randomUUID(), name, workdir },
      state.auth!,
      this.#makeClient(state, ctx),
    );

    if (resp.type === "response.ok") {
      await ctx.reply(`Session *${esc(name)}* created\\.`, { parse_mode: "MarkdownV2" });
    } else if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
    }
  }

  async #handleAttach(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;

    const name = ctx.message?.text?.split(/\s+/)[1];
    if (!name) {
      await ctx.reply("Usage: /attach <name>");
      return;
    }

    const session = this.#manager.findByName(name);
    if (!session) {
      await ctx.reply(`Session not found: ${name}`);
      return;
    }

    const chatId = ctx.chat!.id;
    const client: AttachedClient = {
      id: state.clientId,
      auth: state.auth!,
      send: (msg: DaemonMessage) => this.#forwardToChat(chatId, msg),
    };

    const resp = await this.#manager.handle(
      { type: "session.attach", id: randomUUID(), sessionId: session.id },
      state.auth!,
      client,
    );

    if (resp.type === "response.ok") {
      state.attachedSessionId = session.id;
      state.attachedSessionName = name;
      await ctx.reply(`Attached to *${esc(name)}*\\. Send messages here\\.`, { parse_mode: "MarkdownV2" });
    } else if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
    }
  }

  async #handleDetach(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached to any session.");
      return;
    }

    this.#manager.disconnectClient(state.clientId);
    const name = state.attachedSessionName;
    state.attachedSessionId = null;
    state.attachedSessionName = null;
    await ctx.reply(`Detached from ${name}.`);
  }

  async #handleInterrupt(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached to any session.");
      return;
    }

    await this.#manager.handle(
      { type: "session.interrupt", id: randomUUID(), sessionId: state.attachedSessionId },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    await ctx.reply("Interrupted.");
  }

  async #handleDestroy(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;

    const name = ctx.message?.text?.split(/\s+/)[1];
    if (!name) {
      await ctx.reply("Usage: /destroy <name>");
      return;
    }

    const session = this.#manager.findByName(name);
    if (!session) {
      await ctx.reply(`Session not found: ${name}`);
      return;
    }

    await this.#manager.handle(
      { type: "session.destroy", id: randomUUID(), sessionId: session.id },
      state.auth!,
      this.#makeClient(state, ctx),
    );

    if (state.attachedSessionId === session.id) {
      state.attachedSessionId = null;
      state.attachedSessionName = null;
    }
    await ctx.reply(`Session *${esc(name)}* destroyed\\.`, { parse_mode: "MarkdownV2" });
  }

  // ── Text & voice ─────────────────────────────────────────────────────

  async #handleText(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;

    const text = ctx.message?.text;
    if (!text || !state.attachedSessionId) {
      if (!state.attachedSessionId) await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }

    // Approval shorthand
    const lower = text.toLowerCase().trim();
    if (lower === "yes" || lower === "approve" || lower === "no" || lower === "deny") {
      await this.#manager.handle(
        {
          type: "session.approve",
          id: randomUUID(),
          sessionId: state.attachedSessionId,
          approved: lower === "yes" || lower === "approve",
        },
        state.auth!,
        this.#makeClient(state, ctx),
      );
      return;
    }

    await this.#manager.handle(
      { type: "session.send", id: randomUUID(), sessionId: state.attachedSessionId, text },
      state.auth!,
      this.#makeClient(state, ctx),
    );
  }

  async #handleVoice(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }
    await ctx.reply("🎙 Voice transcription coming soon. Send text for now.");
  }

  // ── Forward agent output to Telegram chat ─────────────────────────────

  #forwardToChat(chatId: number, msg: DaemonMessage): void {
    const send = (text: string, opts?: { parse_mode?: string }) =>
      this.#bot.api.sendMessage(chatId, text, opts as Record<string, unknown>).catch(() => {});

    switch (msg.type) {
      case "agent.output":
        // Chunk for Telegram's 4096 char limit
        for (let i = 0; i < msg.content.length; i += 4000) {
          send(msg.content.slice(i, i + 4000));
        }
        break;
      case "agent.tool_call":
        send(`🔧 ${msg.tool}`);
        break;
      case "agent.approval_request":
        send(
          `⚠️ *Permission needed*\n\nTool: \`${esc(msg.tool)}\`\nInput: \`${esc(msg.input.slice(0, 500))}\`\n\nReply *yes* or *no*`,
          { parse_mode: "MarkdownV2" },
        );
        break;
      case "agent.status_change":
        if (msg.status === "idle") send("✅ Agent finished.");
        else if (msg.status === "error") send("❌ Agent error.");
        break;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  #getOrCreate(userId: number): UserState {
    let state = this.#users.get(userId);
    if (!state) {
      state = {
        auth: null,
        attachedSessionId: null,
        attachedSessionName: null,
        clientId: `telegram:${userId}`,
      };
      this.#users.set(userId, state);
    }
    return state;
  }

  #requireAuth(ctx: Context): UserState | null {
    const state = this.#users.get(ctx.from!.id);
    if (!state?.auth) {
      ctx.reply("Not authenticated. Use /auth <api_key>.").catch(() => {});
      return null;
    }
    return state;
  }

  #makeClient(state: UserState, ctx: Context): AttachedClient {
    const chatId = ctx.chat!.id;
    return {
      id: state.clientId,
      auth: state.auth!,
      send: (msg: DaemonMessage) => this.#forwardToChat(chatId, msg),
    };
  }
}

/** Escape MarkdownV2 special characters. */
function esc(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}
