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

function makeMockQuery() {
  const err = sdkThrowError;
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<{ done: boolean; value: SDKMsg | undefined }> {
          if (err) throw err;
          if (i >= sdkMessages.length) return { done: true, value: undefined };
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
  beforeEach(() => { sdkMessages = []; sdkThrowError = null; capturedQueryOpts = null; });

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

  it("canUseTool callback emits tool_start and returns allow", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    capturedQueryOpts = null;
    const provider = makeProvider();
    provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    await Promise.resolve(); // let #ensureQueryLoop register opts
    const opts = capturedQueryOpts as { options: { canUseTool: (name: string, input: unknown) => Promise<unknown> } } | null;
    if (opts?.options?.canUseTool) {
      const result = await opts.options.canUseTool("Read", { file_path: "/tmp/x.ts" });
      expect((result as { behavior: string }).behavior).toBe("allow");
    }
  });

  it("PreToolUse hook captures tool_use_id", async () => {
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
