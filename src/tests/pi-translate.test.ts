/**
 * Pure pi-RPC → ProviderEvent translation (src/daemon/providers/pi/translate.ts).
 * Frames mirror pi's documented RPC shapes (pi-mono docs/rpc.md).
 */

import { describe, expect, it } from "bun:test";
import { piContentText, translatePiEvent } from "../daemon/providers/pi/translate.js";
import { renderHistorySeed } from "../daemon/providers/canonical.js";

describe("piContentText", () => {
  it("joins text blocks and ignores non-text blocks", () => {
    expect(
      piContentText([
        { type: "text", text: "one" },
        { type: "thinking", thinking: "hmm" },
        { type: "toolCall", id: "t", name: "bash", arguments: {} },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\n\ntwo");
  });

  it("passes strings through and tolerates junk", () => {
    expect(piContentText("plain")).toBe("plain");
    expect(piContentText(undefined)).toBe("");
    expect(piContentText([null, 42, { type: "text" }])).toBe("");
  });
});

describe("translatePiEvent", () => {
  it("maps streaming text and thinking deltas", () => {
    expect(
      translatePiEvent({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
      }),
    ).toEqual([{ type: "text_delta", content: "hi" }]);
    expect(
      translatePiEvent({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "…" },
      }),
    ).toEqual([{ type: "thinking_delta", content: "…", blockIndex: 2 }]);
    expect(
      translatePiEvent({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "thinking_end", contentIndex: 2 },
      }),
    ).toEqual([{ type: "thinking_done", blockIndex: 2 }]);
  });

  it("commits assistant text on message_end, skipping tool-only rounds", () => {
    expect(
      translatePiEvent({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ).toEqual([{ type: "text_done", content: "done" }]);
    // Tool-only round: no text blocks → no committed row.
    expect(
      translatePiEvent({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "toolCall", id: "t" }] },
      }),
    ).toEqual([]);
    // Non-assistant messages never commit.
    expect(
      translatePiEvent({ type: "message_end", message: { role: "user", content: "x" } }),
    ).toEqual([]);
  });

  it("maps tool completion with joined output and error flag", () => {
    const [event] = translatePiEvent({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "out" }] },
      isError: true,
    });
    expect(event).toEqual({
      type: "tool_complete",
      sdkToolUseId: "tc1",
      output: "out",
      success: false,
    });
  });

  it("maps retries, extension errors, and compaction notices", () => {
    expect(
      translatePiEvent({ type: "auto_retry_start", attempt: 2, delayMs: 500 }),
    ).toEqual([{ type: "api_retry", attempt: 2, retryDelayMs: 500, errorStatus: null }]);

    const [extErr] = translatePiEvent({
      type: "extension_error",
      extensionPath: "/x/ext.ts",
      error: "boom",
    });
    expect(extErr?.type).toBe("custom_message");
    if (extErr?.type === "custom_message") {
      expect(extErr.role).toBe("system");
      expect(extErr.content).toContain("boom");
    }

    const [compaction] = translatePiEvent({ type: "compaction_start", reason: "threshold" });
    expect(compaction?.type).toBe("custom_message");
  });

  it("drops provider-owned and unknown frames", () => {
    for (const type of [
      "agent_start",
      "agent_end",
      "message_start",
      "tool_execution_start",
      "queue_update",
      "some_future_event",
    ]) {
      expect(translatePiEvent({ type })).toEqual([]);
    }
  });
});

describe("renderHistorySeed", () => {
  it("renders user/assistant turns with tool calls inside an envelope", () => {
    const seed = renderHistorySeed([
      { role: "user", content: "fix the bug" },
      {
        role: "assistant",
        content: "On it.",
        providerId: "claude",
        model: "opus",
        toolCalls: [
          {
            id: "t1",
            name: "run_shell",
            input: { command: "bun test" },
            output: "1 pass",
            success: true,
          },
        ],
      },
    ]);
    expect(seed).toContain("<conversation-history>");
    expect(seed).toContain("## User\nfix the bug");
    expect(seed).toContain("## Assistant (claude/opus)");
    // Structured tool block — not the old one-line "[Tool: …]" flattening.
    expect(seed).toContain("### Tool call: run_shell → ok");
    expect(seed).toContain(`input: {"command":"bun test"}`);
    expect(seed).toContain("1 pass");
    expect(seed).not.toContain("[Tool:");
    expect(seed).toContain("</conversation-history>");
  });

  it("marks failed tool calls and truncates oversized outputs per-tool", () => {
    const seed = renderHistorySeed([
      {
        role: "assistant",
        content: "Ran it.",
        providerId: "pi",
        model: "m",
        toolCalls: [
          {
            id: "t1",
            name: "run_shell",
            input: { command: "bad" },
            output: "x".repeat(5_000),
            success: false,
          },
        ],
      },
    ]);
    expect(seed).toContain("### Tool call: run_shell → ERROR");
    expect(seed).toContain("…output truncated for seed…");
    // Global budget note should NOT appear for a single small turn.
    expect(seed).not.toContain("omitted for length");
  });

  it("returns empty for empty history", () => {
    expect(renderHistorySeed([])).toBe("");
  });

  it("drops the OLDEST turns when over budget, with an elision note", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `turn-${i} ${"x".repeat(400)}`,
    }));
    const seed = renderHistorySeed(turns, { maxChars: 1500 });
    expect(seed).toContain("earlier turn(s) omitted");
    expect(seed).toContain("turn-9");
    expect(seed).not.toContain("turn-0 ");
  });
});
