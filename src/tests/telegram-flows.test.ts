/**
 * Telegram frontend — authenticated end-to-end handler flows (offline).
 *
 * Extends the injectable-bot pattern of telegram-bot.test.ts with a REAL
 * auth path: an ES256 keypair generated in the test, a local Bun.serve JWKS
 * endpoint, and a properly signed JWT driven through /auth — so
 * `verifyToken` runs for real (no mocks) and every auth-gated handler
 * becomes reachable. The daemon side is a recording fake SessionManager;
 * the goal is exercising the real TelegramFrontend wiring.
 *
 * Flows covered:
 *   - /auth → /ls (escaped MarkdownV2 session lines)
 *   - /new usage + success
 *   - /attach → streamed turn broadcasts → stop button → idle flush → Done
 *   - stale-session broadcasts dropped after switch (isStaleBroadcast gate)
 *   - /attach switch: disconnect → flush buffered + ✂️ marker → settle →
 *     confirmation strictly after the flush
 *   - failed same-session re-attach restores the previous attachment
 *   - /detach: buffered content + marker delivered before the confirmation
 *   - /destroy
 *   - /search long-result plain-text chunked fallback
 *   - tool approval prompt (inline keyboard) + Approve tap → session.approve
 *   - status_change error → "❌ Error."
 */

import { afterAll, afterEach, beforeAll, describe, it, expect } from "bun:test";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { TelegramFrontend } from "../frontends/telegram/index.js";
import type { FrontendContext } from "../frontends/types.js";
import type { AttachedClient } from "../daemon/session.js";
import type { DaemonMessage, ToolState } from "../protocol/types.js";

const ALLOWED_USER = 222;
const CHAT_ID = 777;

// ── Local JWKS server + signed JWT (real verifyToken, no network beyond lo) ──

let jwksServer: ReturnType<typeof Bun.serve>;
let jwt: string;
let authBaseUrl: string;

function b64url(data: Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  return buf.toString("base64url");
}

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pubJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const jwks = {
    keys: [{ ...pubJwk, kid: "test-key", alg: "ES256", use: "sig" }],
  };
  jwksServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/.well-known/jwks.json") {
        return Response.json(jwks);
      }
      return new Response("not found", { status: 404 });
    },
  });
  authBaseUrl = `http://localhost:${jwksServer.port}`;

  const header = { alg: "ES256", typ: "JWT", kid: "test-key" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "user:tester",
    name: "Tester",
    iat: now,
    exp: now + 3600,
    account_id: "acc-1",
    project_id: "proj-1",
    scopes: ["session:attach"],
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  jwt = `${signingInput}.${b64url(new Uint8Array(sig))}`;
});

afterAll(() => {
  jwksServer?.stop(true);
});

// ── Stubbed bot (same seam as telegram-bot.test.ts) ──────────────────────────

const botInfo: UserFromGetMe = {
  id: 43,
  is_bot: true,
  first_name: "codeoid-flows",
  username: "codeoid_flows_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

interface ApiCall {
  method: string;
  payload: any;
}

const startedBots: Bot[] = [];
afterEach(async () => {
  while (startedBots.length > 0) {
    await startedBots.pop()?.stop().catch(() => {});
  }
});

/** Recording fake SessionManager: two known sessions, capture attach clients. */
function makeFakeManager() {
  const sessions: Record<string, { id: string; name: string }> = {
    alpha: { id: "sess-a", name: "alpha" },
    beta: { id: "sess-b", name: "beta" },
  };
  const handled: any[] = [];
  const disconnected: string[] = [];
  const attachClients = new Map<string, AttachedClient>();
  /** Session names whose attach should fail with response.error. */
  const failAttach = new Set<string>();

  const manager = {
    findByName: (name: string) => sessions[name],
    providerIds: () => ["claude", "codex", "pi"],
    disconnectClient: (clientId: string) => {
      disconnected.push(clientId);
    },
    handle: async (msg: any, _auth: unknown, client: AttachedClient) => {
      handled.push(msg);
      switch (msg.type) {
        case "session.fork": {
          // Branch the parent into a new session; keep the parent's backend
          // unless the fork asked for a specific one.
          const parent = Object.values(sessions).find((s) => s.id === msg.sessionId);
          return {
            type: "session.fork.result",
            data: {
              id: "sess-fork",
              name: `${parent?.name ?? "session"} (fork)`,
              providerId: msg.providerId ?? "claude",
            },
          };
        }
        case "session.list":
          return {
            type: "session.list.result",
            sessions: [
              { name: "alpha", status: "tool_running", workdir: "/tmp/my_dir" },
              { name: "beta", status: "idle", workdir: "/w/`tick`" },
            ],
          };
        case "session.attach": {
          const failing = [...failAttach].some((n) => sessions[n]?.id === msg.sessionId);
          if (failing) return { type: "response.error", error: "attach exploded" };
          attachClients.set(msg.sessionId, client);
          return { type: "response.ok" };
        }
        case "session.search":
          return {
            type: "session.search.result",
            sessions: Array.from({ length: 30 }, (_, i) => ({
              sessionName: `session-${i}-${"x".repeat(60)}`,
              matchCount: 3,
              lastMatchAt: Date.now(),
              snippets: [
                { kind: "user_turn", excerpt: "y".repeat(120) },
                { kind: "assistant_turn", excerpt: "z".repeat(120) },
              ],
            })),
          };
        default:
          return { type: "response.ok" };
      }
    },
    handled,
    disconnected,
    attachClients,
    failAttach,
  };
  return manager;
}

function textUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: 10_000 + updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "private" as const, first_name: "u" },
      from: { id: ALLOWED_USER, is_bot: false, first_name: "u" },
      text,
      entities: text.startsWith("/")
        ? [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }]
        : undefined,
    },
  };
}

function callbackUpdate(updateId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: ALLOWED_USER, is_bot: false, first_name: "u" },
      message: {
        message_id: 20_000 + updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT_ID, type: "private" as const, first_name: "u" },
      },
      chat_instance: "ci-1",
      data,
    },
  };
}

/** Wait for an async condition driven by the relay's promise chain. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Boot a frontend with a stubbed bot + fake manager, authenticate via /auth
 * with the real signed JWT (real verifyToken against the local JWKS).
 */
async function boot() {
  const bot = new Bot("43:TEST_TOKEN", { botInfo });
  const calls: ApiCall[] = [];
  let nextMessageId = 1;
  bot.api.config.use(async (_prev, method, payload, signal) => {
    if (method === "getUpdates") {
      if (!signal) return { ok: true, result: [] } as any;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    calls.push({ method, payload });
    return {
      ok: true,
      result: method === "sendMessage" ? { message_id: nextMessageId++ } : true,
    } as any;
  });

  const manager = makeFakeManager();
  const fe = new TelegramFrontend("43:TEST_TOKEN", [ALLOWED_USER], bot);
  const ctx: FrontendContext = {
    manager: manager as never,
    store: { audit() {} } as never,
    auth: { baseUrl: authBaseUrl },
    httpServer: {} as never,
    host: "localhost",
    port: 0,
  };
  await fe.start(ctx);
  startedBots.push(bot);

  let updateId = 1;
  const drive = (text: string) => bot.handleUpdate(textUpdate(updateId++, text));
  const driveCallback = (data: string) => bot.handleUpdate(callbackUpdate(updateId++, data));
  const sent = () => calls.filter((c) => c.method === "sendMessage");
  const texts = () => sent().map((c) => String(c.payload.text));

  // Authenticate with the real signed JWT — exercises verifyToken + JWKS.
  await drive(`/auth ${jwt}`);
  await until(() => texts().some((t) => t.startsWith("Authenticated as Tester")));

  return { bot, fe, manager, calls, drive, driveCallback, sent, texts };
}

// ── Session-scoped daemon broadcast builders ──────────────────────────────────

function assistantMsg(sessionId: string, messageId: string, content: string): DaemonMessage {
  return {
    type: "session.message",
    sessionId,
    messageId,
    role: "assistant",
    content,
    identity: { sub: "agent:x", type: "agent" },
    timestamp: new Date().toISOString(),
  } as DaemonMessage;
}

function deltaMsg(sessionId: string, messageId: string, contentAppend: string): DaemonMessage {
  return {
    type: "session.message.delta",
    sessionId,
    messageId,
    contentAppend,
    timestamp: new Date().toISOString(),
  } as DaemonMessage;
}

function toolCallMsg(
  sessionId: string,
  messageId: string,
  name: string,
  state: ToolState,
): DaemonMessage {
  return {
    type: "session.message",
    sessionId,
    messageId,
    role: "tool_call",
    content: "",
    tool: { toolId: `t-${messageId}`, name, state },
    identity: { sub: "agent:x", type: "agent" },
    timestamp: new Date().toISOString(),
  } as DaemonMessage;
}

function statusMsg(sessionId: string, status: string): DaemonMessage {
  return { type: "session.status_change", sessionId, status } as DaemonMessage;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Telegram flows — auth and /ls", () => {
  it("authenticates via real JWT verification and renders escaped /ls lines", async () => {
    const { drive, sent, texts } = await boot();

    await drive("/ls");
    await until(() => texts().some((t) => t.includes("alpha")));

    const ls = sent().find((c) => String(c.payload.text).includes("alpha"));
    expect(ls).toBeDefined();
    expect(ls!.payload.parse_mode).toBe("MarkdownV2");
    // Escaped runtime values: tool_running underscore, workdir backtick.
    expect(ls!.payload.text).toContain("tool\\_running");
    expect(ls!.payload.text).toContain("`/tmp/my_dir`");
    expect(ls!.payload.text).toContain("\\`tick\\`");
  });

  it("handles /new usage error and success", async () => {
    const { drive, texts, manager } = await boot();

    await drive("/new onlyname");
    await until(() => texts().some((t) => t.startsWith("Usage: /new")));

    await drive("/new gamma /tmp/gamma");
    await until(() => texts().some((t) => t.includes("created")));
    expect(manager.handled.some((m) => m.type === "session.create" && m.name === "gamma")).toBe(true);
  });
});

describe("Telegram flows — attach, streaming turn, idle", () => {
  it("attaches and relays a full streamed turn with stop button and Done", async () => {
    const { drive, manager, calls, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a");
    expect(client).toBeDefined();

    // Turn starts — stop button appears.
    client!.send(statusMsg("sess-a", "thinking"));
    await until(() => texts().some((t) => t.startsWith("⏳ Working")));
    const stopSend = calls.filter((c) => c.method === "sendMessage").findIndex((c) => String(c.payload.text).startsWith("⏳ Working"));
    expect(stopSend).toBeGreaterThanOrEqual(0);

    // Streamed assistant block, interleaved tool call, completion delta.
    client!.send(assistantMsg("sess-a", "m1", ""));
    client!.send(deltaMsg("sess-a", "m1", "Working on it. "));
    client!.send(toolCallMsg("sess-a", "tc1", "Bash", { phase: "executing" }));
    client!.send(deltaMsg("sess-a", "m1", "All done."));
    client!.send({
      type: "session.message.delta",
      sessionId: "sess-a",
      messageId: "tc1",
      toolStateUpdate: { phase: "completed", success: true },
      timestamp: new Date().toISOString(),
    } as DaemonMessage);
    client!.send(assistantMsg("sess-a", "m1", "Working on it. All done."));
    client!.send(statusMsg("sess-a", "idle"));
    await until(() => texts().includes("✅ Done."));

    // Exactly-once, in-order through the REAL frontend wiring.
    const streamTexts = texts().filter((t) =>
      ["Working on it. ", "⚡ Bash", "All done.", "✓ Bash", "✅ Done."].includes(t),
    );
    expect(streamTexts).toEqual(["Working on it. ", "⚡ Bash", "All done.", "✓ Bash", "✅ Done."]);
    // Stop button was removed when the turn ended.
    expect(calls.some((c) => c.method === "deleteMessage")).toBe(true);
  });

  it("renders ❌ on status error and drops stale-session broadcasts", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    // Broadcast from some OTHER session must be dropped by the stale gate.
    client.send(assistantMsg("sess-OLD", "mx", "ghost content"));
    client.send(statusMsg("sess-a", "error"));
    await until(() => texts().includes("❌ Error."));

    expect(texts().some((t) => t.includes("ghost content"))).toBe(false);
  });

  it("tool approval prompt renders inline keyboard and Approve tap resolves it", async () => {
    const { drive, driveCallback, manager, calls, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    client.send(
      toolCallMsg("sess-a", "tc9", "Write", {
        phase: "waiting_confirmation",
        input: {},
        description: "Write(/tmp/f)",
        approvalId: "abcd1234-rest-of-id",
      }),
    );
    await until(() => texts().some((t) => t.startsWith("⚠️ Permission needed")));
    const prompt = calls.filter((c) => c.method === "sendMessage").find((c) => String(c.payload.text).startsWith("⚠️ Permission needed"));
    expect(prompt!.payload.reply_markup).toBeDefined();

    await driveCallback("a:abcd1234:y");
    await until(() =>
      manager.handled.some(
        (m) => m.type === "session.approve" && m.approvalId === "abcd1234-rest-of-id" && m.approved === true,
      ),
    );
    expect(calls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
  });
});

describe("Telegram flows — switch, failed re-attach, detach, destroy, search", () => {
  it("switching sessions flushes buffered content + marker BEFORE the attach confirmation", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    // Buffer streamed-but-unflushed content on alpha.
    client.send(assistantMsg("sess-a", "m1", ""));
    client.send(deltaMsg("sess-a", "m1", "buffered from alpha"));

    await drive("/attach beta");
    await until(() => texts().some((t) => t.includes("Attached to *beta*")));

    const all = texts();
    const iBuffered = all.indexOf("buffered from alpha");
    const iMarker = all.findIndex((t) => t.includes("✂️"));
    const iConfirm = all.findIndex((t) => t.includes("Attached to *beta*"));
    expect(iBuffered).toBeGreaterThanOrEqual(0);
    expect(iMarker).toBeGreaterThan(iBuffered);
    expect(iConfirm).toBeGreaterThan(iMarker);
    expect(manager.disconnected).toContain(`telegram:${ALLOWED_USER}`);
  });

  it("failed same-session re-attach restores the previous attachment", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    manager.failAttach.add("alpha");
    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Error: attach exploded")));

    // Still attached to alpha: live broadcasts keep flowing.
    client.send(assistantMsg("sess-a", "m2", "still attached"));
    await until(() => texts().includes("still attached"));
  });

  it("detach flushes buffered content + marker BEFORE the detach confirmation", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    client.send(assistantMsg("sess-a", "m1", ""));
    client.send(deltaMsg("sess-a", "m1", "tail before detach"));

    await drive("/detach");
    await until(() => texts().some((t) => t.startsWith("Detached from alpha")));

    const all = texts();
    const iTail = all.indexOf("tail before detach");
    const iMarker = all.findIndex((t) => t.includes("✂️"));
    const iConfirm = all.findIndex((t) => t.startsWith("Detached from alpha"));
    expect(iTail).toBeGreaterThanOrEqual(0);
    expect(iMarker).toBeGreaterThan(iTail);
    expect(iConfirm).toBeGreaterThan(iMarker);
    expect(manager.disconnected).toContain(`telegram:${ALLOWED_USER}`);

    // Post-detach broadcasts from the old session are dropped.
    client.send(assistantMsg("sess-a", "m3", "after detach ghost"));
    client.send(statusMsg("sess-a", "idle"));
    await new Promise((r) => setTimeout(r, 25));
    expect(texts().some((t) => t.includes("after detach ghost"))).toBe(false);
  });

  it("destroys a session and confirms with escaped MarkdownV2", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/destroy alpha");
    await until(() => texts().some((t) => t.includes("destroyed")));
    expect(manager.handled.some((m) => m.type === "session.destroy" && m.sessionId === "sess-a")).toBe(true);
  });

  it("falls back to plain-text chunked output for >4096-char search results", async () => {
    const { drive, sent, texts } = await boot();

    await drive("/search needle");
    await until(() => texts().some((t) => t.includes("Search: needle")));

    // The plain-text fallback goes through the relay chunker: no parse_mode.
    const first = sent().find((c) => String(c.payload.text).includes("Search: needle"));
    expect(first!.payload.parse_mode).toBeUndefined();
    for (const c of sent()) {
      expect(String(c.payload.text).length).toBeLessThanOrEqual(4000);
    }
  });
});

describe("Telegram flows — provider switch", () => {
  it("/provider with no arg lists the available backends (first = default)", async () => {
    const { drive, sent, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));

    await drive("/provider");
    await until(() => texts().some((t) => t.includes("Backends")));

    const list = sent().find((c) => String(c.payload.text).includes("Backends"))!;
    expect(list.payload.parse_mode).toBe("MarkdownV2");
    expect(list.payload.text).toContain("claude");
    expect(list.payload.text).toContain("codex");
    expect(list.payload.text).toContain("pi");
    // First backend is tagged as the default (escaped MarkdownV2 parens).
    expect(list.payload.text).toContain("\\(default\\)");
  });

  it("/provider <id> switches the attached session's backend", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));

    await drive("/provider codex");
    await until(() => texts().some((t) => t.includes("Backend →")));

    expect(
      manager.handled.some(
        (m) =>
          m.type === "session.set_provider" &&
          m.providerId === "codex" &&
          m.sessionId === "sess-a",
      ),
    ).toBe(true);
  });

  it("/provider without an attached session tells the user to attach", async () => {
    const { drive, texts } = await boot();

    await drive("/provider codex");
    await until(() => texts().some((t) => t.startsWith("Not attached")));

    expect(texts().some((t) => t.includes("Backend →"))).toBe(false);
  });
});

describe("Telegram flows — fork", () => {
  it("/fork branches the attached session (same backend) and auto-attaches to the branch", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));

    await drive("/fork");
    await until(() => texts().some((t) => t.includes("Forked into")));

    // Fork frame carried NO providerId (parent's backend kept).
    const forkMsg = manager.handled.find((m) => m.type === "session.fork");
    expect(forkMsg).toBeDefined();
    expect(forkMsg.sessionId).toBe("sess-a");
    expect(forkMsg.providerId).toBeUndefined();

    // Auto-attach: parent disconnected, then the fork attached.
    expect(manager.disconnected).toContain(`telegram:${ALLOWED_USER}`);
    expect(
      manager.handled.some((m) => m.type === "session.attach" && m.sessionId === "sess-fork"),
    ).toBe(true);
  });

  it("/fork <backend> continues the branch on another backend in one step", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));

    await drive("/fork codex");
    await until(() => texts().some((t) => t.includes("Forked into")));

    const forkMsg = manager.handled.find((m) => m.type === "session.fork");
    expect(forkMsg.providerId).toBe("codex");
    // The confirmation names the backend it continued on.
    expect(texts().some((t) => t.includes("Forked into") && t.includes("codex"))).toBe(true);
  });

  it("/fork without an attached session tells the user to attach", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/fork");
    await until(() => texts().some((t) => t.startsWith("Not attached")));

    expect(manager.handled.some((m) => m.type === "session.fork")).toBe(false);
  });
});
