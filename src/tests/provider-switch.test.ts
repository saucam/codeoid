/**
 * Provider-switch E2E tests — offline, no network calls.
 *
 * Validates the full multi-provider data flow:
 *   1. CanonicalHistoryAccumulator records events from Provider A
 *   2. The history is passed verbatim to Provider B on the next runTurn()
 *   3. History converters (toGeminiContent, toOpenAIMessages) render it correctly
 *
 * Uses MockProvider with pre-scripted ProviderEvents so the tests are
 * deterministic and run in CI without any API keys.
 */

import { describe, it, expect } from "bun:test";
import {
  MockProvider,
  mockResult,
  CanonicalHistoryAccumulator,
  toGeminiContent,
  toOpenAIMessages,
  toAnthropicMessages,
  splitForStateless,
} from "../daemon/providers/index.js";
import type { ProviderEvent } from "../daemon/providers/index.js";
import type { CanonicalTurn } from "../daemon/providers/canonical.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runTurn(
  provider: MockProvider,
  accumulator: CanonicalHistoryAccumulator,
  userMessage: string,
): Promise<void> {
  accumulator.pushUserTurn(userMessage);
  const run = provider.runTurn({
    history: [...accumulator.history] as import("../daemon/providers/canonical.js").CanonicalTurn[],
    userMessage,
    workdir: "/tmp/test",
    canUseTool: async () => ({ behavior: "allow" }),
  });
  for await (const event of run.events) {
    accumulator.handleEvent(event);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CanonicalHistoryAccumulator", () => {
  it("records a simple text turn", async () => {
    const acc = new CanonicalHistoryAccumulator();
    const provider = new MockProvider("claude", [[
      { type: "text_delta", content: "Hello" },
      { type: "text_done", content: "Hello, world!" },
      { type: "turn_done", result: mockResult({ providerId: "claude", model: "claude-opus-4-5" }) },
    ]]);

    await runTurn(provider, acc, "Say hi");

    expect(acc.history).toHaveLength(2);
    expect(acc.history[0]).toEqual({ role: "user", content: "Say hi" });
    expect(acc.history[1]).toMatchObject({
      role: "assistant",
      content: "Hello, world!",
      providerId: "claude",
      model: "claude-opus-4-5",
    });
  });

  it("records a turn with tool calls", async () => {
    const toolEvents: ProviderEvent[] = [
      {
        type: "tool_start",
        toolId: "t1",
        sdkToolUseId: "sdk-t1",
        name: "Read",
        input: { file_path: "src/main.ts" },
        approvalId: "a1",
      },
      {
        type: "tool_complete",
        sdkToolUseId: "sdk-t1",
        output: "export function main() {}",
        success: true,
      },
      { type: "text_done", content: "I read the file." },
      { type: "turn_done", result: mockResult({ providerId: "claude", model: "claude-opus-4-5" }) },
    ];

    const acc = new CanonicalHistoryAccumulator();
    const provider = new MockProvider("claude", [toolEvents]);

    await runTurn(provider, acc, "Read main.ts");

    const assistantTurn = acc.history[1];
    expect(assistantTurn.role).toBe("assistant");
    if (assistantTurn.role === "assistant") {
      expect(assistantTurn.toolCalls).toHaveLength(1);
      expect(assistantTurn.toolCalls![0].name).toBe("read_file"); // normalized
      expect(assistantTurn.toolCalls![0].originalName).toBe("Read");
      expect(assistantTurn.toolCalls![0].input).toEqual({ file_path: "src/main.ts" });
      expect(assistantTurn.toolCalls![0].output).toBe("export function main() {}");
      expect(assistantTurn.toolCalls![0].success).toBe(true);
    }
  });

  it("records thinking content", async () => {
    const acc = new CanonicalHistoryAccumulator();
    const provider = new MockProvider("claude", [[
      { type: "thinking_delta", content: "Let me think..." },
      { type: "thinking_delta", content: " Yes." },
      { type: "text_done", content: "The answer is 42." },
      { type: "turn_done", result: mockResult({ providerId: "claude", model: "claude-opus-4-5" }) },
    ]]);

    await runTurn(provider, acc, "What is the answer?");

    const turn = acc.history[1];
    if (turn.role === "assistant") {
      expect(turn.thinking).toBe("Let me think... Yes.");
    }
  });

  it("accumulates multiple turns across different providers", async () => {
    const acc = new CanonicalHistoryAccumulator();

    const claudeProvider = new MockProvider("claude", [[
      { type: "text_done", content: "I analyzed the code." },
      { type: "turn_done", result: mockResult({ providerId: "claude", model: "claude-opus-4-5" }) },
    ]]);

    const geminiProvider = new MockProvider("gemini", [[
      { type: "text_done", content: "I agree with the analysis." },
      { type: "turn_done", result: mockResult({ providerId: "gemini", model: "gemini-2.0-flash" }) },
    ]]);

    await runTurn(claudeProvider, acc, "Analyze this code");
    await runTurn(geminiProvider, acc, "What do you think?");

    expect(acc.history).toHaveLength(4); // user, claude, user, gemini
    expect(acc.history[0]).toMatchObject({ role: "user", content: "Analyze this code" });
    expect(acc.history[1]).toMatchObject({ role: "assistant", providerId: "claude" });
    expect(acc.history[2]).toMatchObject({ role: "user", content: "What do you think?" });
    expect(acc.history[3]).toMatchObject({ role: "assistant", providerId: "gemini" });
  });

  it("reset() clears all history and in-progress state", async () => {
    const acc = new CanonicalHistoryAccumulator();
    const provider = new MockProvider("claude", [[
      { type: "text_done", content: "Hello" },
      { type: "turn_done", result: mockResult() },
    ]]);
    await runTurn(provider, acc, "Hi");
    expect(acc.history).toHaveLength(2);

    acc.reset();
    expect(acc.history).toHaveLength(0);
  });

  it("concatenates every text_done of a turn — interleaved text → tool → text (#82)", async () => {
    // A real agentic turn fires one text_done per assistant message:
    // commentary → tool call → final answer. All blocks must survive; the old
    // assign-behavior kept only the last one.
    const acc = new CanonicalHistoryAccumulator();
    const provider = new MockProvider("claude", [[
      { type: "text_done", content: "Let me check the file." },
      { type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name: "Read", input: { file_path: "a.ts" }, approvalId: "a1" },
      { type: "tool_complete", sdkToolUseId: "sdk-t1", output: "export {}", success: true },
      { type: "text_done", content: "It is empty — done." },
      { type: "turn_done", result: mockResult({ providerId: "claude", model: "claude-opus-4-5" }) },
    ]]);

    await runTurn(provider, acc, "Check a.ts");

    const turn = acc.history[1];
    expect(turn.role).toBe("assistant");
    if (turn.role === "assistant") {
      expect(turn.content).toBe("Let me check the file.\n\nIt is empty — done.");
    }
  });

  it("drops subagent text and thinking from the canonical history (#82)", async () => {
    const acc = new CanonicalHistoryAccumulator();
    const provider = new MockProvider("claude", [[
      { type: "text_done", content: "Spawning a subagent.", parentToolUseId: null },
      { type: "thinking_delta", content: "sub thinking", parentToolUseId: "tu-task" },
      { type: "text_done", content: "SUBAGENT COMMENTARY", parentToolUseId: "tu-task" },
      { type: "text_done", content: "The subagent finished." },
      { type: "turn_done", result: mockResult({ providerId: "claude", model: "claude-opus-4-5" }) },
    ]]);

    await runTurn(provider, acc, "Delegate this");

    const turn = acc.history[1];
    expect(turn.role).toBe("assistant");
    if (turn.role === "assistant") {
      expect(turn.content).toBe("Spawning a subagent.\n\nThe subagent finished.");
      expect(turn.content).not.toContain("SUBAGENT COMMENTARY");
      expect(turn.thinking).toBeUndefined();
    }
  });

  it("text_done accumulation resets across turns", async () => {
    const acc = new CanonicalHistoryAccumulator();
    const provider = new MockProvider("claude", [
      [
        { type: "text_done", content: "First turn." },
        { type: "turn_done", result: mockResult({ providerId: "claude", model: "claude-opus-4-5" }) },
      ],
      [
        { type: "text_done", content: "Second turn." },
        { type: "turn_done", result: mockResult({ providerId: "claude", model: "claude-opus-4-5" }) },
      ],
    ]);

    await runTurn(provider, acc, "One");
    await runTurn(provider, acc, "Two");

    expect(acc.history[1]).toMatchObject({ role: "assistant", content: "First turn." });
    expect(acc.history[3]).toMatchObject({ role: "assistant", content: "Second turn." });
  });
});

describe("Provider-switch: history forwarding", () => {
  it("second provider receives the full history from the first provider's turn", async () => {
    const acc = new CanonicalHistoryAccumulator();

    // Turn 1: mock "Claude" run
    const claudeProvider = new MockProvider("claude", [[
      { type: "text_done", content: "I read the files." },
      { type: "turn_done", result: mockResult({ providerId: "claude", model: "claude-opus-4-5" }) },
    ]]);
    await runTurn(claudeProvider, acc, "List the project files");

    // Turn 2: mock "Gemini" run — capture what it receives as opts.history
    const geminiProvider = new MockProvider("gemini", [[
      { type: "text_done", content: "Looks good!" },
      { type: "turn_done", result: mockResult({ providerId: "gemini", model: "gemini-2.0-flash" }) },
    ]]);
    await runTurn(geminiProvider, acc, "Review the structure");

    // The second provider should have received 3 turns in its opts.history:
    // [user1, assistant-claude, user2] — the claude+user context is forwarded
    expect(geminiProvider.capturedOpts).toHaveLength(1);
    const historyReceivedByGemini = geminiProvider.capturedOpts[0].history;
    expect(historyReceivedByGemini).toHaveLength(3);
    expect(historyReceivedByGemini[0]).toMatchObject({ role: "user", content: "List the project files" });
    expect(historyReceivedByGemini[1]).toMatchObject({ role: "assistant", providerId: "claude" });
    expect(historyReceivedByGemini[2]).toMatchObject({ role: "user", content: "Review the structure" });
  });

  it("tool calls from Claude turn are visible to the next provider", async () => {
    const acc = new CanonicalHistoryAccumulator();

    const claudeProvider = new MockProvider("claude", [[
      {
        type: "tool_start",
        toolId: "t1",
        sdkToolUseId: "sdk-t1",
        name: "Bash",
        input: { command: "ls src/" },
        approvalId: "a1",
      },
      {
        type: "tool_complete",
        sdkToolUseId: "sdk-t1",
        output: "daemon/\nprotocol/\ntests/",
        success: true,
      },
      { type: "text_done", content: "Here are the directories." },
      { type: "turn_done", result: mockResult({ providerId: "claude", model: "claude-opus-4-5" }) },
    ]]);
    await runTurn(claudeProvider, acc, "What directories exist?");

    const geminiProvider = new MockProvider("gemini", [[
      { type: "turn_done", result: mockResult({ providerId: "gemini", model: "gemini-2.0-flash" }) },
    ]]);
    await runTurn(geminiProvider, acc, "Summarize the structure");

    const historyReceivedByGemini = geminiProvider.capturedOpts[0].history;
    const claudeTurn = historyReceivedByGemini[1];
    expect(claudeTurn.role).toBe("assistant");
    if (claudeTurn.role === "assistant") {
      expect(claudeTurn.toolCalls).toHaveLength(1);
      expect(claudeTurn.toolCalls![0].name).toBe("run_shell"); // Bash → run_shell
    }
  });
});

describe("toGeminiContent", () => {
  it("converts user + assistant turns to Gemini role format", () => {
    const history: import("../daemon/providers/canonical.js").CanonicalTurn[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!", providerId: "claude", model: "claude-opus-4-5" },
      { role: "user", content: "How are you?" },
    ];
    const result = toGeminiContent(history);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "user", parts: [{ text: "Hello" }] });
    expect(result[1]).toEqual({ role: "model", parts: [{ text: "Hi there!" }] });
    expect(result[2]).toEqual({ role: "user", parts: [{ text: "How are you?" }] });
  });

  it("renders tool calls as native functionCall/functionResponse parts (Phase 2)", () => {
    const history: import("../daemon/providers/canonical.js").CanonicalTurn[] = [
      { role: "user", content: "Run ls" },
      {
        role: "assistant",
        content: "Here are the files:",
        providerId: "claude",
        model: "claude-opus-4-5",
        toolCalls: [{
          id: "t1",
          name: "run_shell",
          input: { command: "ls" },
          output: "main.ts\nindex.ts",
          success: true,
        }],
      },
    ];
    const result = toGeminiContent(history);
    expect(result).toHaveLength(3); // user, model, function
    expect(result[1]).toEqual({
      role: "model",
      parts: [
        { text: "Here are the files:" },
        { functionCall: { name: "run_shell", args: { command: "ls" } } },
      ],
    });
    expect(result[2]).toEqual({
      role: "function",
      parts: [
        {
          functionResponse: {
            name: "run_shell",
            response: { output: "main.ts\nindex.ts", success: true },
          },
        },
      ],
    });
  });

  it("omits the text part on a tool-calls-only model turn", () => {
    const history: import("../daemon/providers/canonical.js").CanonicalTurn[] = [
      {
        role: "assistant",
        content: "",
        providerId: "claude",
        model: "m",
        toolCalls: [
          { id: "t1", name: "read_file", input: { file_path: "a.ts" }, output: "x", success: true },
        ],
      },
    ];
    const result = toGeminiContent(history);
    expect(result[0]?.parts).toEqual([
      { functionCall: { name: "read_file", args: { file_path: "a.ts" } } },
    ]);
  });

  it("returns empty array for empty history", () => {
    expect(toGeminiContent([])).toEqual([]);
  });
});

describe("toOpenAIMessages", () => {
  it("converts user + assistant turns to OpenAI role format", () => {
    const history: import("../daemon/providers/canonical.js").CanonicalTurn[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!", providerId: "claude", model: "claude-opus-4-5" },
    ];
    const result = toOpenAIMessages(history);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
    expect(result[1]).toEqual({ role: "assistant", content: "Hi!" });
  });

  it("renders tool calls as native tool_calls[] + tool-role messages (Phase 2)", () => {
    const history: import("../daemon/providers/canonical.js").CanonicalTurn[] = [
      {
        role: "assistant",
        content: "Done.",
        providerId: "claude",
        model: "claude-opus-4-5",
        toolCalls: [{
          id: "call_1",
          name: "read_file",
          input: { file_path: "src/main.ts" },
          output: "export default {}",
          success: true,
        }],
      },
    ];
    const result = toOpenAIMessages(history);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      role: "assistant",
      content: "Done.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ file_path: "src/main.ts" }) },
        },
      ],
    });
    expect(result[1]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "export default {}",
    });
  });

  it("uses null content on a tool-calls-only assistant message", () => {
    const history: import("../daemon/providers/canonical.js").CanonicalTurn[] = [
      {
        role: "assistant",
        content: "",
        providerId: "claude",
        model: "m",
        toolCalls: [
          { id: "c1", name: "run_shell", input: { command: "ls" }, output: "ok", success: true },
        ],
      },
    ];
    const result = toOpenAIMessages(history);
    expect(result[0]).toMatchObject({ role: "assistant", content: null });
  });

  it("carries failures in the content string — OpenAI has no is_error (§11.3)", () => {
    const history: import("../daemon/providers/canonical.js").CanonicalTurn[] = [
      {
        role: "assistant",
        content: "",
        providerId: "claude",
        model: "m",
        toolCalls: [
          { id: "c1", name: "run_shell", input: { command: "bad" }, output: "exit 127", success: false },
        ],
      },
    ];
    const result = toOpenAIMessages(history);
    expect(result[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "Error: exit 127" });
  });
});

describe("toAnthropicMessages", () => {
  it("converts canonical history to Anthropic message format", () => {
    const history: import("../daemon/providers/canonical.js").CanonicalTurn[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!", providerId: "claude", model: "claude-opus-4-5" },
    ];
    const result = toAnthropicMessages(history);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
    expect(result[1]).toEqual({ role: "assistant", content: "Hi!" });
  });

  it("renders tool calls as tool_use blocks + a tool_result user message (Phase 2)", () => {
    const history: import("../daemon/providers/canonical.js").CanonicalTurn[] = [
      { role: "user", content: "Read main.ts and check the config" },
      {
        role: "assistant",
        content: "Reading both.",
        thinking: "the user wants two files",
        providerId: "claude",
        model: "claude-opus-4-5",
        toolCalls: [
          {
            id: "toolu_01",
            name: "read_file",
            input: { file_path: "src/main.ts" },
            output: "export {}",
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
    ];
    const result = toAnthropicMessages(history);
    expect(result).toHaveLength(4); // user, assistant(blocks), user(tool_results), user
    expect(result[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Reading both." },
        { type: "tool_use", id: "toolu_01", name: "read_file", input: { file_path: "src/main.ts" } },
        { type: "tool_use", id: "toolu_02", name: "read_file", input: { file_path: "config.json" } },
      ],
    });
    // tool_use ids round-trip into the paired tool_result blocks; failures
    // carry is_error. Synthesized thinking is deliberately absent (no
    // signature — the API would reject it).
    expect(result[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01", content: "export {}" },
        { type: "tool_result", tool_use_id: "toolu_02", content: "ENOENT", is_error: true },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("thinking");
  });

  it("omits the empty text block on a tool-calls-only turn", () => {
    const history: import("../daemon/providers/canonical.js").CanonicalTurn[] = [
      {
        role: "assistant",
        content: "",
        providerId: "claude",
        model: "m",
        toolCalls: [
          { id: "t1", name: "run_shell", input: { command: "ls" }, output: "ok", success: true },
        ],
      },
    ];
    const result = toAnthropicMessages(history);
    const content = result[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("tool_use");
    }
  });
});

describe("splitForStateless", () => {
  it("splits the last user turn as the current message", () => {
    const history: CanonicalTurn[] = [
      { role: "user", content: "First" },
      { role: "assistant", content: "Response", providerId: "claude", model: "m" },
      { role: "user", content: "Second" },
    ];
    const result = splitForStateless({
      history,
      userMessage: "Second",
      workdir: "/tmp",
      canUseTool: async () => ({ behavior: "allow" }),
    });
    expect(result.chatHistory).toHaveLength(2);
    expect(result.userMessage).toBe("Second");
  });

  it("falls back to opts.userMessage when history doesn't end with a user turn", () => {
    const history: CanonicalTurn[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello", providerId: "claude", model: "m" },
    ];
    const result = splitForStateless({
      history,
      userMessage: "What next?",
      workdir: "/tmp",
      canUseTool: async () => ({ behavior: "allow" }),
    });
    expect(result.chatHistory).toHaveLength(2);
    expect(result.userMessage).toBe("What next?");
  });
});
