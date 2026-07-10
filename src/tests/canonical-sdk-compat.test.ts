/**
 * Phase-2 converter ↔ real provider SDK compatibility — offline.
 *
 * The native-structured converters (#138) were written against each
 * provider's documented wire format. These tests pin the riskiest
 * integration points to the ACTUAL installed SDKs, so a converter/SDK
 * drift fails here instead of at runtime:
 *
 *   - Gemini: @google/generative-ai validates chat history synchronously in
 *     the ChatSession constructor (validateChatHistory — role/part rules
 *     like "functionResponse parts only on role 'function'"). Feeding
 *     toGeminiContent() output through the real startChat() exercises that
 *     validator with zero network I/O. A negative control proves the
 *     validator is actually firing.
 *
 *   - OpenAI: toOpenAIMessages() output is assigned to the SDK's
 *     ChatCompletionMessageParam[] WITHOUT a cast, so `bun run typecheck`
 *     enforces structural compatibility (the provider call site uses a
 *     cast, which would hide drift).
 *
 *   - Anthropic: the raw @anthropic-ai/sdk is not a dependency (the claude
 *     provider drives the Agent SDK instead), so tool_use/tool_result shape
 *     is pinned by the unit tests in provider-switch.test.ts against the
 *     documented Messages API format.
 */

import { describe, it, expect } from "bun:test";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type OpenAI from "openai";
import {
  toGeminiContent,
  toOpenAIMessages,
  type CanonicalTurn,
} from "../daemon/providers/canonical.js";

const HISTORY_WITH_TOOLS: CanonicalTurn[] = [
  { role: "user", content: "Run ls and read the config" },
  {
    role: "assistant",
    content: "On it.",
    providerId: "claude",
    model: "claude-opus-4-5",
    toolCalls: [
      {
        id: "toolu_01",
        name: "run_shell",
        input: { command: "ls" },
        output: "main.ts",
        success: true,
      },
      {
        id: "toolu_02",
        name: "read_file",
        input: { file_path: "config.json" },
        output: "ENOENT",
        success: false,
      },
    ],
  },
  { role: "user", content: "Thanks" },
  {
    role: "assistant",
    content: "Done.",
    providerId: "gemini",
    model: "gemini-2.0-flash",
  },
];

describe("toGeminiContent ↔ @google/generative-ai", () => {
  const model = new GoogleGenerativeAI("offline-test-key").getGenerativeModel({
    model: "gemini-2.0-flash",
  });

  it("startChat accepts converted tool-call history (real SDK validation)", () => {
    // ChatSession's constructor runs validateChatHistory synchronously —
    // an invalid role/part combination throws right here, no network.
    expect(() => model.startChat({ history: toGeminiContent(HISTORY_WITH_TOOLS) })).not.toThrow();
  });

  it("negative control: the validator rejects functionResponse on a user turn", () => {
    // Proves the assertion above is load-bearing: if functionResponse
    // parts rode role "user" (as the design doc originally sketched), the
    // SDK would reject the history.
    expect(() =>
      model.startChat({
        history: [
          {
            role: "user",
            parts: [{ functionResponse: { name: "run_shell", response: { output: "x" } } }],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("toOpenAIMessages ↔ openai SDK types", () => {
  it("output is assignable to ChatCompletionMessageParam[] without a cast", () => {
    // Compile-time contract: if the converter's shape drifts from the SDK's
    // message-param union, `bun run typecheck` fails on this assignment.
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      toOpenAIMessages(HISTORY_WITH_TOOLS);
    expect(messages.length).toBeGreaterThan(0);
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
  });
});
