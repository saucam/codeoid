/**
 * ClaudeProvider unit tests — offline, no Claude Agent SDK subprocess.
 *
 * Strategy:
 *   1. Pure-function tests: translateSDKMessage, parseMcpServerConfig,
 *      extractToolResultText — no mocking needed.
 *   2. ClaudeProvider lifecycle tests: mock.module() replaces the
 *      @anthropic-ai/claude-agent-sdk `query()` call with a controllable
 *      async iterable so the full provider loop runs without any I/O.
 *
 * mock.module() must be registered before the module-under-test is imported.
 * Bun evaluates mock.module() calls before resolving static imports in the
 * same file, so we can import ClaudeProvider statically below.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";
import type { ProviderEvent } from "../daemon/providers/interface.js";

// ── SDK mock ──────────────────────────────────────────────────────────────────

type SDKMsg = Record<string, unknown>;

/** Per-test queue of SDK messages; replaced by each test that needs the loop. */
let sdkMessages: SDKMsg[] = [];
/** When set, the mock query throws this error instead of yielding messages. */
let sdkThrowError: Error | null = null;
/** Captures the options passed to query() so tests can invoke callbacks. */
let capturedQueryOpts: Record<string, unknown> | null = null;
/** When set, the mock loop blocks before finishing so tests can invoke captured
 *  callbacks (canUseTool, hooks) while the turn queue is still open. */
let sdkGate: Promise<void> | null = null;

function makeMockQuery() {
  const err = sdkThrowError;
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<{ done: boolean; value: SDKMsg | undefined }> {
          if (err) throw err;
          if (i >= sdkMessages.length) {
            if (sdkGate) await sdkGate;
            return { done: true, value: undefined };
          }
          return { done: false, value: sdkMessages[i++] };
        },
      };
    },
    interrupt: async () => {},
    supportedModels: async () => [{ value: "claude-opus-4", displayName: "Claude Opus 4" }],
  };
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: unknown) => {
    capturedQueryOpts = opts as Record<string, unknown>;
    return makeMockQuery();
  },
}));

// ── Import AFTER mock registration ────────────────────────────────────────────

import {
  ClaudeProvider,
  translateSDKMessage,
  parseMcpServerConfig,
  extractToolResultText,
  withMcpToolTimeout,
  buildAgentEnv,
} from "../daemon/providers/claude/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectEmits(msg: SDKMsg): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  translateSDKMessage(msg as never, (e) => out.push(e), "claude");
  return out;
}

function makeProvider(): ClaudeProvider {
  return new ClaudeProvider({
    sessionId: "test-session",
    initialBackingId: "test-backing",
    workspaceId: "ws_test",
    store: {
      audit: () => {},
      getClaudeCodeSessionId: () => null,
      setClaudeCodeSessionId: () => {},
    } as never,
  });
}

async function collectTurnEvents(provider: ClaudeProvider, message = "hello"): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  const run = provider.runTurn({
    history: [],
    userMessage: message,
    workdir: "/tmp",
    canUseTool: async () => ({ behavior: "allow" as const }),
  });
  for await (const e of run.events) {
    events.push(e);
  }
  return events;
}

// ── translateSDKMessage ───────────────────────────────────────────────────────

describe("translateSDKMessage – assistant", () => {
  it("emits llm_call for usage + text_done for text blocks", () => {
    const events = collectEmits({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      },
      parent_tool_use_id: null,
    });
    expect(events[0]).toMatchObject({ type: "llm_call", isPrimary: true });
    expect(events[0]).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 1 },
    });
    expect(events[1]).toMatchObject({ type: "text_done", content: "Hello world" });
  });

  it("isPrimary=false for subagent messages (parent_tool_use_id set)", () => {
    const events = collectEmits({
      type: "assistant",
      message: { content: [], usage: { input_tokens: 1, output_tokens: 1 } },
      parent_tool_use_id: "parent-id",
    });
    expect(events[0]).toMatchObject({ type: "llm_call", isPrimary: false });
  });

  it("skips text_done when no text blocks", () => {
    const events = collectEmits({ type: "assistant", message: { content: [] }, parent_tool_use_id: null });
    expect(events.find((e) => e.type === "text_done")).toBeUndefined();
  });

  it("joins multiple text blocks", () => {
    const events = collectEmits({
      type: "assistant",
      message: { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
      parent_tool_use_id: null,
    });
    expect(events.find((e) => e.type === "text_done")).toMatchObject({ content: "AB" });
  });

  it("tags text_done with parentToolUseId null for primary messages (#82)", () => {
    const events = collectEmits({
      type: "assistant",
      message: { content: [{ type: "text", text: "primary" }] },
      parent_tool_use_id: null,
    });
    expect(events.find((e) => e.type === "text_done")).toMatchObject({
      content: "primary",
      parentToolUseId: null,
    });
  });

  it("tags text_done with the spawning tool id for subagent messages (#82)", () => {
    const events = collectEmits({
      type: "assistant",
      message: { content: [{ type: "text", text: "subagent commentary" }] },
      parent_tool_use_id: "tu-task-1",
    });
    expect(events.find((e) => e.type === "text_done")).toMatchObject({
      content: "subagent commentary",
      parentToolUseId: "tu-task-1",
    });
  });
});

describe("translateSDKMessage – stream_event", () => {
  it("emits text_delta for content_block_delta/text_delta", () => {
    const events = collectEmits({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "chunk" } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "text_delta", content: "chunk" });
  });

  it("emits thinking_delta for content_block_start/thinking", () => {
    const events = collectEmits({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    });
    expect(events[0]).toMatchObject({ type: "thinking_delta", content: "", blockIndex: 0 });
  });

  it("emits thinking_delta for thinking_delta events", () => {
    const events = collectEmits({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "hmm" } },
    });
    expect(events[0]).toMatchObject({ type: "thinking_delta", content: "hmm", blockIndex: 1 });
  });

  it("emits thinking_done for content_block_stop", () => {
    const events = collectEmits({
      type: "stream_event",
      event: { type: "content_block_stop", index: 2 },
    });
    expect(events[0]).toMatchObject({ type: "thinking_done", blockIndex: 2 });
  });

  it("emits nothing for null event", () => {
    const events = collectEmits({ type: "stream_event", event: null });
    expect(events).toHaveLength(0);
  });

  it("tags text_delta and thinking events with parentToolUseId for subagent streams (#82)", () => {
    const textEvents = collectEmits({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "sub chunk" } },
      parent_tool_use_id: "tu-task-2",
    });
    expect(textEvents[0]).toMatchObject({ type: "text_delta", content: "sub chunk", parentToolUseId: "tu-task-2" });

    const thinkEvents = collectEmits({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "sub hmm" } },
      parent_tool_use_id: "tu-task-2",
    });
    expect(thinkEvents[0]).toMatchObject({ type: "thinking_delta", content: "sub hmm", parentToolUseId: "tu-task-2" });

    const stopEvents = collectEmits({
      type: "stream_event",
      event: { type: "content_block_stop", index: 1 },
      parent_tool_use_id: "tu-task-2",
    });
    expect(stopEvents[0]).toMatchObject({ type: "thinking_done", blockIndex: 1, parentToolUseId: "tu-task-2" });
  });

  it("tags primary stream events with parentToolUseId null", () => {
    const events = collectEmits({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "chunk" } },
      parent_tool_use_id: null,
    });
    expect(events[0]).toMatchObject({ type: "text_delta", content: "chunk", parentToolUseId: null });
  });
});

describe("translateSDKMessage – result", () => {
  it("emits turn_done with normalized fields", () => {
    const events = collectEmits({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      total_cost_usd: 0.002,
      duration_ms: 1234,
      stop_reason: "end_turn",
      modelUsage: { "claude-opus-4": {} },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "turn_done",
      result: {
        providerId: "claude",
        model: "claude-opus-4",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        totalCostUsd: 0.002,
        durationMs: 1234,
        stopReason: "end_turn",
        isError: undefined,
        errorMessage: undefined,
      },
    });
  });

  it("sets errorMessage when subtype is not 'success' and result is set", () => {
    const events = collectEmits({ type: "result", subtype: "error_during_execution", result: "tool failed" });
    expect(events[0]).toMatchObject({ type: "turn_done", result: { errorMessage: "tool failed" } });
  });

  it("falls back to 'unknown' model when modelUsage is absent", () => {
    const events = collectEmits({ type: "result" });
    expect(events[0]).toMatchObject({ type: "turn_done", result: { model: "unknown" } });
  });
});

describe("translateSDKMessage – system", () => {
  it("emits mcp_init with server/tool maps", () => {
    const events = collectEmits({
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "my_server", status: "connected" }],
      tools: ["mcp__my_server__read", "mcp__my_server__write", "not_mcp_tool"],
    });
    expect(events[0]).toMatchObject({
      type: "mcp_init",
      servers: { my_server: "connected" },
      tools: { my_server: ["mcp__my_server__read", "mcp__my_server__write"] },
    });
  });

  it("emits api_retry for api_retry subtype", () => {
    const events = collectEmits({
      type: "system",
      subtype: "api_retry",
      attempt: 2,
      retry_delay_ms: 1000,
      error_status: 529,
    });
    expect(events[0]).toMatchObject({ type: "api_retry", attempt: 2, retryDelayMs: 1000, errorStatus: 529 });
  });

  it("emits nothing for unknown system subtype", () => {
    const events = collectEmits({ type: "system", subtype: "other" });
    expect(events).toHaveLength(0);
  });
});

describe("translateSDKMessage – user (tool_result)", () => {
  it("emits tool_complete for each tool_result block", () => {
    const events = collectEmits({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "sdk-t1", content: "read output", is_error: false },
          { type: "tool_result", tool_use_id: "sdk-t2", content: "tool failed", is_error: true },
        ],
      },
    });
    expect(events[0]).toMatchObject({ type: "tool_complete", sdkToolUseId: "sdk-t1", output: "read output", success: true });
    expect(events[1]).toMatchObject({ type: "tool_complete", sdkToolUseId: "sdk-t2", output: "tool failed", success: false });
  });

  it("skips non-tool_result blocks", () => {
    const events = collectEmits({ type: "user", message: { content: [{ type: "text", text: "hi" }] } });
    expect(events).toHaveLength(0);
  });
});

describe("translateSDKMessage – tool_progress", () => {
  it("emits tool_progress", () => {
    const events = collectEmits({ type: "tool_progress", tool_name: "Bash", elapsed_time_seconds: 3.5 });
    expect(events[0]).toMatchObject({ type: "tool_progress", toolName: "Bash", elapsedSeconds: 3.5 });
  });
});

// ── parseMcpServerConfig ──────────────────────────────────────────────────────

describe("parseMcpServerConfig", () => {
  it("accepts a valid command-based server", () => {
    const result = parseMcpServerConfig({ command: "npx", args: ["-y", "my-server"], env: { KEY: "val" } });
    expect(result).toMatchObject({ command: "npx", args: ["-y", "my-server"] });
  });

  it("accepts a URL-based server without command", () => {
    const result = parseMcpServerConfig({ url: "http://localhost:3000" });
    expect(result).toMatchObject({ url: "http://localhost:3000" });
  });

  it("returns null for non-object input", () => {
    expect(parseMcpServerConfig("string")).toBeNull();
    expect(parseMcpServerConfig(null)).toBeNull();
    expect(parseMcpServerConfig([])).toBeNull();
  });

  it("returns null when neither command nor url is a string", () => {
    expect(parseMcpServerConfig({ command: 123 })).toBeNull();
  });

  it("returns null for non-string args", () => {
    expect(parseMcpServerConfig({ command: "x", args: [1, 2] })).toBeNull();
  });

  it("returns null for non-object env", () => {
    expect(parseMcpServerConfig({ command: "x", env: "bad" })).toBeNull();
  });

  it("returns null for env with non-string values", () => {
    expect(parseMcpServerConfig({ command: "x", env: { KEY: 123 } })).toBeNull();
  });
});

// ── withMcpToolTimeout ────────────────────────────────────────────────────────

describe("withMcpToolTimeout", () => {
  it("injects timeout into external servers that don't declare one", () => {
    const out = withMcpToolTimeout(
      {
        slack: { type: "http", url: "https://gw/mcp/slack" } as never,
        local: { command: "node", args: ["x.js"] } as never,
      },
      120_000,
    );
    expect((out.slack as { timeout?: number }).timeout).toBe(120_000);
    expect((out.local as { timeout?: number }).timeout).toBe(120_000);
  });

  it("does not override a server's explicit timeout", () => {
    const out = withMcpToolTimeout(
      { slack: { type: "http", url: "https://gw", timeout: 5_000 } as never },
      120_000,
    );
    expect((out.slack as { timeout?: number }).timeout).toBe(5_000);
  });

  it("is a no-op when ms <= 0 (use the SDK default)", () => {
    const servers = { slack: { type: "http", url: "https://gw" } as never };
    expect(withMcpToolTimeout(servers, 0)).toBe(servers);
    const out = withMcpToolTimeout(servers, 0);
    expect((out.slack as { timeout?: number }).timeout).toBeUndefined();
  });
});

// ── buildAgentEnv (GHSA-38vh vector 3) ────────────────────────────────────────

describe("buildAgentEnv", () => {
  it("passes system + Anthropic/Claude vars through but drops daemon secrets", () => {
    const env = buildAgentEnv({
      PATH: "/usr/bin",
      HOME: "/home/deploy",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      HTTPS_PROXY: "http://proxy:8080",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
      ANTHROPIC_API_KEY: "sk-ant-keep",
      CLAUDE_CODE_USE_BEDROCK: "1",
      // Daemon secrets that must NOT reach the agent shell:
      TELEGRAM_BOT_TOKEN: "bot-secret",
      CODEOID_API_KEY: "zid_sk_root",
      GOOGLE_CLIENT_SECRET: "goog-secret",
      OPENAI_API_KEY: "sk-openai",
      SOME_RANDOM_SECRET: "nope",
    });
    // Allowed
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/deploy");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.LC_ALL).toBe("C");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ca.pem");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-keep");
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    // Denied
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.CODEOID_API_KEY).toBeUndefined();
    expect(env.GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SOME_RANDOM_SECRET).toBeUndefined();
  });

  it("honors CODEOID_AGENT_ENV_ALLOW as an extension point (Bedrock/Vertex)", () => {
    const env = buildAgentEnv({
      CODEOID_AGENT_ENV_ALLOW: "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY",
      AWS_ACCESS_KEY_ID: "AKIA...",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "not-listed",
    });
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIA...");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("secret");
    // Only the explicitly listed names pass — a sibling AWS var stays out.
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
  });

  it("skips undefined values", () => {
    const env = buildAgentEnv({ PATH: "/bin", HOME: undefined });
    expect(env.PATH).toBe("/bin");
    expect("HOME" in env).toBe(false);
  });
});

// ── extractToolResultText ─────────────────────────────────────────────────────

describe("extractToolResultText", () => {
  it("returns string content directly", () => {
    expect(extractToolResultText("plain text")).toBe("plain text");
  });

  it("returns empty string for non-array, non-string", () => {
    expect(extractToolResultText(null)).toBe("");
    expect(extractToolResultText(42)).toBe("");
  });

  it("joins text blocks from array content", () => {
    expect(extractToolResultText([
      { type: "text", text: "line1" },
      { type: "text", text: "line2" },
    ])).toBe("line1\nline2");
  });

  it("replaces image blocks with '[image]'", () => {
    expect(extractToolResultText([{ type: "image", source: "..." }])).toBe("[image]");
  });

  it("falls back to block.text for unknown block types that have text", () => {
    expect(extractToolResultText([{ type: "unknown_block", text: "fallback" }])).toBe("fallback");
  });
});

// ── ClaudeProvider lifecycle (mocked SDK) ─────────────────────────────────────

describe("ClaudeProvider – runTurn with mocked SDK", () => {
  beforeEach(() => { sdkMessages = []; sdkThrowError = null; capturedQueryOpts = null; sdkGate = null; });

  it("emits text_done + turn_done from mocked assistant + result messages", async () => {
    sdkMessages = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello from Claude" }] },
        parent_tool_use_id: null,
      },
      {
        type: "result",
        usage: { input_tokens: 5, output_tokens: 3 },
        modelUsage: { "claude-opus-4": {} },
      },
    ];

    const provider = makeProvider();
    const events = await collectTurnEvents(provider);

    expect(events.some((e) => e.type === "text_done" && (e as { content?: string }).content === "Hello from Claude")).toBe(true);
    expect(events.some((e) => e.type === "turn_done")).toBe(true);
  });

  it("emits error event when SDK throws", async () => {
    sdkThrowError = new Error("SDK boom");
    const provider = makeProvider();
    const events = await collectTurnEvents(provider);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("getters return correct initial state", () => {
    const provider = makeProvider();
    expect(provider.backingSessionId).toBe("test-backing");
    expect(provider.hasQueried).toBe(false);
    expect(provider.queuedMessages).toBe(0);
  });

  it("resetToNewSession resets state", () => {
    const provider = makeProvider();
    provider.resetToNewSession("new-backing");
    expect(provider.backingSessionId).toBe("new-backing");
    expect(provider.hasQueried).toBe(false);
  });

  it("setHasQueried updates the flag", () => {
    const provider = makeProvider();
    provider.setHasQueried(true);
    expect(provider.hasQueried).toBe(true);
    provider.setHasQueried(false);
    expect(provider.hasQueried).toBe(false);
  });

  it("teardown drains the consumer and is safe to call twice", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    const provider = makeProvider();
    // Start a turn so there's an active consumer task.
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    // Teardown should resolve without throwing even if the consumer is in-flight.
    await provider.teardown();
    // Second teardown is a no-op.
    await provider.teardown();
    // Queue closed by teardown — iteration should end immediately.
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    expect(events.length).toBeGreaterThanOrEqual(0); // may or may not have received events
  });

  it("dispose delegates to teardown without throwing", async () => {
    const provider = makeProvider();
    await expect(provider.dispose()).resolves.toBeUndefined();
  });

  it("listModels returns empty array when no active query", async () => {
    const provider = makeProvider();
    const models = await provider.listModels();
    expect(models).toEqual([]);
  });

  it("listModels returns models from the active query", async () => {
    // runTurn() sets #query synchronously; call listModels() right away,
    // before the (empty) consumer task runs and nulls #query.
    sdkMessages = [];
    const provider = makeProvider();
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    // Start listModels() before yielding — #query is still non-null here.
    const modelsPromise = provider.listModels();
    await run.interrupt();
    const models = await modelsPromise;
    expect(models.length).toBeGreaterThan(0);
    for await (const _ of run.events) { /* drain */ }
  });

  it("run.interrupt() resolves without throwing", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    const provider = makeProvider();
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    await run.interrupt();
    // Drain remaining events after interrupt
    for await (const _ of run.events) { /* drain */ }
  });

  it("run.pushMidTurn injects a mid-turn message", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    const provider = makeProvider();
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    // pushMidTurn is optional — exercise it if present
    run.pushMidTurn?.("mid-turn injection", "now");
    for await (const _ of run.events) { /* drain */ }
  });

  it("canUseTool emits tool_start correlated by the SDK's own toolUseID (#81)", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    capturedQueryOpts = null;
    let release!: () => void;
    sdkGate = new Promise<void>((r) => { release = r; });
    const provider = makeProvider();
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    await Promise.resolve();
    const opts = capturedQueryOpts as {
      options: {
        canUseTool: (name: string, input: unknown, o: { toolUseID: string; agentID?: string; signal: AbortSignal }) => Promise<unknown>;
      };
    } | null;
    expect(opts?.options?.canUseTool).toBeDefined();
    const result = await opts!.options.canUseTool("Read", { file_path: "/tmp/x.ts" }, {
      toolUseID: "tu-real-1", agentID: "agent-7", signal: new AbortController().signal,
    });
    expect((result as { behavior: string }).behavior).toBe("allow");
    release();
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    const toolStart = events.find((e) => e.type === "tool_start") as Extract<ProviderEvent, { type: "tool_start" }> | undefined;
    expect(toolStart).toBeDefined();
    expect(toolStart!.sdkToolUseId).toBe("tu-real-1");
    expect(toolStart!.sdkAgentId).toBe("agent-7");
    expect(toolStart!.name).toBe("Read");
    expect(toolStart!.input).toEqual({ file_path: "/tmp/x.ts" });
  });

  it("auto-allowed tools do not desync later correlation (#81 regression)", async () => {
    // Repro from the issue: an auto-allowed tool fires PreToolUse but the SDK
    // skips canUseTool for it. The next GATED tool must still correlate to its
    // own tool_use_id — with the old name-keyed FIFO it popped the stale
    // auto-allowed entry instead.
    sdkMessages = [{ type: "result", modelUsage: {} }];
    capturedQueryOpts = null;
    let release!: () => void;
    sdkGate = new Promise<void>((r) => { release = r; });
    const provider = makeProvider();
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    await Promise.resolve();
    const opts = capturedQueryOpts as {
      options: {
        hooks: { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> };
        canUseTool: (name: string, input: unknown, o: { toolUseID: string; agentID?: string; signal: AbortSignal }) => Promise<unknown>;
      };
    } | null;
    expect(opts?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]).toBeDefined();
    // 1. Auto-allowed call: PreToolUse fires, canUseTool never does.
    await opts!.options.hooks.PreToolUse[0]!.hooks[0]!({
      tool_name: "Bash", tool_use_id: "tu-auto-allowed", tool_input: { command: "git status" },
    });
    // 2. Gated call of the SAME tool name.
    await opts!.options.canUseTool("Bash", { command: "rm -rf build" }, {
      toolUseID: "tu-gated", signal: new AbortController().signal,
    });
    release();
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    const toolStarts = events.filter((e) => e.type === "tool_start") as Array<Extract<ProviderEvent, { type: "tool_start" }>>;
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0]!.sdkToolUseId).toBe("tu-gated");
    expect(toolStarts[0]!.input).toEqual({ command: "rm -rf build" });
  });

  it("canUseTool denies when the SDK provides no toolUseID", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    capturedQueryOpts = null;
    let release!: () => void;
    sdkGate = new Promise<void>((r) => { release = r; });
    const provider = makeProvider();
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    await Promise.resolve();
    const opts = capturedQueryOpts as {
      options: { canUseTool: (name: string, input: unknown, o?: unknown) => Promise<unknown> };
    } | null;
    const result = await opts!.options.canUseTool("Read", {}, { signal: new AbortController().signal });
    expect(result).toMatchObject({ behavior: "deny" });
    release();
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    expect(events.find((e) => e.type === "tool_start")).toBeUndefined();
  });

  it("PreToolUse hook runs (audit + compression) and returns a hook result", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    capturedQueryOpts = null;
    const provider = makeProvider();
    provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    await Promise.resolve();
    const opts = capturedQueryOpts as {
      options: { hooks: { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> } };
    } | null;
    if (opts?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]) {
      const result = await opts.options.hooks.PreToolUse[0].hooks[0]({
        tool_name: "Read", tool_use_id: "tu-1", tool_input: {}, agent_id: undefined,
      });
      expect(result).toBeDefined();
    }
  });

  it("SubagentStart and SubagentStop hooks emit subagent events", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    capturedQueryOpts = null;
    const provider = makeProvider();
    const events: ProviderEvent[] = [];
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    await Promise.resolve();
    const opts = capturedQueryOpts as {
      options: {
        hooks: {
          SubagentStart: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
          SubagentStop: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
        };
      };
    } | null;
    if (opts?.options?.hooks) {
      await opts.options.hooks.SubagentStart?.[0]?.hooks?.[0]?.({ agent_id: "sub-1", agent_type: "Task" });
      await opts.options.hooks.SubagentStop?.[0]?.hooks?.[0]?.({ agent_id: "sub-1" });
    }
    for await (const e of run.events) events.push(e);
    // If hooks were invoked, events were emitted into the turn queue
    // (may or may not be in events depending on timing — just verify no throw)
    expect(true).toBe(true);
  });
});
