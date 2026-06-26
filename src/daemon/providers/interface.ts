/**
 * AgentProvider — the abstraction that lets codeoid use multiple LLM backends
 * (Claude, Gemini, OpenAI) over the same session, canonical history, scrollback,
 * auth, and tool approval flow.
 *
 * Design:
 *   - Codeoid owns the conversation history as CanonicalTurn[].
 *   - Each provider translates that history to its own API format on runTurn().
 *   - Tool approvals, scrollback, and transcript stay in Session; providers
 *     emit ProviderEvents which Session maps to SessionMessages.
 */

import type { AuthContext } from "../../protocol/types.js";
import type { CanonicalTurn } from "./canonical.js";
import type { LLMCallUsage } from "../context-math.js";

// ── Auth ──────────────────────────────────────────────────────────────────────

export type ProviderAuth =
  | { type: "subscription" }
  | { type: "api_key"; apiKey: string }
  | { type: "env"; envVar: string };

export interface ProviderConfig {
  auth: ProviderAuth;
  defaultModel?: string;
  baseURL?: string;
}

// ── Turn options ──────────────────────────────────────────────────────────────

/**
 * Approval callback — called by a provider from within its tool-use gate.
 * Session implements this as a closure capturing sender + approval state.
 */
export type ToolApprovalFn = (
  toolId: string,
  approvalId: string,
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}>;

export interface TurnOpts {
  /**
   * Full canonical history up to and including the current user turn.
   * ClaudeProvider ignores this (uses its own backing session).
   * Gemini/OpenAI convert it to their native message format via
   * toGeminiContent() / toOpenAIMessages() on each runTurn().
   */
  history: CanonicalTurn[];
  userMessage: string;
  model?: string;
  fallbackModel?: string;
  workdir: string;
  systemPromptAppend?: string;
  /** Session's unified approval gate — same semantics across all providers. */
  canUseTool: ToolApprovalFn;
  sender?: AuthContext;
}

// ── Normalized turn result ────────────────────────────────────────────────────

/**
 * Provider-agnostic turn summary emitted with turn_done.
 * Each provider maps its native response object to this shape so Session's
 * usage accounting and canonical-history recording stay provider-neutral.
 */
export interface NormalizedTurnResult {
  /** Provider that ran this turn (e.g. "claude", "gemini", "openai"). */
  providerId: string;
  /** Model identifier actually used (e.g. "claude-opus-4-5", "gemini-2.0-flash"). */
  model: string;
  /** NEW tokens consumed (excludes cache reads for Claude). */
  inputTokens: number;
  outputTokens: number;
  /** Claude-specific; 0 for other providers. */
  cacheReadTokens: number;
  /** Claude-specific; 0 for other providers. */
  cacheCreationTokens: number;
  totalCostUsd: number;
  durationMs: number;
  stopReason?: string;
  isError?: boolean;
  errorMessage?: string;
}

// ── Provider event stream ─────────────────────────────────────────────────────

/** Normalized event emitted by any provider. Session maps these to SessionMessages. */
export type ProviderEvent =
  | { type: "text_delta"; content: string }
  | { type: "text_done"; content: string }
  | { type: "thinking_delta"; content: string; blockIndex?: number }
  | { type: "thinking_done"; blockIndex?: number }
  /** Fired when a tool call starts (from the provider's canUseTool gate).
   *  Carries the provider-internal tool_use_id so Session can correlate messages. */
  | {
      type: "tool_start";
      toolId: string;
      sdkToolUseId: string;
      sdkAgentId?: string;
      name: string;
      input: Record<string, unknown>;
      approvalId: string;
    }
  /** Fired when a tool result is available (from the provider's user message). */
  | { type: "tool_complete"; sdkToolUseId: string; output: string; success: boolean }
  | { type: "subagent_start"; agentId: string; agentType: string }
  | { type: "subagent_stop"; agentId: string }
  | { type: "mcp_init"; servers: Record<string, string>; tools: Record<string, string[]> }
  /** Per-LLM-call usage, split by primary vs subagent (null parent_tool_use_id = primary). */
  | { type: "llm_call"; usage: LLMCallUsage; isPrimary: boolean }
  | { type: "api_retry"; attempt?: number; retryDelayMs?: number; errorStatus?: number | null }
  | { type: "tool_progress"; toolName?: string; elapsedSeconds?: number }
  | { type: "turn_done"; result: NormalizedTurnResult }
  | { type: "error"; message: string };

// ── TurnRun ───────────────────────────────────────────────────────────────────

export interface TurnRun {
  /** Event stream — stays open across turns for keep-warm providers (Claude).
   *  Closes when the underlying loop ends. */
  events: AsyncIterable<ProviderEvent>;
  /** Stop the in-flight turn. */
  interrupt(): Promise<void>;
  /** Push a message mid-turn (ClaudeProvider only). */
  pushMidTurn?(content: string, priority: "now" | "next" | "later"): void;
}

// ── ModelInfo ─────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  displayName: string;
  description?: string;
}

// ── AgentProvider interface ───────────────────────────────────────────────────

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;

  /** Start a turn, return an event stream that closes on turn_done (stateless)
   *  or stays warm (ClaudeProvider). */
  runTurn(opts: TurnOpts): TurnRun;
  listModels(): Promise<ModelInfo[]>;
  dispose(): Promise<void>;
}
