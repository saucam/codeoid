/**
 * OpenAIProvider — stateless OpenAI backend for codeoid.
 *
 * Each runTurn() call converts the full CanonicalTurn[] history to OpenAI's
 * messages[] format and issues a single streaming chat completion request.
 *
 * Phase 1: text-only. Tool calls from prior Claude turns are rendered as
 *   inline text. Function calling support (Phase 2) will use tool_calls[]
 *   + { role: "tool" } messages with proper CanonicalToolCall rendering.
 *
 * Auth: reads OPENAI_API_KEY from the environment. Override with
 *   OpenAIProviderInit.apiKey for programmatic control.
 */

import OpenAI from "openai";
import { AsyncQueue } from "../../async-queue.js";
import type {
  AgentProvider,
  ModelInfo,
  NormalizedTurnResult,
  ProviderEvent,
  TurnOpts,
  TurnRun,
} from "../interface.js";
import { toOpenAIMessages } from "../canonical.js";
import { splitForStateless } from "../gemini/index.js";

export interface OpenAIProviderInit {
  /** Explicit API key — falls back to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Default model when TurnOpts.model is absent. */
  defaultModel?: string;
  /** Override base URL (useful for Azure OpenAI or local proxies). */
  baseURL?: string;
}

export class OpenAIProvider implements AgentProvider {
  readonly id = "openai";
  readonly displayName = "GPT (OpenAI)";

  #client: OpenAI;
  #defaultModel: string;

  constructor(init: OpenAIProviderInit = {}) {
    this.#client = new OpenAI({
      apiKey: init.apiKey ?? process.env.OPENAI_API_KEY ?? "missing",
      ...(init.baseURL ? { baseURL: init.baseURL } : {}),
    });
    this.#defaultModel = init.defaultModel ?? "gpt-4o";
  }

  runTurn(opts: TurnOpts): TurnRun {
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

    try {
      const { chatHistory, userMessage } = splitForStateless(opts);

      // Build the messages array: system prompt + chat history + current user turn.
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      if (opts.systemPromptAppend) {
        messages.push({ role: "system", content: opts.systemPromptAppend });
      }

      for (const m of toOpenAIMessages(chatHistory)) {
        messages.push(m as OpenAI.Chat.ChatCompletionMessageParam);
      }

      messages.push({ role: "user", content: userMessage });

      const stream = await this.#client.chat.completions.create(
        {
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: ac.signal },
      );

      let fullText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: string | undefined;

      for await (const chunk of stream) {
        if (ac.signal.aborted) return;

        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          queue.push({ type: "text_delta", content: delta });
          fullText += delta;
        }

        // Usage arrives in the final chunk when include_usage is set.
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }

        if (chunk.choices[0]?.finish_reason) {
          stopReason = chunk.choices[0].finish_reason;
        }
      }

      if (ac.signal.aborted) return;

      queue.push({ type: "text_done", content: fullText });

      const result: NormalizedTurnResult = {
        providerId: this.id,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0, // OpenAI does not return cost in the streaming response.
        durationMs: Date.now() - startMs,
        stopReason,
      };

      queue.push({ type: "turn_done", result });
    } catch (err) {
      if (!ac.signal.aborted) {
        queue.push({
          type: "error",
          message: `OpenAIProvider: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } finally {
      queue.close();
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const resp = await this.#client.models.list();
      return resp.data
        .filter((m) => m.id.startsWith("gpt-") || m.id.startsWith("o1") || m.id.startsWith("o3"))
        .map((m) => ({ id: m.id, displayName: m.id }));
    } catch {
      return [
        { id: "gpt-4o", displayName: "GPT-4o" },
        { id: "gpt-4o-mini", displayName: "GPT-4o Mini" },
        { id: "o3-mini", displayName: "o3-mini" },
      ];
    }
  }

  async dispose(): Promise<void> {
    // Stateless — nothing to tear down.
  }
}
