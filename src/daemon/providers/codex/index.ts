/**
 * CodexProvider — OpenAI Codex CLI as a codeoid backend.
 *
 * Drives `codex app-server` (JSON-RPC over stdio, see rpc.ts) so codex's
 * own harness does the work — tools, sandbox, ChatGPT-subscription auth in
 * ~/.codex — while codeoid owns approvals, scrollback, and history.
 * First slice (see docs/provider-codex-design.md):
 *
 *   - warm process; one codex THREAD per backing session (thread id is the
 *     backingSessionId; resetToNewSession starts a fresh thread)
 *   - `approvalPolicy: "untrusted"` is pinned on every turn so codex asks
 *     before privileged actions; each server-side approval request routes
 *     through codeoid's canUseTool — approve/deny round-trips natively (no
 *     injected bridge, unlike pi)
 *   - `sandboxPolicy: "danger-full-access"` is pinned so codex EXECUTES the
 *     commands codeoid approves instead of re-sandboxing them. codeoid's
 *     canUseTool gate is the single trust authority (it implements the
 *     session mode — auto-approve in autonomous, prompt in guarded); codex's
 *     own bundled-bubblewrap sandbox is redundant with it AND non-portable —
 *     it needs unprivileged user namespaces that containers and hardened
 *     hosts (`apparmor_restrict_unprivileged_userns=1`) forbid, and when
 *     bwrap can't initialize even an APPROVED command dies inside codex with
 *     "command execution rejected / cannot escalate". Operators on a
 *     bwrap-capable host who want defense-in-depth can restore it via
 *     CODEX_SANDBOX_POLICY / CODEX_APPROVAL_POLICY (see codexPolicies()).
 *   - `item/tool/requestUserInput` → requestUserInput (session.ui_request)
 *   - text/reasoning deltas stream; command/fileChange/mcp items surface
 *     as tool records; usage from turn/completed
 *   - seedFromHistory prepends renderHistorySeed to the first prompt (the
 *     warm-backend ceiling; codex threads only resume codex's own state)
 *
 * Non-gated items (codex ran something its policy considers trusted, e.g.
 * read-only commands) are recorded retrospectively at item/completed as a
 * paired tool_start/tool_complete — visible in scrollback + canonical
 * history without pretending codeoid gated them.
 */

import { randomUUID } from "node:crypto";
import { AsyncQueue } from "../../async-queue.js";
import type { Store } from "../../store.js";
import type {
  ModelInfo,
  NormalizedTurnResult,
  ProviderEvent,
  SessionProvider,
  ToolApprovalFn,
  TurnOpts,
  TurnRun,
  UiRequestFn,
} from "../interface.js";
import { renderHistorySeed, type CanonicalTurn } from "../canonical.js";
import { buildCodexEnv } from "../env.js";
import { CodexRpcProcess } from "./rpc.js";

/** codex `tokenUsage.last` / `.total` shape (thread/tokenUsage/updated). */
interface CodexTokenUsage {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface CodexProviderInit {
  sessionId: string;
  /** codex thread id from a previous run, or the codeoid session id on first run. */
  initialBackingId: string;
  /** Resolved binary (see resolve.ts). */
  command: string;
  argsPrefix?: string[];
  store: Store;
  onModels?: (
    models: ReadonlyArray<{ value: string; displayName: string; description?: string }>,
  ) => void;
}

/** Item types that surface as tool records (vs text/reasoning streams). */
const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "tool",
]);

/** codex `approvalPolicy` enum (app-server v2 turn params). */
const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "on-failure", "never"]);
/** codex `sandboxPolicy` enum (app-server v2 turn params). */
const SANDBOX_POLICIES = new Set(["read-only", "workspace-write", "danger-full-access"]);

/**
 * The approval + sandbox policy codeoid pins on codex thread/turn starts.
 *
 * Defaults (see the file header for the full rationale): codeoid's canUseTool
 * gate is the trust authority, so codex ASKS before every non-trivial action
 * (`untrusted`) and runs approved actions with its own sandbox DISABLED
 * (`danger-full-access`) — portable, and non-redundant with codeoid's gate.
 *
 * Both are overridable via env for operators on a bubblewrap-capable host who
 * want codex's sandbox as defense-in-depth. An unknown value falls back to the
 * default rather than letting codex reject the turn/start.
 */
function codexPolicies(): { approvalPolicy: string; sandboxPolicy: string } {
  const approval = process.env.CODEX_APPROVAL_POLICY?.trim();
  const sandbox = process.env.CODEX_SANDBOX_POLICY?.trim();
  return {
    approvalPolicy: approval && APPROVAL_POLICIES.has(approval) ? approval : "untrusted",
    sandboxPolicy: sandbox && SANDBOX_POLICIES.has(sandbox) ? sandbox : "danger-full-access",
  };
}

export class CodexProvider implements SessionProvider {
  readonly id = "codex";
  readonly displayName = "Codex (OpenAI)";

  onRecoveryNeeded: ((content: string) => void) | undefined;

  #sessionId: string;
  #backingSessionId: string;
  #command: string;
  #argsPrefix: string[];
  #onModels?: CodexProviderInit["onModels"];

  #proc: CodexRpcProcess | null = null;
  #threadId: string | null = null;
  #hasQueried = false;
  #modelsReported = false;
  #pendingHistorySeed: string | null = null;

  // Per-turn wiring.
  #turnQueue: AsyncQueue<ProviderEvent> | null = null;
  #canUseTool: ToolApprovalFn | null = null;
  #requestUserInput: UiRequestFn | undefined;
  #turnStartedAt = 0;
  #turnModel = "codex";
  #currentTurnId: string | null = null;
  /**
   * Latest per-turn token usage from `thread/tokenUsage/updated`. codex's
   * `turn/completed` carries NO usage (verified live) — it arrives on the
   * separate token-usage notification, `tokenUsage.last` being this turn's
   * counts. Captured here and folded into turn_done.
   */
  #lastTokenUsage: CodexTokenUsage | null = null;
  /** item id → {name, input} for items already announced via tool_start. */
  #announcedItems = new Map<string, { name: string; input: Record<string, unknown> }>();

  constructor(init: CodexProviderInit) {
    this.#sessionId = init.sessionId;
    this.#backingSessionId = init.initialBackingId;
    this.#command = init.command;
    this.#argsPrefix = init.argsPrefix ?? [];
    this.#onModels = init.onModels;
  }

  get backingSessionId(): string {
    return this.#backingSessionId;
  }
  get hasQueried(): boolean {
    return this.#hasQueried;
  }
  get queuedMessages(): number {
    return 0;
  }

  resetToNewSession(newBackingId: string): void {
    this.#backingSessionId = newBackingId;
    this.#threadId = null;
    this.#hasQueried = false;
  }

  setHasQueried(value: boolean): void {
    this.#hasQueried = value;
  }

  seedFromHistory(history: readonly CanonicalTurn[]): void {
    const seed = renderHistorySeed(history);
    this.#pendingHistorySeed = seed.length > 0 ? seed : null;
  }

  runTurn(opts: TurnOpts): TurnRun {
    const queue = new AsyncQueue<ProviderEvent>();
    this.#turnQueue = queue;
    this.#canUseTool = opts.canUseTool;
    this.#requestUserInput = opts.requestUserInput;
    this.#turnStartedAt = Date.now();
    this.#turnModel = opts.model ?? "codex";
    this.#announcedItems.clear();
    this.#lastTokenUsage = null;
    this.#hasQueried = true;

    void this.#startTurn(opts).catch((err: unknown) => {
      this.#push({ type: "error", message: `codex: ${err instanceof Error ? err.message : String(err)}` });
      queue.close();
    });

    return {
      events: queue,
      interrupt: async () => {
        if (this.#proc?.alive && this.#threadId) {
          try {
            await this.#proc.request("turn/interrupt", {
              threadId: this.#threadId,
              ...(this.#currentTurnId ? { turnId: this.#currentTurnId } : {}),
            });
            return;
          } catch {
            /* fall through to hard close */
          }
        }
        queue.close();
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.#proc?.alive) return [];
    try {
      const result = (await this.#proc.request("model/list", {})) as {
        data?: Array<{ id?: string; model?: string; displayName?: string; description?: string }>;
      };
      return (result.data ?? [])
        .filter((m) => typeof (m.model ?? m.id) === "string")
        .map((m) => ({
          id: (m.model ?? m.id) as string,
          displayName: m.displayName ?? ((m.model ?? m.id) as string),
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
    this.#turnQueue?.close();
    this.#turnQueue = null;
    this.#proc?.kill();
    this.#proc = null;
    this.#threadId = null;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  async #startTurn(opts: TurnOpts): Promise<void> {
    await this.#ensureThread(opts);
    const seed = this.#pendingHistorySeed;
    this.#pendingHistorySeed = null;
    const text = seed ? `${seed}\n\n${opts.userMessage}` : opts.userMessage;

    const { approvalPolicy, sandboxPolicy } = codexPolicies();
    const result = (await this.#proc!.request("turn/start", {
      threadId: this.#threadId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd: opts.workdir,
      // Fail-closed parity with the pi bridge: codex ASKS for every
      // privileged action so codeoid's gate is authoritative, and EXECUTES
      // approved actions (sandbox off) instead of re-sandboxing them (which
      // fails wherever bubblewrap can't init). See codexPolicies().
      approvalPolicy,
      sandboxPolicy,
      ...(opts.model ? { model: opts.model } : {}),
    })) as { turn?: { id?: string } };
    this.#currentTurnId = result.turn?.id ?? null;
  }

  async #ensureThread(opts: TurnOpts): Promise<void> {
    if (this.#proc?.alive && this.#threadId) return;

    if (!this.#proc?.alive) {
      this.#proc = new CodexRpcProcess({
        command: this.#command,
        argsPrefix: this.#argsPrefix,
        cwd: opts.workdir,
        env: buildCodexEnv(),
        onNotification: (method, params) => this.#onNotification(method, params),
        onServerRequest: (method, params) => this.#onServerRequest(method, params),
        onExit: ({ code, signal, stderrTail }) => {
          const queue = this.#turnQueue;
          if (queue && !queue.closed) {
            this.#push({
              type: "error",
              message: `codex exited unexpectedly (code=${code} signal=${signal})${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`,
            });
            queue.close();
          }
        },
      });
      await this.#proc.request("initialize", {
        clientInfo: { name: "codeoid", title: "codeoid", version: "1.0" },
      });
      this.#proc.notify("initialized");
    }

    // Resume the prior thread when the backing id looks like one codex
    // minted; otherwise (first run: backing id is the codeoid session id)
    // start fresh. Resume failure degrades to a fresh thread — never wedge.
    if (this.#backingSessionId !== this.#sessionId) {
      try {
        const resumed = (await this.#proc.request("thread/resume", {
          threadId: this.#backingSessionId,
        })) as { thread?: { id?: string } };
        if (resumed.thread?.id) {
          this.#threadId = resumed.thread.id;
          return;
        }
      } catch {
        /* fall through to thread/start */
      }
    }
    const { approvalPolicy, sandboxPolicy } = codexPolicies();
    const started = (await this.#proc.request("thread/start", {
      cwd: opts.workdir,
      approvalPolicy,
      sandboxPolicy,
      ...(opts.systemPromptAppend ? { developerInstructions: opts.systemPromptAppend } : {}),
    })) as { thread?: { id?: string } };
    if (!started.thread?.id) throw new Error("codex thread/start returned no thread id");
    this.#threadId = started.thread.id;
    this.#backingSessionId = started.thread.id;

    if (!this.#modelsReported && this.#onModels) {
      const models = await this.listModels();
      if (models.length > 0) {
        this.#modelsReported = true;
        this.#onModels(models.map((m) => ({ value: m.id, displayName: m.displayName, description: m.description })));
      }
    }
  }

  #push(event: ProviderEvent): void {
    const queue = this.#turnQueue;
    if (!queue || queue.closed) return;
    try {
      queue.push(event);
    } catch {
      /* closed between check and push */
    }
  }

  #onNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "item/agentMessage/delta": {
        const delta = (params.delta ?? params.text) as string | undefined;
        if (delta) this.#push({ type: "text_delta", content: delta });
        break;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = (params.delta ?? params.text) as string | undefined;
        if (delta) this.#push({ type: "thinking_delta", content: delta });
        break;
      }
      case "item/completed": {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) break;
        const itemType = item.type as string;
        const itemId = String(item.id ?? "");
        if (itemType === "agentMessage") {
          const text = (item.text ?? item.content ?? "") as string;
          this.#push({ type: "text_done", content: typeof text === "string" ? text : "" });
          this.#push({ type: "thinking_done" });
        } else if (TOOL_ITEM_TYPES.has(itemType)) {
          // Items codeoid gated were announced at approval time; items
          // codex ran under its own trusted policy are recorded here
          // retrospectively so scrollback + canonical history stay honest.
          if (!this.#announcedItems.has(itemId)) {
            const { name, input } = codexItemToTool(itemType, item);
            this.#push({
              type: "tool_start",
              toolId: itemId,
              sdkToolUseId: itemId,
              name,
              input,
              approvalId: `codex-auto-${itemId}`,
            });
          }
          this.#push({
            type: "tool_complete",
            sdkToolUseId: itemId,
            output: extractItemOutput(item),
            success: (item.status ?? "completed") !== "failed",
          });
          this.#announcedItems.delete(itemId);
        }
        break;
      }
      case "turn/completed": {
        const turn = params.turn as Record<string, unknown> | undefined;
        const u = this.#lastTokenUsage;
        // Match the claude convention: inputTokens = NEW tokens (cache reads
        // excluded); codex's inputTokens INCLUDES its cachedInputTokens.
        const cacheRead = u?.cachedInputTokens ?? 0;
        const result: NormalizedTurnResult = {
          providerId: this.id,
          model: this.#turnModel,
          inputTokens: Math.max(0, (u?.inputTokens ?? 0) - cacheRead),
          outputTokens: u?.outputTokens ?? 0,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: 0,
          totalCostUsd: 0,
          durationMs: Date.now() - this.#turnStartedAt,
          stopReason: (turn?.status as string | undefined) ?? undefined,
        };
        this.#push({ type: "turn_done", result });
        this.#turnQueue?.close();
        break;
      }
      case "thread/tokenUsage/updated": {
        const usage = (params.tokenUsage as { last?: CodexTokenUsage } | undefined)?.last;
        if (usage) this.#lastTokenUsage = usage;
        break;
      }
      case "error": {
        const message = (params.message ?? params.error ?? "codex error") as string;
        this.#push({ type: "error", message: String(message) });
        break;
      }
      default:
        break; // plan/diff/status notifications — future slices
    }
  }

  async #onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": {
        const canUseTool = this.#canUseTool;
        // Fail closed: an approval with no gate wired is denied, never run.
        if (!canUseTool) return { decision: "denied" };
        const itemId = String(params.itemId ?? params.approvalId ?? randomUUID());
        const { name, input } = approvalToTool(method, params);
        this.#announcedItems.set(itemId, { name, input });
        this.#push({
          type: "tool_start",
          toolId: itemId,
          sdkToolUseId: itemId,
          name,
          input,
          approvalId: `codex-${itemId}`,
        });
        const verdict = await canUseTool(itemId, `codex-${itemId}`, name, input);
        return { decision: verdict.behavior === "allow" ? "approved" : "denied" };
      }
      case "item/tool/requestUserInput": {
        const ask = this.#requestUserInput;
        if (!ask) return { answers: [] };
        const questions = (params.questions ?? []) as Array<Record<string, unknown>>;
        const answers: Array<Record<string, unknown>> = [];
        for (const q of questions) {
          const options = (q.options as Array<{ label?: string }> | undefined)
            ?.map((o) => o.label ?? "")
            .filter((l) => l.length > 0);
          const response = await ask({
            method: options && options.length > 0 ? "select" : "input",
            title: String(q.header ?? q.question ?? "Codex asks"),
            message: typeof q.question === "string" ? q.question : undefined,
            options,
          });
          answers.push({
            id: q.id,
            // Cancellation is "no answer", never consent (interface contract).
            answer: response.cancelled ? null : (response.value ?? null),
          });
        }
        return { answers };
      }
      default:
        // Unknown server request — refuse rather than guess (fail closed).
        throw new Error(`codeoid does not handle codex request: ${method}`);
    }
  }
}

/** Map an approval request to a codeoid tool name + input. */
function approvalToTool(
  method: string,
  params: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  if (method === "item/commandExecution/requestApproval") {
    return {
      name: "Bash",
      input: {
        command: String(params.command ?? params.parsedCmd ?? ""),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.reason ? { reason: params.reason } : {}),
      },
    };
  }
  if (method === "item/fileChange/requestApproval") {
    return {
      name: "codex_file_change",
      input: {
        ...(params.changes !== undefined ? { changes: params.changes } : {}),
        ...(params.grantRoot !== undefined ? { grantRoot: params.grantRoot } : {}),
        ...(params.reason ? { reason: params.reason } : {}),
      },
    };
  }
  return { name: "codex_permissions", input: { ...params } };
}

/** Tool record for items codex ran without asking (trusted policy). */
function codexItemToTool(
  itemType: string,
  item: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  if (itemType === "commandExecution") {
    return { name: "Bash", input: { command: String(item.command ?? "") } };
  }
  if (itemType === "fileChange") {
    return { name: "codex_file_change", input: { changes: item.changes ?? item.patch ?? null } };
  }
  if (itemType === "mcpToolCall") {
    return {
      name: `mcp__${String(item.server ?? "codex")}__${String(item.tool ?? "tool")}`,
      input: (item.arguments as Record<string, unknown>) ?? {},
    };
  }
  return { name: `codex_${itemType}`, input: {} };
}

function extractItemOutput(item: Record<string, unknown>): string {
  const out = item.aggregatedOutput ?? item.output ?? item.result ?? item.text ?? "";
  return typeof out === "string" ? out : JSON.stringify(out);
}
