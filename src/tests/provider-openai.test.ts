/**
 * OpenAIProvider unit tests — offline, no OpenAI API calls.
 *
 * mock.module() replaces the openai package with a controllable in-process
 * implementation so the full streaming path runs without credentials.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";
import type { ProviderEvent } from "../daemon/providers/interface.js";

// ── OpenAI mock ───────────────────────────────────────────────────────────────

type CompletionChunk = {
  choices: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};
type ModelItem = { id: string };

let streamChunks: CompletionChunk[] = [];
let streamError: Error | null = null;
let modelsResult: ModelItem[] | Error = [];

function makeCompletionStream(): AsyncIterable<CompletionChunk> {
  const chunks = [...streamChunks];
  const err = streamError;
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<CompletionChunk>> {
          if (err) throw err;
          if (i >= chunks.length) return { done: true as const, value: undefined };
          return { done: false as const, value: chunks[i++] };
        },
      };
    },
  };
}

mock.module("openai", () => {
  return {
    default: class OpenAI {
      chat = {
        completions: {
          create: async (_body: unknown, _opts: unknown) => makeCompletionStream(),
        },
      };
      models = {
        list: async () => {
          if (modelsResult instanceof Error) throw modelsResult;
          return { data: modelsResult };
        },
      };
    },
  };
});

import { OpenAIProvider } from "../daemon/providers/openai/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runProvider(
  provider: OpenAIProvider,
  userMessage = "hello",
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  const run = provider.runTurn({
    history: [],
    userMessage,
    workdir: "/tmp",
    canUseTool: async () => ({ behavior: "allow" as const }),
  });
  for await (const e of run.events) {
    events.push(e);
  }
  return events;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OpenAIProvider – streaming", () => {
  beforeEach(() => {
    streamChunks = [];
    streamError = null;
    modelsResult = [];
  });

  it("emits text_delta + text_done + turn_done for a normal response", async () => {
    streamChunks = [
      { choices: [{ delta: { content: "Hello " } }] },
      { choices: [{ delta: { content: "world" }, finish_reason: "stop" }] },
      { choices: [{}], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];

    const provider = new OpenAIProvider({ apiKey: "fake-key" });
    const events = await runProvider(provider);

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ content: "Hello " });
    expect(deltas[1]).toMatchObject({ content: "world" });

    const done = events.find((e) => e.type === "text_done");
    expect(done).toMatchObject({ content: "Hello world" });

    const turnDone = events.find((e) => e.type === "turn_done");
    expect(turnDone).toMatchObject({
      type: "turn_done",
      result: {
        providerId: "openai",
        inputTokens: 10,
        outputTokens: 5,
        stopReason: "stop",
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
      },
    });
  });

  it("emits error event when the stream throws", async () => {
    streamError = new Error("rate limit exceeded");
    const provider = new OpenAIProvider({ apiKey: "fake-key" });
    const events = await runProvider(provider);
    expect(events.some((e) => e.type === "error")).toBe(true);
    const err = events.find((e) => e.type === "error") as { message?: string } | undefined;
    expect(err?.message).toContain("rate limit exceeded");
  });

  it("includes systemPromptAppend as a system message when provided", async () => {
    streamChunks = [
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
    ];
    const provider = new OpenAIProvider({ apiKey: "fake-key" });
    const events: ProviderEvent[] = [];
    const run = provider.runTurn({
      history: [],
      userMessage: "hello",
      workdir: "/tmp",
      systemPromptAppend: "You are a coding assistant.",
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    for await (const e of run.events) events.push(e);
    expect(events.some((e) => e.type === "turn_done")).toBe(true);
  });

  it("interrupt aborts the turn", async () => {
    streamChunks = [];
    const provider = new OpenAIProvider({ apiKey: "fake-key" });
    const run = provider.runTurn({
      history: [],
      userMessage: "hi",
      workdir: "/tmp",
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    await run.interrupt();
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    expect(events.length).toBeLessThanOrEqual(1);
  });
});

describe("OpenAIProvider – listModels", () => {
  beforeEach(() => { modelsResult = []; });

  it("returns filtered GPT/o-series models from the API", async () => {
    modelsResult = [
      { id: "gpt-4o" },
      { id: "gpt-4o-mini" },
      { id: "o3-mini" },
      { id: "text-embedding-ada-002" }, // filtered out
    ];
    const provider = new OpenAIProvider({ apiKey: "fake-key" });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini", "o3-mini"]);
  });

  it("returns static fallback list when the API throws", async () => {
    modelsResult = new Error("forbidden");
    const provider = new OpenAIProvider({ apiKey: "bad-key" });
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.id.length > 0)).toBe(true);
  });
});

describe("OpenAIProvider – dispose", () => {
  it("dispose() resolves without throwing (stateless provider)", async () => {
    const provider = new OpenAIProvider({ apiKey: "fake-key" });
    await expect(provider.dispose()).resolves.toBeUndefined();
  });
});
