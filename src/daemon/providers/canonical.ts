/**
 * Canonical conversation history — the format codeoid uses internally so
 * multiple providers can share turns.
 *
 * Phase 1: types + constants + history converters + CanonicalHistoryAccumulator.
 *   - Tool calls are rendered as inline text for non-Claude providers so they
 *     see what ran and what it returned, without needing function-calling support.
 *
 * Phase 2 (future): replace the inline-text fallback in each converter with
 *   the provider's native function_call / function_response format. The
 *   CanonicalToolCall type already captures everything needed.
 */

import { type ProviderEvent, isSubagentEvent } from "./interface.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A captured tool call — input from the canUseTool gate, output from the
 * provider's tool_result event.
 */
export interface CanonicalToolCall {
  /** Provider tool_use_id (or a generated UUID for providers that omit it). */
  id: string;
  /** Normalized snake_case name ("read_file", "run_shell"). */
  name: string;
  /** Tool input using Claude Code's field-name conventions as reference. */
  input: Record<string, unknown>;
  /** Tool result text, subject to TOOL_OUTPUT_LIMITS. */
  output: string;
  success: boolean;
  /** Original provider name before normalization ("Read", "Bash"). */
  originalName?: string;
}

export type CanonicalTurn =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: CanonicalToolCall[];
      thinking?: string;
      /** Which provider produced this turn. */
      providerId: string;
      model: string;
    };

// ── Tool name normalization ───────────────────────────────────────────────────

/**
 * Claude Code Pascal-case → canonical snake_case.
 * Applied at capture time in ClaudeProvider.
 */
export const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  Read: "read_file",
  Write: "write_file",
  Edit: "str_replace_file",
  MultiEdit: "multi_edit_file",
  Bash: "run_shell",
  Glob: "glob_files",
  Grep: "search_in_files",
  LS: "list_directory",
  Task: "spawn_subagent",
  WebSearch: "web_search",
  WebFetch: "web_fetch",
  TodoRead: "read_todos",
  TodoWrite: "write_todos",
};

export function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name;
}

// ── Tool output size limits ───────────────────────────────────────────────────

/**
 * Per-category output size limits applied at capture time (not at conversion).
 * Prevents a single large tool result from flooding a switching provider's
 * context window. When exceeded, a truncation note is appended.
 */
export const TOOL_OUTPUT_LIMITS: Readonly<Record<string, number>> = {
  read_file: 32_768,
  run_shell: 8_192,
  str_replace_file: Number.POSITIVE_INFINITY,
  write_file: Number.POSITIVE_INFINITY,
  multi_edit_file: Number.POSITIVE_INFINITY,
  glob_files: 8_192,
  list_directory: 8_192,
  search_in_files: 8_192,
  spawn_subagent: 8_192,
  default_mcp: 16_384,
};

export function limitToolOutput(canonicalName: string, output: string): string {
  const limit = canonicalName.startsWith("mcp__")
    ? TOOL_OUTPUT_LIMITS.default_mcp
    : (TOOL_OUTPUT_LIMITS[canonicalName] ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(limit) || output.length <= limit) return output;
  return `${output.slice(0, limit)}\n…output truncated at ${limit} chars (full output was ${output.length} chars)`;
}

// ── History converters ────────────────────────────────────────────────────────

/**
 * Render a CanonicalToolCall as inline text for providers that don't natively
 * support function calling (Phase 1 fallback).
 */
function toolCallToText(tc: CanonicalToolCall): string {
  const inputStr = Object.entries(tc.input)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  const status = tc.success ? "" : " [ERROR]";
  const outputPreview = tc.output.length > 500
    ? `${tc.output.slice(0, 500)}…`
    : tc.output;
  return `[Tool: ${tc.name}(${inputStr})${status}]\n${outputPreview}`;
}

/**
 * Render a CanonicalTurn[] as Google Gemini Content[].
 *
 * Phase 1: tool calls are inlined as text in the model turn.
 * Phase 2: replace the inline-text block below with proper
 *   { functionCall: { name, args } } parts in the model turn and a
 *   follow-up user turn with { functionResponse: { name, response } } parts.
 */
export function toGeminiContent(
  history: readonly CanonicalTurn[],
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  const out: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

  for (const turn of history) {
    if (turn.role === "user") {
      out.push({ role: "user", parts: [{ text: turn.content }] });
      continue;
    }

    // Assistant turn — build text with optional tool-call summary.
    const parts: string[] = [];
    if (turn.content) parts.push(turn.content);

    // Phase 2: replace this block with native functionCall/functionResponse parts.
    if (turn.toolCalls && turn.toolCalls.length > 0) {
      parts.push("\n\n[Tool calls executed by previous agent:]");
      for (const tc of turn.toolCalls) {
        parts.push(toolCallToText(tc));
      }
    }

    out.push({ role: "model", parts: [{ text: parts.join("\n") }] });
  }

  return out;
}

/**
 * Render a CanonicalTurn[] as OpenAI ChatCompletionMessageParam[].
 *
 * Phase 1: tool calls are inlined as text in the assistant turn.
 * Phase 2: replace the inline-text block below with proper
 *   assistant.tool_calls[] + { role: "tool" } messages.
 */
export function toOpenAIMessages(
  history: readonly CanonicalTurn[],
): Array<{ role: "user" | "assistant" | "system"; content: string }> {
  const out: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

  for (const turn of history) {
    if (turn.role === "user") {
      out.push({ role: "user", content: turn.content });
      continue;
    }

    const parts: string[] = [];
    if (turn.content) parts.push(turn.content);

    // Phase 2: replace this block with tool_calls[] + tool role messages.
    if (turn.toolCalls && turn.toolCalls.length > 0) {
      parts.push("\n\n[Tool calls executed by previous agent:]");
      for (const tc of turn.toolCalls) {
        parts.push(toolCallToText(tc));
      }
    }

    out.push({ role: "assistant", content: parts.join("\n") });
  }

  return out;
}

/**
 * Render a CanonicalTurn[] as Anthropic API messages[].
 * Used when ClaudeProvider is switched into stateless mode (Phase 2),
 * or when seeding a new Claude backing session with prior context.
 *
 * Phase 1: tool calls are inlined as text.
 * Phase 2: replace with proper tool_use/tool_result content blocks.
 */
export function toAnthropicMessages(
  history: readonly CanonicalTurn[],
): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const turn of history) {
    if (turn.role === "user") {
      out.push({ role: "user", content: turn.content });
      continue;
    }

    const parts: string[] = [];
    if (turn.content) parts.push(turn.content);

    // Phase 2: replace with tool_use + tool_result content blocks.
    if (turn.toolCalls && turn.toolCalls.length > 0) {
      parts.push("\n\n[Tool calls executed by previous agent:]");
      for (const tc of turn.toolCalls) {
        parts.push(toolCallToText(tc));
      }
    }

    out.push({ role: "assistant", content: parts.join("\n") });
  }

  return out;
}

// ── CanonicalHistoryAccumulator ───────────────────────────────────────────────

/**
 * Accumulates ProviderEvents into a CanonicalTurn[] history.
 *
 * This is the single source of truth for multi-provider history sharing.
 * Session.ts will eventually delegate to this class; for now it is used
 * directly by the provider E2E tests and can be composed into any host.
 *
 * Lifecycle:
 *   1. Call pushUserTurn() before each runTurn() call.
 *   2. Feed every ProviderEvent from the TurnRun.events stream to handleEvent().
 *   3. On turn_done, the completed assistant CanonicalTurn is appended.
 *   4. history is ready for the next provider's TurnOpts.history.
 */
export class CanonicalHistoryAccumulator {
  #history: CanonicalTurn[] = [];

  // In-progress assistant turn state — reset on each turn_done.
  #currentText = "";
  #currentThinking = "";
  #currentTools = new Map<
    string, // sdkToolUseId
    { id: string; name: string; originalName?: string; input: Record<string, unknown>; output?: string; success?: boolean }
  >();

  get history(): readonly CanonicalTurn[] {
    return this.#history;
  }

  /** Append a user turn. Call once per runTurn() before feeding events. */
  pushUserTurn(content: string): void {
    this.#history.push({ role: "user", content });
  }

  /**
   * Feed one ProviderEvent from the TurnRun.events stream.
   * On turn_done, the completed assistant turn is appended to history.
   */
  handleEvent(event: ProviderEvent): void {
    // Subagent text/thinking is not primary conversation content — recording
    // it would corrupt cross-provider history (#82). Session already filters
    // these before feeding the accumulator; this guards standalone callers.
    if (isSubagentEvent(event)) return;
    switch (event.type) {
      case "text_done":
        // A turn can span several assistant messages (text → tool → text →
        // final text); each fires its own text_done. Append every block —
        // assigning would keep only the last one and drop all interleaved
        // reasoning from the canonical history (#82).
        this.#currentText = this.#currentText
          ? `${this.#currentText}\n\n${event.content}`
          : event.content;
        break;

      case "thinking_delta":
        this.#currentThinking += event.content;
        break;

      case "tool_start":
        this.#currentTools.set(event.sdkToolUseId, {
          id: event.sdkToolUseId,
          name: normalizeToolName(event.name),
          originalName: event.name,
          input: event.input,
        });
        break;

      case "tool_complete": {
        const partial = this.#currentTools.get(event.sdkToolUseId);
        if (partial) {
          partial.output = limitToolOutput(partial.name, event.output);
          partial.success = event.success;
        }
        break;
      }

      case "turn_done": {
        const toolCalls: CanonicalToolCall[] = [
          ...this.#currentTools.values(),
        ].filter((t): t is CanonicalToolCall => t.output !== undefined);

        this.#history.push({
          role: "assistant",
          content: this.#currentText,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(this.#currentThinking ? { thinking: this.#currentThinking } : {}),
          providerId: event.result.providerId,
          model: event.result.model,
        });

        // Reset in-progress state for the next turn.
        this.#currentText = "";
        this.#currentThinking = "";
        this.#currentTools.clear();
        break;
      }
    }
  }

  /** Reset the entire history. Useful after a session rotation. */
  reset(): void {
    this.#history = [];
    this.#currentText = "";
    this.#currentThinking = "";
    this.#currentTools.clear();
  }
}

// ── History seeding (provider switch) ─────────────────────────────────────────

/** Character budget for a rendered history seed (~6k tokens). */
export const HISTORY_SEED_MAX_CHARS = 24_000;

/**
 * Render the canonical history as a plain-text transcript block for seeding
 * a NEW warm backend after `session.set_provider`. Stateless providers
 * ignore this (they consume `TurnOpts.history` natively every turn); warm
 * providers (claude, pi) prepend it to their first post-switch prompt so
 * the incoming agent can continue the conversation.
 *
 * Fidelity contract: this is a faithful TRANSCRIPT, not a native
 * continuation — tool calls are flattened to text and provider-native
 * structures don't survive. Oldest turns are dropped first when the budget
 * is exceeded (recent context matters most), with an elision note.
 */
export function renderHistorySeed(
  history: readonly CanonicalTurn[],
  opts: { maxChars?: number } = {},
): string {
  if (history.length === 0) return "";
  const maxChars = opts.maxChars ?? HISTORY_SEED_MAX_CHARS;

  const rendered = history.map((turn) => {
    if (turn.role === "user") {
      return `## User\n${turn.content}`;
    }
    const parts: string[] = [`## Assistant (${turn.providerId}/${turn.model})`];
    if (turn.content) parts.push(turn.content);
    for (const tc of turn.toolCalls ?? []) {
      parts.push(toolCallToText(tc));
    }
    return parts.join("\n");
  });

  // Keep the newest turns whole; drop the oldest that don't fit.
  const kept: string[] = [];
  let used = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const block = rendered[i]!;
    if (used + block.length > maxChars && kept.length > 0) break;
    kept.unshift(block);
    used += block.length;
  }
  const omitted = rendered.length - kept.length;
  if (omitted > 0) {
    kept.unshift(`[…${omitted} earlier turn(s) omitted for length…]`);
  }

  return [
    "<conversation-history>",
    "You are taking over an ongoing session from another agent backend.",
    "The conversation so far (tool calls flattened to text, possibly",
    "truncated) follows. Continue it seamlessly — do not re-introduce",
    "yourself or repeat completed work.",
    "",
    kept.join("\n\n"),
    "</conversation-history>",
  ].join("\n");
}
