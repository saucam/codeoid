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
 *     validator is actually firing. Runs in a SUBPROCESS fixture because
 *     provider-gemini.test.ts installs a process-global
 *     mock.module("@google/generative-ai") — in-process, seeing the real
 *     SDK would depend on test-file execution order.
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
import { join } from "node:path";
import type OpenAI from "openai";
import {
  toGeminiContent,
  toOpenAIMessages,
  type CanonicalTurn,
} from "../daemon/providers/canonical.js";

const VALIDATE_FIXTURE = join(import.meta.dir, "fixtures", "gemini-validate-history.ts");

/** Run the real SDK's history validation in a mock-proof subprocess. */
async function validateWithRealSdk(history: unknown): Promise<string> {
  const proc = Bun.spawn(["bun", VALIDATE_FIXTURE, JSON.stringify(history)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

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
  it("startChat accepts converted tool-call history (real SDK validation)", async () => {
    // ChatSession's constructor runs validateChatHistory synchronously —
    // an invalid role/part combination throws right there, no network.
    expect(await validateWithRealSdk(toGeminiContent(HISTORY_WITH_TOOLS))).toBe("ok");
  });

  it("negative control: the validator rejects functionResponse on a user turn", async () => {
    // Proves the assertion above is load-bearing: if functionResponse
    // parts rode role "user" (as the design doc originally sketched), the
    // SDK would reject the history.
    const result = await validateWithRealSdk([
      {
        role: "user",
        parts: [{ functionResponse: { name: "run_shell", response: { output: "x" } } }],
      },
    ]);
    expect(result).toStartWith("threw:");
    expect(result).toContain("can't contain 'functionResponse'");
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
