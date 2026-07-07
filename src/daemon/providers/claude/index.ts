/**
 * ClaudeProvider — wraps the Claude Agent SDK query loop and emits ProviderEvents.
 *
 * Owns all Claude-specific state:
 *   - claudeCodeSessionId (the backing SDK session, separate from codeoid's session.id)
 *   - hasQueried / backingRecoveryAttempted flags
 *   - SDK Query + AsyncQueue + consumer task
 *
 * Session remains the owner of scrollback, transcript, approvals, and all
 * SessionMessage state.  ProviderEvents are the interface between the two.
 */

import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type PreToolUseHookInput,
  type SubagentStartHookInput,
  type SubagentStopHookInput,
  type McpServerConfig,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AsyncQueue } from "../../async-queue.js";
import type { AgentIdentityManager } from "../../agent-identity.js";
import type { Store } from "../../store.js";
import {
  buildMemoryMcpServer,
  type MemoryEngine,
} from "../../memory/index.js";
import type { CompressionRegistry } from "../../compress/index.js";
import { FLEET_TOOL_NAMES } from "../../fleet.js";
import { rewriteBashToolInput } from "../../compress/index.js";
import type { CodeoidConfig } from "../../../config.js";
import type { AuthContext } from "../../../protocol/types.js";
import type { SessionProvider, ModelInfo, NormalizedTurnResult, ProviderEvent, TurnOpts, TurnRun } from "../interface.js";
import type { LLMCallUsage } from "../../context-math.js";

// ── Initialisation options ────────────────────────────────────────────────────

export interface ClaudeProviderInit {
  /** codeoid session id — used as the initial backing id and for audit/logging. */
  sessionId: string;
  /** Persisted backing id from Store, or the session id itself on first run. */
  initialBackingId: string;
  /** Tenant-scoped memory workspace id (computed once by Session). Used to bind
   * the memory MCP server so recall/timeline read the SAME scope episodes are
   * written under. */
  workspaceId: string;
  store: Store;
  identityManager?: AgentIdentityManager;
  /** Codeoid memory engine — injected as an MCP server. */
  memory?: MemoryEngine;
  /** codeoid_fleet MCP server — conductor sessions only (read-only fleet view). */
  fleet?: McpSdkServerConfigWithInstance;
  config?: CodeoidConfig;
  compressionRegistry?: CompressionRegistry;
  /** Called once per session with the live model catalog. */
  onModels?: (models: ReadonlyArray<{ value: string; displayName: string; description?: string }>) => void;
  /**
   * Called when the backing Claude Code session is missing (i.e. the SDK
   * throws "No conversation found with session ID").  Session must enqueue
   * the re-send through #sendChain so recovery is serialized with normal sends.
   */
  onRecoveryNeeded?: (content: string) => void;
}

// ── ClaudeProvider ────────────────────────────────────────────────────────────

export class ClaudeProvider implements SessionProvider {
  readonly id = "claude";
  readonly displayName = "Claude (Anthropic)";

  // Claude-specific backing-session state
  #claudeCodeSessionId: string;
  #hasQueried = false;
  #backingRecoveryAttempted = false;
  #lastPushedContent: string | null = null;

  // Long-running SDK loop (one per codeoid session)
  #query: Query | null = null;
  #abortController: AbortController | null = null;
  #inputQueue: AsyncQueue<SDKUserMessage> | null = null;
  #consumerTask: Promise<void> | null = null;

  // Long-running event queue — closed only when the SDK loop ends.
  // turn_done events are emitted as regular items; Session decides when to stop.
  #currentTurnQueue: AsyncQueue<ProviderEvent> | null = null;

  /**
   * Mutable callback — Session updates this before each runTurn() call to
   * capture the current sender for recovery error handling.
   */
  onRecoveryNeeded: ((content: string) => void) | undefined;

  // Per-turn mutable canUseTool + sender — updated on each runTurn()
  #currentCanUseTool: TurnOpts["canUseTool"] | null = null;
  #currentSender: AuthContext | null = null;

  #init: ClaudeProviderInit;

  constructor(init: ClaudeProviderInit) {
    this.#claudeCodeSessionId = init.initialBackingId;
    this.#init = init;
  }

  // ── Public accessors ──────────────────────────────────────────────────────

  get backingSessionId(): string { return this.#claudeCodeSessionId; }
  get queuedMessages(): number { return this.#inputQueue?.size ?? 0; }
  get hasQueried(): boolean { return this.#hasQueried; }

  setHasQueried(value: boolean): void {
    this.#hasQueried = value;
  }

  /**
   * Called by Session.#rotate() — mints a new backing session id so the next
   * runTurn() creates a fresh Claude Code session rather than resuming.
   */
  resetToNewSession(newBackingId: string): void {
    this.#claudeCodeSessionId = newBackingId;
    this.#hasQueried = false;
    this.#backingRecoveryAttempted = false;
    this.#lastPushedContent = null;
  }

  // ── AgentProvider interface ───────────────────────────────────────────────

  /**
   * Start (or reuse) the long-running SDK loop, push the user message, and
   * return a per-turn event stream that closes on turn_done.
   */
  runTurn(opts: TurnOpts): TurnRun {
    this.#currentCanUseTool = opts.canUseTool;
    this.#currentSender = opts.sender ?? null;

    this.#ensureQueryLoop(opts);

    // Close any stale turn queue from a previous turn that didn't end cleanly.
    this.#currentTurnQueue?.close();
    const turnQueue = new AsyncQueue<ProviderEvent>();
    this.#currentTurnQueue = turnQueue;

    if (opts.userMessage) {
      this.#pushSDKMessage(opts.userMessage, "later");
    }
    return {
      events: turnQueue,
      interrupt: async () => {
        const q = this.#query;
        if (q) {
          try {
            await q.interrupt();
            return;
          } catch {
            // fall through to hard abort
          }
        }
        this.#abortController?.abort();
        this.#inputQueue?.close();
      },
      pushMidTurn: (content, priority) => {
        this.#pushSDKMessage(content, priority);
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.#query) return [];
    try {
      const models = await this.#query.supportedModels();
      return models.map((m) => ({
        id: m.value,
        displayName: m.displayName,
        description: m.description,
      }));
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    await this.teardown();
  }

  async teardown(): Promise<void> {
    this.#inputQueue?.close();
    this.#abortController?.abort();
    if (this.#consumerTask) {
      try { await this.#consumerTask; } catch { /* consumer handles its own errors */ }
    }
    this.#currentTurnQueue?.close();
    this.#currentTurnQueue = null;
    this.#inputQueue = null;
    this.#consumerTask = null;
    this.#query = null;
    this.#abortController = null;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #pushSDKMessage(content: string, priority: "now" | "next" | "later"): void {
    if (!this.#inputQueue) {
      console.error(`[claude-provider ${this.#init.sessionId.slice(0, 8)}] push without active queue — dropping`);
      return;
    }
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.#claudeCodeSessionId,
      priority,
    };
    this.#lastPushedContent = content;
    try {
      this.#inputQueue.push(msg);
    } catch (err) {
      console.error(`[claude-provider] push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #ensureQueryLoop(opts: TurnOpts): void {
    if (this.#consumerTask && this.#inputQueue && !this.#inputQueue.closed) return;

    const init = this.#init;
    const sessionId = init.sessionId;
    this.#abortController = new AbortController();
    this.#inputQueue = new AsyncQueue<SDKUserMessage>();

    const sessionOpts = this.#hasQueried
      ? { resume: this.#claudeCodeSessionId }
      : { sessionId: this.#claudeCodeSessionId };

    // Merge user MCP servers with codeoid's in-process memory server.
    // Apply a per-call wall-clock timeout to the external (user) servers so a
    // hung MCP tool call surfaces as an SDK error instead of silently wedging
    // the turn. Not applied to the in-process memory server. Kept below the
    // session stall watchdog so the SDK signals first.
    const mcpToolTimeoutMs = init.config?.session.mcpToolTimeoutMs ?? 120_000;
    const merged: Record<string, McpServerConfig> = {
      ...withMcpToolTimeout(loadUserMcpServers(opts.workdir), mcpToolTimeoutMs),
      ...(init.memory
        ? {
            codeoid_memory: buildMemoryMcpServer(init.memory, {
              workspaceId: init.workspaceId,
              sessionId,
            }),
          }
        : {}),
      // Conductor sessions only — the read-only fleet view (P3). In-process,
      // so the external-server timeout doesn't apply.
      ...(init.fleet ? { codeoid_fleet: init.fleet } : {}),
    };
    const mcpServers = Object.keys(merged).length > 0 ? merged : undefined;

    this.#query = query({
      prompt: this.#inputQueue,
      options: {
        cwd: opts.workdir,
        abortController: this.#abortController,
        // Explicit env allowlist — never inherit the daemon's full process.env
        // (which holds the root ZeroID key + control-channel secrets). See
        // buildAgentEnv (GHSA-38vh vector 3).
        env: buildAgentEnv(),
        allowedTools: [
          ...(init.memory
            ? ["mcp__codeoid_memory__recall", "mcp__codeoid_memory__recall_file", "mcp__codeoid_memory__timeline"]
            : []),
          // Widened for the conductor's fleet server — without these entries
          // the mounted server's tools stay unreachable (design §3 gotcha).
          ...(init.fleet
            ? FLEET_TOOL_NAMES.map((t) => `mcp__codeoid_fleet__${t}`)
            : []),
        ],
        permissionMode: "default",
        includePartialMessages: true,
        persistSession: true,
        thinking: { type: "adaptive" as const },
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.fallbackModel ? { fallbackModel: opts.fallbackModel } : {}),
        stderr: (data: string) => {
          process.stderr.write(`[claude-subprocess ${sessionId.slice(0, 8)}] ${data}`);
        },
        ...(mcpServers ? { mcpServers } : {}),
        // Any non-empty append (memory guidance, conductor contract) rides on
        // the claude_code preset — previously gated on memory alone, which
        // silently dropped non-memory appends.
        ...(init.memory || opts.systemPromptAppend
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: opts.systemPromptAppend ?? "",
              },
            }
          : {}),
        ...sessionOpts,
        settingSources: ["project"],

        hooks: {
          PreToolUse: [{
            hooks: [async (rawInput) => {
              const input = rawInput as PreToolUseHookInput;
              init.store.audit(
                this.#currentSender?.sub ?? "unknown",
                "session.tool_call",
                sessionId,
                `tool=${input.tool_name}`,
              );
              // Compression rewrite.
              if (init.config && init.compressionRegistry) {
                const rewritten = rewriteBashToolInput({
                  toolName: input.tool_name,
                  toolInput: (input.tool_input ?? {}) as Record<string, unknown>,
                  config: init.config,
                  registry: init.compressionRegistry,
                  workdir: opts.workdir,
                });
                if (rewritten) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      updatedInput: rewritten,
                    },
                  };
                }
              }
              return {};
            }],
          }],

          SubagentStart: [{
            hooks: [async (rawInput) => {
              const input = rawInput as SubagentStartHookInput;
              const agentId = input.agent_id ?? "unknown";
              const agentType = input.agent_type ?? "unknown";
              this.#emit({ type: "subagent_start", agentId, agentType });
              return {};
            }],
          }],

          SubagentStop: [{
            hooks: [async (rawInput) => {
              const input = rawInput as SubagentStopHookInput;
              this.#emit({ type: "subagent_stop", agentId: input.agent_id ?? "unknown" });
              return {};
            }],
          }],
        },

        canUseTool: async (toolName, input, options) => {
          const toolId = randomUUID();
          const approvalId = randomUUID();
          const inputObj = input as Record<string, unknown>;

          // Correlate by the SDK's own tool_use_id, passed directly to this
          // callback. Never reconstruct it from a PreToolUse-fed name-keyed
          // FIFO: the SDK skips canUseTool for auto-allowed tools
          // (allowedTools / project permissions.allow), so any allow rule
          // desyncs such a queue and mis-correlates every later tool call
          // in the session (issue #81).
          const sdkToolUseId = options?.toolUseID;
          if (!sdkToolUseId) {
            return { behavior: "deny" as const, message: "Unable to correlate tool use id" };
          }
          const sdkAgentId = options?.agentID;

          // Emit tool_start — Session creates the SessionMessage.
          this.#emit({
            type: "tool_start",
            toolId,
            sdkToolUseId,
            sdkAgentId,
            name: toolName,
            input: inputObj,
            approvalId,
          });

          // Call Session's approval gate (may block until user responds).
          const canUse = this.#currentCanUseTool;
          if (!canUse) return { behavior: "deny" as const, message: "provider not ready" };
          const result = await canUse(toolId, approvalId, toolName, inputObj);
          if (result.behavior === "allow") {
            return { behavior: "allow", updatedInput: result.updatedInput as Record<string, unknown> | undefined };
          }
          return { behavior: "deny", message: result.message ?? "Denied" };
        },
      },
    });

    this.#hasQueried = true;

    // Fetch the live model catalog best-effort.
    if (init.onModels) {
      void this.#query
        .supportedModels()
        .then((m) => init.onModels?.(m))
        .catch(() => {});
    }

    const query$ = this.#query;
    const ac = this.#abortController;
    const queue$ = this.#inputQueue;
    let recoverContent: string | null = null;
    let selfTask: Promise<void> | null = null;

    selfTask = this.#consumerTask = (async () => {
      try {
        for await (const msg of query$) {
          this.#translateSDKMessage(msg);
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          const emsg = err instanceof Error ? err.message : String(err);
          if (
            this.#hasQueried &&
            !this.#backingRecoveryAttempted &&
            this.#lastPushedContent !== null &&
            /No conversation found with session ID/i.test(emsg)
          ) {
            console.error(`[claude-provider ${sessionId.slice(0, 8)}] backing session missing — scheduling recovery`);
            recoverContent = this.#lastPushedContent;
          } else {
            console.error(`[claude-provider ${sessionId.slice(0, 8)}] SDK query failed: ${emsg}`);
            this.#emit({ type: "error", message: emsg });
          }
        }
      } finally {
        // Close the current turn queue — session's for-await loop will finish.
        this.#currentTurnQueue?.close();
        this.#currentTurnQueue = null;

        if (this.#query === query$) this.#query = null;
        if (this.#abortController === ac) this.#abortController = null;
        queue$?.close();
        if (this.#inputQueue === queue$) this.#inputQueue = null;
        if (this.#consumerTask === selfTask) this.#consumerTask = null;
      }

      // Post-teardown recovery.
      if (recoverContent !== null) {
        this.#backingRecoveryAttempted = true;
        this.onRecoveryNeeded?.(recoverContent);
      }
    })();
  }

  /** Push a ProviderEvent to the active per-turn queue. */
  #emit(event: ProviderEvent): void {
    try {
      this.#currentTurnQueue?.push(event);
    } catch {
      // Queue may be closed if the turn ended early — ignore.
    }
  }

  /** Translate one SDKMessage to ProviderEvents. */
  #translateSDKMessage(msg: SDKMessage): void {
    translateSDKMessage(msg, this.#emit.bind(this), this.id);
  }
}

// ── Pure translation (exported for unit tests) ────────────────────────────────

/**
 * Translate one SDKMessage from the Claude Agent SDK into zero or more
 * ProviderEvents.  Pure function — no I/O, no side-effects beyond calling
 * `emit`.  Extracted so it can be unit-tested without spawning the SDK.
 */
export function translateSDKMessage(
  msg: SDKMessage,
  emit: (event: ProviderEvent) => void,
  providerId: string,
): void {
    switch (msg.type) {
      case "assistant": {
        // Per-call LLM usage — split primary vs subagent for accurate ctx tracking.
        const assistantMsg = msg as unknown as {
          message: {
            content: unknown;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
          parent_tool_use_id: string | null;
        };
        const perCall = assistantMsg.message?.usage;
        if (perCall) {
          const callUsage: LLMCallUsage = {
            inputTokens: perCall.input_tokens ?? 0,
            cacheReadTokens: perCall.cache_read_input_tokens ?? 0,
            cacheCreationTokens: perCall.cache_creation_input_tokens ?? 0,
            outputTokens: perCall.output_tokens ?? 0,
          };
          emit({ type: "llm_call", usage: callUsage, isPrimary: assistantMsg.parent_tool_use_id === null });
        }

        // Text content (tool_use blocks are handled via canUseTool → tool_start).
        // Tag with parent_tool_use_id so subagent text is never mistaken for
        // primary assistant output downstream (issue #82).
        const content = msg.message.content as unknown as Array<Record<string, unknown>>;
        const textParts: string[] = [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text as string);
          }
        }
        if (textParts.length > 0) {
          emit({
            type: "text_done",
            content: textParts.join(""),
            parentToolUseId: assistantMsg.parent_tool_use_id ?? null,
          });
        }
        break;
      }

      case "stream_event": {
        const streamMsg = msg as {
          event?: {
            type?: string;
            index?: number;
            content_block?: { type?: string };
            delta?: { type?: string; text?: string; thinking?: string };
          };
          parent_tool_use_id?: string | null;
        };
        const event = streamMsg.event;
        if (!event) break;
        // Subagent stream events carry the spawning tool call's id — tag every
        // text/thinking emission so consumers can keep them out of the primary
        // conversation (issue #82).
        const parentToolUseId = streamMsg.parent_tool_use_id ?? null;

        if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
          // Signal a new thinking block — Session creates the message.
          emit({ type: "thinking_delta", content: "", blockIndex: event.index, parentToolUseId });
          break;
        }

        if (event.type === "content_block_delta" && event.delta) {
          if (event.delta.type === "text_delta" && event.delta.text) {
            emit({ type: "text_delta", content: event.delta.text, parentToolUseId });
          } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
            emit({ type: "thinking_delta", content: event.delta.thinking, blockIndex: event.index, parentToolUseId });
          }
          break;
        }

        if (event.type === "content_block_stop") {
          emit({ type: "thinking_done", blockIndex: event.index, parentToolUseId });
        }
        break;
      }

      case "result": {
        const r = msg as {
          subtype?: string;
          is_error?: boolean;
          result?: string;
          stop_reason?: string | null;
          total_cost_usd?: number;
          duration_ms?: number;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>;
        };
        // Derive the model from the first key in modelUsage (most-used model this turn).
        const model = Object.keys(r.modelUsage ?? {})[0] ?? "unknown";
        const normalized: NormalizedTurnResult = {
          providerId,
          model,
          inputTokens: r.usage?.input_tokens ?? 0,
          outputTokens: r.usage?.output_tokens ?? 0,
          cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: r.usage?.cache_creation_input_tokens ?? 0,
          totalCostUsd: r.total_cost_usd ?? 0,
          durationMs: r.duration_ms ?? 0,
          stopReason: r.stop_reason ?? undefined,
          isError: r.is_error,
          errorMessage: r.subtype !== "success" && r.result ? r.result : undefined,
        };
        emit({ type: "turn_done", result: normalized });
        // Stay warm — keep the queue open for the next turn.
        // The queue is closed in the consumer's finally block when the SDK loop ends.
        break;
      }

      case "system": {
        const subtype = (msg as { subtype?: string }).subtype;
        if (subtype === "init") {
          const init = msg as { mcp_servers?: { name: string; status: string }[]; tools?: string[] };
          const servers: Record<string, string> = {};
          const tools: Record<string, string[]> = {};
          for (const s of init.mcp_servers ?? []) {
            servers[s.name] = s.status;
            tools[s.name] = [];
          }
          for (const t of init.tools ?? []) {
            if (!t.startsWith("mcp__")) continue;
            const rest = t.slice("mcp__".length);
            const sep = rest.indexOf("__");
            if (sep <= 0) continue;
            const server = rest.slice(0, sep);
            tools[server] ??= [];
            tools[server].push(t);
          }
          emit({ type: "mcp_init", servers, tools });
        } else if (subtype === "api_retry") {
          const r = msg as { attempt?: number; retry_delay_ms?: number; error_status?: number | null };
          emit({ type: "api_retry", attempt: r.attempt, retryDelayMs: r.retry_delay_ms, errorStatus: r.error_status });
        }
        break;
      }

      case "user": {
        // tool_result blocks — close the matching tool call with real output.
        const content = (msg.message as { content?: unknown }).content;
        if (!Array.isArray(content)) break;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type !== "tool_result") continue;
          const useId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
          if (!useId) continue;
          const output = extractToolResultText(block.content);
          const success = block.is_error !== true;
          emit({ type: "tool_complete", sdkToolUseId: useId, output, success });
        }
        break;
      }

      case "tool_progress": {
        const p = msg as { tool_name?: string; elapsed_time_seconds?: number };
        emit({ type: "tool_progress", toolName: p.tool_name, elapsedSeconds: p.elapsed_time_seconds });
        break;
      }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Apply a per-call wall-clock `timeout` (ms) to external MCP servers so a hung
 * tool call (e.g. an unresponsive HTTP gateway) returns an SDK error instead of
 * silently stalling the turn. Only sets it when `ms > 0` and the server hasn't
 * already declared its own `timeout`, so explicit per-server values still win.
 * `timeout` is valid on every external (stdio/http/sse) McpServerConfig variant;
 * these all come from JSON, so we re-cast at the same boundary parseMcpServerConfig uses.
 */
export function withMcpToolTimeout(
  servers: Record<string, McpServerConfig>,
  ms: number,
): Record<string, McpServerConfig> {
  if (ms <= 0) return servers;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    const obj = cfg as unknown as Record<string, unknown>;
    out[name] =
      typeof obj.timeout === "number"
        ? cfg
        : ({ ...obj, timeout: ms } as unknown as McpServerConfig);
  }
  return out;
}

function loadUserMcpServers(workdir: string): Record<string, McpServerConfig> {
  try {
    const raw = readFileSync(join(homedir(), ".claude.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const cfg = parsed as Record<string, unknown>;
    const result: Record<string, McpServerConfig> = {};
    for (const [k, v] of Object.entries(safeServerMap(cfg.mcpServers))) result[k] = v;
    for (const [k, v] of Object.entries(safeServerMap(safeProjectServers(cfg.projects, workdir)))) result[k] = v;
    return result;
  } catch {
    return {};
  }
}

function safeProjectServers(projects: unknown, workdir: string): unknown {
  if (typeof projects !== "object" || projects === null || Array.isArray(projects)) return undefined;
  const project = (projects as Record<string, unknown>)[workdir];
  if (typeof project !== "object" || project === null || Array.isArray(project)) return undefined;
  return (project as Record<string, unknown>).mcpServers;
}

function safeServerMap(raw: unknown): Record<string, McpServerConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, McpServerConfig> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const server = parseMcpServerConfig(value);
    if (server) result[key] = server;
  }
  return result;
}

export function parseMcpServerConfig(value: unknown): McpServerConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.command !== "string" && typeof obj.url !== "string") return null;
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args) || !obj.args.every((a) => typeof a === "string")) return null;
  }
  if (obj.env !== undefined) {
    if (typeof obj.env !== "object" || obj.env === null || Array.isArray(obj.env)) return null;
    if (!Object.values(obj.env as Record<string, unknown>).every((v) => typeof v === "string")) return null;
  }
  return obj as unknown as McpServerConfig;
}

/**
 * Build the environment handed to the spawned Claude Code subprocess.
 *
 * SECURITY (GHSA-38vh vector 3): the SDK `query()` is otherwise spawned with no
 * `env`, so the CLI — and its Bash tool, hooks, and stdio MCP servers — inherit
 * the daemon's FULL `process.env`, including secrets `loadDotEnv` writes there
 * (`TELEGRAM_BOT_TOKEN`, `CODEOID_API_KEY` = the root ZeroID key, provider keys,
 * `GOOGLE_CLIENT_SECRET`). Any attached user or prompt-injected agent could
 * `env` its way to the control-channel token. We pass an explicit ALLOWLIST
 * instead: only the vars the CLI legitimately needs to run and authenticate.
 *
 * Allowlisted: system/runtime essentials (PATH, HOME, locale, TMPDIR, proxy +
 * TLS trust), plus every `ANTHROPIC_*` / `CLAUDE_*` var (the CLI's own auth +
 * config namespace). Deployments on a non-Anthropic model backend (Bedrock /
 * Vertex) can extend the allowlist via `CODEOID_AGENT_ENV_ALLOW` (comma-
 * separated names) without reopening the hole for unrelated secrets.
 *
 * Pure + exported for unit testing.
 */
export function buildAgentEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const EXACT = new Set<string>([
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "LANG", "LANGUAGE",
    "TZ", "TERM", "TMPDIR", "TEMP", "TMP", "COLORTERM",
    // Proxy + TLS trust — needed for the CLI to reach the API through a
    // corporate proxy / custom CA. Not secrets.
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  ]);
  // The CLI's own namespaces (auth token, base url, model, feature flags) plus
  // POSIX locale categories (LC_ALL, LC_CTYPE, …).
  const PREFIXES = ["ANTHROPIC_", "CLAUDE_", "LC_"];
  const extra = (base.CODEOID_AGENT_ENV_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const extraSet = new Set(extra);

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (EXACT.has(k) || extraSet.has(k) || PREFIXES.some((p) => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return out;
}

export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push("[image]");
    } else if (typeof block.text === "string") {
      parts.push(block.text as string);
    }
  }
  return parts.join("\n");
}
