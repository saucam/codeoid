/**
 * GeminiProvider — stateless Gemini backend for codeoid.
 *
 * Each runTurn() call converts the full CanonicalTurn[] history to Gemini's
 * Content[] format and issues a single streaming generateContent request.
 * No persistent session state: the entire conversation context is resent on
 * every turn, which is the Gemini API's natural model.
 *
 * History fidelity: tool calls from prior turns (any backend) arrive as
 *   native functionCall/functionResponse parts via toGeminiContent(), so
 *   Gemini sees real tool-call turns. Gemini itself remains text-only in
 *   its OWN turns (no function-calling loop here yet).
 *
 * Auth: reads GOOGLE_API_KEY from the environment. Override with
 *   GeminiProviderInit.apiKey for programmatic control (tests, multi-tenant).
 */

import {
  GoogleGenerativeAI,
  type GenerateContentStreamResult,
} from "@google/generative-ai";
import { AsyncQueue } from "../../async-queue.js";
import type {
  AgentProvider,
  ModelInfo,
  NormalizedTurnResult,
  ProviderEvent,
  TurnOpts,
  TurnRun,
} from "../interface.js";
import { toGeminiContent } from "../canonical.js";

export interface GeminiProviderInit {
  /** Explicit API key — falls back to GOOGLE_API_KEY env var. */
  apiKey?: string;
  /** Model to use when TurnOpts.model is absent. */
  defaultModel?: string;
}

export class GeminiProvider implements AgentProvider {
  readonly id = "gemini";
  readonly displayName = "Gemini (Google)";

  #apiKey: string;
  #defaultModel: string;

  constructor(init: GeminiProviderInit = {}) {
    this.#apiKey = init.apiKey ?? process.env.GOOGLE_API_KEY ?? "";
    this.#defaultModel = init.defaultModel ?? "gemini-2.0-flash";
  }

  runTurn(opts: TurnOpts): TurnRun {
    if (!this.#apiKey) {
      const queue = new AsyncQueue<ProviderEvent>();
      queue.push({ type: "error", message: "GeminiProvider: GOOGLE_API_KEY is not set" });
      queue.close();
      return {
        events: queue,
        interrupt: async () => {},
      };
    }

    const queue = new AsyncQueue<ProviderEvent>();
    const ac = new AbortController();
    const startMs = Date.now();

    void this.#stream(opts, queue, ac, startMs);

    return {
      events: queue,
      interrupt: async () => {
        ac.abort();
        queue.close();
      },
    };
  }

  async #stream(
    opts: TurnOpts,
    queue: AsyncQueue<ProviderEvent>,
    ac: AbortController,
    startMs: number,
  ): Promise<void> {
    const model = opts.model ?? this.#defaultModel;
    const genAI = new GoogleGenerativeAI(this.#apiKey);
    const genModel = genAI.getGenerativeModel({ model });

    try {
      // Split history: everything before the last user turn goes as chat history;
      // the last user turn (or opts.userMessage) becomes the current request.
      const { chatHistory, userMessage } = splitForStateless(opts);

      const geminiHistory = toGeminiContent(chatHistory);

      const chat = genModel.startChat({
        history: geminiHistory,
        // Gemini accepts systemInstruction as a plain string.
        ...(opts.systemPromptAppend ? { systemInstruction: opts.systemPromptAppend } : {}),
      });

      let streamResult: GenerateContentStreamResult;
      try {
        streamResult = await chat.sendMessageStream(userMessage, { signal: ac.signal });
      } catch (err) {
        if (ac.signal.aborted) return;
        queue.push({
          type: "error",
          message: `Gemini API error: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      let fullText = "";

      for await (const chunk of streamResult.stream) {
        if (ac.signal.aborted) return;
        const text = chunk.text();
        if (text) {
          queue.push({ type: "text_delta", content: text });
          fullText += text;
        }
      }

      if (ac.signal.aborted) return;

      queue.push({ type: "text_done", content: fullText });

      // Build normalized result from the final response metadata.
      const response = await streamResult.response;
      const usageMeta = response.usageMetadata;
      const durationMs = Date.now() - startMs;
      const stopReason = response.candidates?.[0]?.finishReason ?? undefined;

      const result: NormalizedTurnResult = {
        providerId: this.id,
        model,
        inputTokens: usageMeta?.promptTokenCount ?? 0,
        outputTokens: usageMeta?.candidatesTokenCount ?? 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0, // Gemini does not return cost in the API response.
        durationMs,
        stopReason: stopReason ? String(stopReason) : undefined,
      };

      queue.push({ type: "turn_done", result });
    } catch (err) {
      if (!ac.signal.aborted) {
        queue.push({
          type: "error",
          message: `GeminiProvider: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } finally {
      queue.close();
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Gemini's REST model-list endpoint requires a separate authenticated call.
    // Return a static list of well-known models; this is enough for the
    // session model-picker UI and can be replaced with a live fetch in Phase 2.
    return [
      { id: "gemini-2.0-flash", displayName: "Gemini 2.0 Flash" },
      { id: "gemini-2.0-flash-lite", displayName: "Gemini 2.0 Flash Lite" },
      { id: "gemini-1.5-pro", displayName: "Gemini 1.5 Pro" },
      { id: "gemini-1.5-flash", displayName: "Gemini 1.5 Flash" },
    ];
  }

  async dispose(): Promise<void> {
    // Stateless — nothing to tear down.
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Split canonical history into chat context + current user message.
 * Stateless providers receive the full history on every runTurn() call.
 * The last user turn (if present) becomes the live message; everything
 * before it is the chat context.
 */
export function splitForStateless(opts: TurnOpts): {
  chatHistory: readonly import("../canonical.js").CanonicalTurn[];
  userMessage: string;
} {
  const history = opts.history;
  const last = history.at(-1);

  if (last?.role === "user") {
    return {
      chatHistory: history.slice(0, -1),
      userMessage: last.content || opts.userMessage,
    };
  }

  // Fallback: history ended with an assistant turn (e.g. mid-turn re-entry).
  return {
    chatHistory: history,
    userMessage: opts.userMessage,
  };
}
