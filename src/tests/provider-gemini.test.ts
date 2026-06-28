/**
 * GeminiProvider unit tests — offline, no Google API calls.
 *
 * mock.module() replaces @google/generative-ai with a controllable in-process
 * implementation so the full streaming path runs without credentials.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";
import type { ProviderEvent } from "../daemon/providers/interface.js";

// ── Google AI mock ────────────────────────────────────────────────────────────

type StreamChunk = { text: () => string };

let streamChunks: StreamChunk[] = [];
let streamError: Error | null = null;
let usageMetadata: Record<string, unknown> = {};
let finishReason: string | undefined;

function makeStream(): AsyncIterable<StreamChunk> {
  const chunks = [...streamChunks];
  const err = streamError;
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<StreamChunk>> {
          if (err) throw err;
          if (i >= chunks.length) return { done: true as const, value: undefined };
          return { done: false as const, value: chunks[i++] };
        },
      };
    },
  };
}

mock.module("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel(_opts: unknown) {
      return {
        startChat(_chatOpts: unknown) {
          return {
            sendMessageStream: async (_msg: unknown, _reqOpts: unknown) => ({
              stream: makeStream(),
              response: Promise.resolve({
                usageMetadata,
                candidates: finishReason ? [{ finishReason }] : [],
              }),
            }),
          };
        },
      };
    }
  },
}));

import { GeminiProvider } from "../daemon/providers/gemini/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runProvider(
  provider: GeminiProvider,
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

describe("GeminiProvider – no-key path", () => {
  it("emits error event when GOOGLE_API_KEY is not set", async () => {
    const provider = new GeminiProvider({ apiKey: "" });
    const events = await runProvider(provider);
    expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("GOOGLE_API_KEY") });
  });
});

describe("GeminiProvider – streaming", () => {
  beforeEach(() => {
    streamChunks = [];
    streamError = null;
    usageMetadata = {};
    finishReason = undefined;
  });

  it("emits text_delta + text_done + turn_done for a normal response", async () => {
    streamChunks = [{ text: () => "Hello " }, { text: () => "world" }];
    usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5 };
    finishReason = "STOP";

    const provider = new GeminiProvider({ apiKey: "fake-key" });
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
        providerId: "gemini",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        stopReason: "STOP",
      },
    });
  });

  it("emits error event when the stream throws", async () => {
    streamError = new Error("quota exceeded");
    const provider = new GeminiProvider({ apiKey: "fake-key" });
    const events = await runProvider(provider);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("handles chunks with empty text (skips them)", async () => {
    streamChunks = [{ text: () => "" }, { text: () => "content" }];
    const provider = new GeminiProvider({ apiKey: "fake-key" });
    const events = await runProvider(provider);
    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ content: "content" });
  });

  it("interrupt aborts the turn", async () => {
    // Provide no chunks — the stream would stall
    streamChunks = [];
    const provider = new GeminiProvider({ apiKey: "fake-key" });
    const events: ProviderEvent[] = [];
    const run = provider.runTurn({
      history: [],
      userMessage: "hi",
      workdir: "/tmp",
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    // Interrupt immediately
    await run.interrupt();
    for await (const e of run.events) {
      events.push(e);
    }
    // After abort the queue is closed — no events or just what arrived before close
    expect(events.length).toBeLessThanOrEqual(1);
  });
});

describe("GeminiProvider – listModels", () => {
  it("returns a static list of well-known Gemini models", async () => {
    const provider = new GeminiProvider();
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.id.startsWith("gemini"))).toBe(true);
  });
});

describe("GeminiProvider – dispose", () => {
  it("dispose() resolves without throwing (stateless provider)", async () => {
    const provider = new GeminiProvider({ apiKey: "fake-key" });
    await expect(provider.dispose()).resolves.toBeUndefined();
  });
});
