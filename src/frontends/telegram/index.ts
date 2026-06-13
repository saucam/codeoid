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

import { Bot, type Context, InlineKeyboard } from "grammy";
import { randomUUID } from "node:crypto";
import { verifyToken } from "../../daemon/auth.js";
import { ALL_SCOPES_STRING } from "../../protocol/scopes.js";
import type { Frontend, FrontendContext } from "../types.js";
import type { SessionManager } from "../../daemon/session-manager.js";
import type { AuthConfig } from "../../daemon/auth.js";
import type {
  AuthContext,
  ClaudeConfigResultMsg,
  DaemonMessage,
  ModelsListResultMsg,
  SessionMode,
  SessionSearchResultMsg,
  ToolInfo,
} from "../../protocol/types.js";
import type { AttachedClient } from "../../daemon/session.js";

/** One AskUserQuestion question as it arrives in the tool input. */
interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/**
 * A pending tool approval awaiting a button tap. Keyed by a short token (the
 * approvalId's first 8 chars) so it fits Telegram's 64-byte callback_data.
 * Concurrent approvals each get their own entry + keyboard.
 */
interface PendingApproval {
  approvalId: string;
  sessionId: string;
  userId: number;
  chatId: number;
  /** Present for AskUserQuestion-style forms; absent for binary approvals. */
  questions?: AskQuestion[];
  /** Collected answers keyed by question text (multi-tap until complete). */
  answers: Record<string, string[]>;
}

interface UserState {
  auth: AuthContext | null;
  attachedSessionId: string | null;
  attachedSessionName: string | null;
  clientId: string;
  /**
   * Per-messageId accumulator for streaming content. Telegram's rate limits
   * make per-token streaming infeasible, so we buffer deltas and flush
   * whenever Claude moves to a new message OR the session goes idle.
   */
  streaming: Map<string, { role: string; content: string }>;
}

export class TelegramFrontend implements Frontend {
  readonly name = "telegram";

  #bot: Bot;
  #allowedUserIds: Set<number>;
  #manager!: SessionManager;
  #authConfig!: AuthConfig;
  #users = new Map<number, UserState>();
  /** Short-token → pending approval, for inline-keyboard tool approvals. */
  #approvals = new Map<string, PendingApproval>();

  constructor(botToken: string, allowedUserIds: number[]) {
    this.#bot = new Bot(botToken);
    this.#allowedUserIds = new Set(allowedUserIds);
  }

  async start(ctx: FrontendContext): Promise<void> {
    this.#manager = ctx.manager;
    this.#authConfig = ctx.auth;
    this.#setupHandlers();
    // Register the command menu so Telegram shows a tappable "/" list with
    // descriptions (autocomplete) instead of making the user remember+type.
    this.#bot.api
      .setMyCommands([
        { command: "ls", description: "List sessions" },
        { command: "new", description: "Create a session: /new <name> <dir>" },
        { command: "attach", description: "Attach to a session: /attach <name>" },
        { command: "detach", description: "Detach from the current session" },
        { command: "interrupt", description: "Stop the current turn" },
        { command: "mode", description: "Set mode: interactive | auto | autonomous" },
        { command: "model", description: "Show or switch the model" },
        { command: "rotate", description: "Fresh context (memory kept)" },
        { command: "rename", description: "Rename the attached session" },
        { command: "search", description: "Search across sessions" },
        { command: "agents", description: "Subagents available" },
        { command: "skills", description: "Skills available" },
        { command: "mcp", description: "MCP servers" },
        { command: "hooks", description: "Configured hooks" },
        { command: "who", description: "Show your identity" },
        { command: "destroy", description: "Destroy a session: /destroy <name>" },
        { command: "auth", description: "Authenticate: /auth <api_key>" },
        { command: "help", description: "Show help" },
      ])
      .catch(() => {});
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

    this.#bot.command("start", (ctx) => this.#handleHelp(ctx));
    this.#bot.command("help", (ctx) => this.#handleHelp(ctx));

    this.#bot.command("auth", (ctx) => this.#handleAuth(ctx));
    this.#bot.command("ls", (ctx) => this.#handleList(ctx));
    this.#bot.command("new", (ctx) => this.#handleNew(ctx));
    this.#bot.command("attach", (ctx) => this.#handleAttach(ctx));
    this.#bot.command("detach", (ctx) => this.#handleDetach(ctx));
    this.#bot.command("interrupt", (ctx) => this.#handleInterrupt(ctx));
    this.#bot.command("destroy", (ctx) => this.#handleDestroy(ctx));
    this.#bot.command("search", (ctx) => this.#handleSearch(ctx));
    this.#bot.command("rename", (ctx) => this.#handleRename(ctx));
    this.#bot.command("rotate", (ctx) => this.#handleRotate(ctx));
    this.#bot.command("mode", (ctx) => this.#handleMode(ctx));
    this.#bot.command("model", (ctx) => this.#handleModel(ctx));
    this.#bot.command("who", (ctx) => this.#handleWho(ctx));
    // Capabilities discovery — mirror the web /agents /skills /mcp /hooks.
    this.#bot.command("agents", (ctx) => this.#handleCapabilities(ctx, "agents"));
    this.#bot.command("skills", (ctx) => this.#handleCapabilities(ctx, "skills"));
    this.#bot.command("mcp", (ctx) => this.#handleCapabilities(ctx, "mcp"));
    this.#bot.command("hooks", (ctx) => this.#handleCapabilities(ctx, "hooks"));

    // Inline-keyboard taps (tool approvals + AskUserQuestion answers).
    this.#bot.on("callback_query:data", (ctx) => this.#handleCallback(ctx));

    this.#bot.on("message:voice", (ctx) => this.#handleVoice(ctx));
    this.#bot.on("message:text", (ctx) => this.#handleText(ctx));
  }

  async #handleHelp(ctx: Context): Promise<void> {
    await ctx.reply(
      "🔮 *Codeoid* — control your AI agents from here\\.\n\n" +
        "*Sessions*\n" +
        "/ls — list · /new `<name>` `<dir>` — create\n" +
        "/attach `<name>` · /detach · /destroy `<name>`\n" +
        "/rename `<name>` · /search `<query>`\n\n" +
        "*Run control*\n" +
        "/interrupt — stop the current turn\n" +
        "/rotate — fresh context, memory kept\n" +
        "/mode `<interactive|auto|autonomous>`\n" +
        "/model `[name]` — show/switch model\n\n" +
        "*Discover*\n" +
        "/agents · /skills · /mcp · /hooks · /who\n\n" +
        "Send text to talk to the attached session\\. Tool approvals show\n" +
        "*Approve*/*Deny* buttons\\.",
      { parse_mode: "MarkdownV2" },
    );
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
        const icon =
          s.status === "idle"
            ? "🟢"
            : s.status === "thinking" || s.status === "tool_running"
              ? "🟡"
              : "🔴";
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
    const userId = ctx.from!.id;
    const client: AttachedClient = {
      id: state.clientId,
      auth: state.auth!,
      send: (msg: DaemonMessage) => this.#forwardToChat(chatId, userId, msg),
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

  // ── Search ──────────────────────────────────────────────────────────────

  async #handleSearch(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;

    const query = (ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "").trim();
    if (!query) {
      await ctx.reply("Usage: /search <query>\n\nSearches across all sessions in the workspace.");
      return;
    }

    const resp = await this.#manager.handle(
      {
        type: "session.search",
        id: randomUUID(),
        query,
        scope: "workspace",
        limit: 5,
      },
      state.auth!,
      this.#makeClient(state, ctx),
    );

    if (resp.type === "response.error") {
      await ctx.reply(`Search error: ${resp.error}`);
      return;
    }

    if (resp.type !== "session.search.result") return;

    const results = resp as SessionSearchResultMsg;
    if (results.sessions.length === 0) {
      await ctx.reply(`No results for "${query}".`);
      return;
    }

    const lines: string[] = [];
    lines.push(`🔍 *Search: ${escMd(query)}*\n`);

    for (const hit of results.sessions) {
      const when = formatAgo(hit.lastMatchAt);
      const matchLabel = `${hit.matchCount} match${hit.matchCount === 1 ? "" : "es"}`;
      lines.push(
        `▸ *${escMd(hit.sessionName)}* — ${escMd(matchLabel)} · ${escMd(when)}`,
      );

      for (const snippet of hit.snippets.slice(0, 2)) {
        const prefix =
          snippet.kind === "user_turn"
            ? "you"
            : snippet.kind === "assistant_turn"
              ? "claude"
              : snippet.toolName ?? "tool";
        const excerpt = snippet.excerpt
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);
        lines.push(`  _${escMd(prefix)}:_ ${escMd(excerpt)}`);
      }
      lines.push("");
    }

    lines.push(`Use /attach \\<name\\> to jump into a session\\.`);

    // Telegram has a 4096-char limit; chunk if needed
    const text = lines.join("\n");
    if (text.length <= 4096) {
      await ctx.reply(text, { parse_mode: "MarkdownV2" });
    } else {
      // Fall back to plain text for very long results
      const plain = lines.join("\n").replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
      this.#sendChunked(ctx.chat!.id, plain);
    }
  }

  // ── Run control ───────────────────────────────────────────────────────

  async #handleRename(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;
    if (!state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name> first.");
      return;
    }
    const name = ctx.message?.text?.split(/\s+/).slice(1).join(" ").trim();
    if (!name) {
      await ctx.reply("Usage: /rename <new name>");
      return;
    }
    const resp = await this.#manager.handle(
      { type: "session.rename", id: randomUUID(), sessionId: state.attachedSessionId, name },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
      return;
    }
    state.attachedSessionName = name;
    await ctx.reply(`Renamed to *${escMd(name)}*\\.`, { parse_mode: "MarkdownV2" });
  }

  async #handleRotate(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }
    await this.#manager.handle(
      { type: "session.rotate", id: randomUUID(), sessionId: state.attachedSessionId },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    await ctx.reply("🔄 Context rotated — memory preserved.");
  }

  async #handleMode(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }
    const arg = ctx.message?.text?.split(/\s+/)[1]?.toLowerCase();
    const mode: SessionMode | undefined =
      arg === "i" || arg === "interactive"
        ? "interactive"
        : arg === "a" || arg === "auto" || arg === "auto-allow"
          ? "auto-allow"
          : arg === "x" || arg === "autonomous"
            ? "autonomous"
            : undefined;
    if (!mode) {
      await ctx.reply(
        "Usage: /mode <interactive|auto|autonomous>\n" +
          "  interactive — every tool asks first\n" +
          "  auto — Read/Grep/Glob auto; Write/Bash ask\n" +
          "  autonomous — every tool auto-approved",
      );
      return;
    }
    const resp = await this.#manager.handle(
      { type: "session.set_mode", id: randomUUID(), sessionId: state.attachedSessionId, mode },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
      return;
    }
    await ctx.reply(`Mode → *${escMd(mode)}*\\.`, { parse_mode: "MarkdownV2" });
  }

  async #handleModel(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }
    const arg = ctx.message?.text?.split(/\s+/)[1];
    if (!arg) {
      // No argument → list the live model catalog.
      const resp = await this.#manager.handle(
        { type: "models.list", id: randomUUID() },
        state.auth!,
        this.#makeClient(state, ctx),
      );
      if (resp.type !== "models.list.result") {
        await ctx.reply("Could not fetch models.");
        return;
      }
      const list = (resp as ModelsListResultMsg).models
        .map((m) => `• \`${escMd(m.value)}\` — ${escMd(m.displayName)}${m.isDefault ? " \\(default\\)" : ""}`)
        .join("\n");
      await ctx.reply(
        `*Models* \\(use /model \\<name\\>\\)\n${list}`,
        { parse_mode: "MarkdownV2" },
      );
      return;
    }
    const resp = await this.#manager.handle(
      { type: "session.set_model", id: randomUUID(), sessionId: state.attachedSessionId, model: arg },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
      return;
    }
    await ctx.reply(`Model → *${escMd(arg)}*\\.`, { parse_mode: "MarkdownV2" });
  }

  // ── Discovery ─────────────────────────────────────────────────────────

  async #handleWho(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;
    const a = state.auth!;
    const lines = [
      "*Identity*",
      `sub: \`${escMd(a.sub)}\``,
      a.name ? `name: ${escMd(a.name)}` : "",
      a.accountId ? `account: \`${escMd(a.accountId)}\`` : "",
      a.projectId ? `project: \`${escMd(a.projectId)}\`` : "",
      `scopes: ${escMd((a.scopes ?? []).join(", ") || "none")}`,
      a.delegationDepth ? `delegation depth: ${a.delegationDepth}` : "",
    ].filter(Boolean);
    await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
  }

  async #handleCapabilities(
    ctx: Context,
    tab: "agents" | "skills" | "mcp" | "hooks",
  ): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }
    const resp = await this.#manager.handle(
      { type: "claude.config", id: randomUUID(), sessionId: state.attachedSessionId },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    if (resp.type !== "claude.config.result") {
      await ctx.reply("Could not fetch capabilities.");
      return;
    }
    const cfg = resp as ClaudeConfigResultMsg;
    let lines: string[];
    if (tab === "agents") {
      lines = cfg.agents.map((a) => `• *${escMd(a.name)}* — ${escMd(a.description ?? "")}`);
    } else if (tab === "skills") {
      lines = cfg.skills.map((s) => `• *${escMd(s.name)}* — ${escMd(s.description ?? "")}`);
    } else if (tab === "mcp") {
      lines = cfg.mcpServers.map(
        (m) => `• *${escMd(m.name)}* — ${escMd(m.command ?? m.scope)}`,
      );
    } else {
      lines = cfg.hooks.map((h) => `• \`${escMd(h.command)}\``);
    }
    const title = { agents: "Subagents", skills: "Skills", mcp: "MCP servers", hooks: "Hooks" }[tab];
    await ctx.reply(
      `*${escMd(title)}*\n${lines.length ? lines.join("\n") : "_none_"}`,
      { parse_mode: "MarkdownV2" },
    );
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

    // Tool approvals go through the inline Approve/Deny buttons (precise
    // approvalId, concurrent-safe), so plain text is always a message to the
    // session — no "yes"/"no" interception.
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

  #forwardToChat(chatId: number, userId: number, msg: DaemonMessage): void {
    const state = this.#users.get(userId);
    const send = (text: string, opts?: { parse_mode?: string }) =>
      this.#bot.api.sendMessage(chatId, text, opts as Record<string, unknown>).catch(() => {});

    switch (msg.type) {
      case "session.message": {
        const m = msg;
        // Flush any buffered streams that are stale (different messageId).
        if (state) this.#flushStale(chatId, state, m.messageId);

        switch (m.role) {
          case "user":
            // Echo of our own send — no need to replay.
            break;
          case "assistant":
            if (m.content) {
              this.#sendChunked(chatId, m.content);
            } else if (state) {
              // Empty assistant = start of a streaming block.
              state.streaming.set(m.messageId, { role: "assistant", content: "" });
            }
            break;
          case "thinking":
            if (m.content) {
              send(`💭 _thinking_\n${m.content.slice(0, 800)}`, { parse_mode: "Markdown" });
            } else if (state) {
              state.streaming.set(m.messageId, { role: "thinking", content: "" });
            }
            break;
          case "tool_call": {
            if (!m.tool) break;
            const phase = m.tool.state.phase;
            if (phase === "waiting_confirmation" && "approvalId" in m.tool.state) {
              // Inline Approve/Deny (or AskUserQuestion option buttons) keyed
              // to the exact approvalId — handles concurrent approvals.
              this.#sendApproval(chatId, userId, m.tool);
            } else if (phase === "executing") {
              send(`⚡ ${m.tool.name}`);
            } else if (phase === "completed") {
              send(`✓ ${m.tool.name}`);
            } else if (phase === "cancelled") {
              send(`✗ ${m.tool.name} cancelled`);
            }
            break;
          }
          case "system":
            if (m.content) send(`⚠️ ${m.content}`);
            break;
          case "info":
            // Quiet by default on mobile.
            break;
        }
        break;
      }

      case "session.message.delta": {
        // Buffer; don't stream to Telegram per-token (rate limits).
        if (!state) break;
        const buf = state.streaming.get(msg.messageId);
        if (buf && msg.contentAppend) {
          buf.content += msg.contentAppend;
        }
        break;
      }

      case "session.status_change": {
        if (msg.status === "idle") {
          // Session done — flush any remaining buffered streams.
          if (state) {
            for (const [, buf] of state.streaming) {
              this.#flushBuffer(chatId, buf);
            }
            state.streaming.clear();
          }
          send("✅ Done.");
        } else if (msg.status === "error") {
          send("❌ Error.");
        }
        break;
      }
    }
  }

  // ── Tool approvals (inline keyboard) ──────────────────────────────────

  /**
   * Render a tool-approval prompt with inline buttons. Binary approvals get
   * Approve/Deny; AskUserQuestion-style tools get one message per question
   * with a button per option. Each is keyed to the exact approvalId so
   * concurrent approvals don't collide.
   */
  #sendApproval(chatId: number, userId: number, tool: ToolInfo): void {
    if (tool.state.phase !== "waiting_confirmation") return;
    const state = this.#users.get(userId);
    const sessionId = state?.attachedSessionId;
    if (!sessionId) return;

    const approvalId = tool.state.approvalId;
    const short = approvalId.slice(0, 8);
    const input = (tool.input ?? {}) as { questions?: unknown };
    const rawQuestions = Array.isArray(input.questions) ? input.questions : null;
    const questions: AskQuestion[] | undefined = rawQuestions
      ?.filter(
        (q): q is AskQuestion =>
          !!q &&
          typeof q === "object" &&
          typeof (q as AskQuestion).question === "string" &&
          Array.isArray((q as AskQuestion).options),
      )
      .map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiSelect,
        options: q.options.filter((o) => o && typeof o.label === "string"),
      }));

    this.#approvals.set(short, {
      approvalId,
      sessionId,
      userId,
      chatId,
      questions,
      answers: {},
    });

    if (questions && questions.length > 0) {
      questions.forEach((q, qi) => {
        const kb = new InlineKeyboard();
        q.options.forEach((opt, oi) => {
          kb.text(opt.label, `q:${short}:${qi}:${oi}`).row();
        });
        const head = q.header ? `*${escMd(q.header)}* — ` : "";
        this.#bot.api
          .sendMessage(chatId, `❓ ${head}${escMd(q.question)}`, {
            parse_mode: "MarkdownV2",
            reply_markup: kb,
          } as Record<string, unknown>)
          .catch(() => {});
      });
      return;
    }

    const desc =
      "description" in tool.state ? tool.state.description : tool.name;
    const kb = new InlineKeyboard()
      .text("✅ Approve", `a:${short}:y`)
      .text("❌ Deny", `a:${short}:n`);
    this.#bot.api
      .sendMessage(
        chatId,
        `⚠️ Permission needed — ${tool.name}\n${String(desc).slice(0, 800)}`,
        { reply_markup: kb } as Record<string, unknown>,
      )
      .catch(() => {});
  }

  /** Handle an inline-keyboard tap (approval decision / question answer). */
  async #handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const [kind, short, ...rest] = data.split(":");
    const pending = short ? this.#approvals.get(short) : undefined;
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "This prompt expired." }).catch(() => {});
      return;
    }
    const state = this.#users.get(pending.userId);
    if (!state?.auth) {
      await ctx.answerCallbackQuery({ text: "Not authenticated." }).catch(() => {});
      return;
    }
    const client: AttachedClient = {
      id: state.clientId,
      auth: state.auth,
      send: (m: DaemonMessage) => this.#forwardToChat(pending.chatId, pending.userId, m),
    };

    if (kind === "a") {
      const approved = rest[0] === "y";
      this.#approvals.delete(short);
      await this.#manager.handle(
        {
          type: "session.approve",
          id: randomUUID(),
          sessionId: pending.sessionId,
          approvalId: pending.approvalId,
          approved,
        },
        state.auth,
        client,
      );
      await ctx.answerCallbackQuery({ text: approved ? "Approved" : "Denied" }).catch(() => {});
      await ctx.editMessageText(approved ? "✅ Approved" : "❌ Denied").catch(() => {});
      return;
    }

    if (kind === "q" && pending.questions) {
      const qi = Number(rest[0]);
      const oi = Number(rest[1]);
      const q = pending.questions[qi];
      const opt = q?.options[oi];
      if (!q || !opt) {
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }
      pending.answers[q.question] = [opt.label];
      await ctx.answerCallbackQuery({ text: `${q.header ?? "Answer"}: ${opt.label}` }).catch(() => {});
      await ctx
        .editMessageText(`❓ ${q.question}\n→ ${opt.label}`)
        .catch(() => {});
      // Submit once every question has an answer.
      if (Object.keys(pending.answers).length >= pending.questions.length) {
        this.#approvals.delete(short);
        const answers: Record<string, string> = {};
        for (const qq of pending.questions) {
          answers[qq.question] = (pending.answers[qq.question] ?? []).join(", ");
        }
        await this.#manager.handle(
          {
            type: "session.approve",
            id: randomUUID(),
            sessionId: pending.sessionId,
            approvalId: pending.approvalId,
            approved: true,
            updatedInput: { answers },
          },
          state.auth,
          client,
        );
      }
    }
  }

  /** Flush buffered streams whose messageId is no longer current. */
  #flushStale(chatId: number, state: UserState, currentMessageId: string): void {
    for (const [id, buf] of state.streaming) {
      if (id !== currentMessageId) {
        this.#flushBuffer(chatId, buf);
        state.streaming.delete(id);
      }
    }
  }

  #flushBuffer(chatId: number, buf: { role: string; content: string }): void {
    if (!buf.content) return;
    if (buf.role === "thinking") {
      this.#bot.api
        .sendMessage(chatId, `💭 _thinking_\n${buf.content.slice(0, 1500)}`, {
          parse_mode: "Markdown",
        } as Record<string, unknown>)
        .catch(() => {});
    } else {
      this.#sendChunked(chatId, buf.content);
    }
  }

  #sendChunked(chatId: number, text: string): void {
    for (let i = 0; i < text.length; i += 4000) {
      this.#bot.api.sendMessage(chatId, text.slice(i, i + 4000)).catch(() => {});
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
        streaming: new Map(),
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
    const userId = ctx.from!.id;
    return {
      id: state.clientId,
      auth: state.auth!,
      send: (msg: DaemonMessage) => this.#forwardToChat(chatId, userId, msg),
    };
  }
}

/** Escape MarkdownV2 special characters. */
function escMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => "\\" + m);
}

/** @deprecated — legacy esc used elsewhere in this file. */
function esc(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/** Relative time string from a unix-ms timestamp. */
function formatAgo(when: number): string {
  const dt = Math.max(0, Date.now() - when);
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return Math.round(dt / 60_000) + "m ago";
  if (dt < 86_400_000) return Math.round(dt / 3_600_000) + "h ago";
  return Math.round(dt / 86_400_000) + "d ago";
}
