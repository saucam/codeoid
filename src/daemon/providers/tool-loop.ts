/**
 * Shared memory tool-loop helpers for the stateless function-calling backends
 * (OpenAI, Gemini).
 *
 * These backends resend the full canonical history every turn (lossless by
 * residency), so codeoid's memory tools are the ESCAPE HATCH: they let the
 * model page the verbatim store on demand — cross-session recall, or detail
 * beyond the window when a long history is truncated — via native function
 * calling. Because these providers run IN the daemon (not a subprocess), a tool
 * call executes `def.run()` directly; no MCP endpoint or proxy is involved
 * (that's what the URL-mounting backends in Phases 2–3 needed).
 *
 * SDK-specific streaming stays in each provider; this module owns the parts
 * that must stay identical across them: the tool declarations (namespaced so
 * `isSafeTool` treats them as read-only and they don't prompt), executing one
 * call through codeoid's `canUseTool` gate with tool_start/complete events, and
 * the per-turn runaway guard.
 */

import { randomUUID } from "node:crypto";
import { memoryToolDefs, type MemoryToolContext } from "../memory/tools.js";
import { MEMORY_MCP_SERVER_NAME } from "../memory/mcp-http.js";
import type { ProviderEvent, ToolApprovalFn } from "./interface.js";

/** Hard cap on tool rounds in a single turn — a runaway + cost guard. After
 *  this many rounds the loop stops paging and lets the model answer. */
export const MAX_MEMORY_TOOL_ROUNDS = 8;

const PREFIX = `${MEMORY_MCP_SERVER_NAME}__`;

/** Namespaced tool name so `isSafeTool` treats it as a read-only memory tool. */
export function namespacedMemoryToolName(bare: string): string {
  return `${PREFIX}${bare}`;
}

interface FunctionToolShape {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** OpenAI `tools[]` (chat.completions function tools) for the memory tools. */
export function memoryToolsAsOpenAI(): Array<{ type: "function"; function: FunctionToolShape }> {
  return memoryToolDefs().map((d) => ({
    type: "function" as const,
    function: { name: namespacedMemoryToolName(d.name), description: d.description, parameters: d.jsonSchema },
  }));
}

/** Gemini `functionDeclarations[]` for the memory tools. Gemini's function
 *  schema is an OpenAPI subset that rejects `additionalProperties`, so drop it
 *  (our tool schemas are one level deep — a shallow strip is enough). */
export function memoryToolsAsGemini(): FunctionToolShape[] {
  return memoryToolDefs().map((d) => {
    const { additionalProperties: _drop, ...parameters } = d.jsonSchema as Record<string, unknown>;
    return { name: namespacedMemoryToolName(d.name), description: d.description, parameters };
  });
}

export interface MemoryToolExecDeps {
  ctx: MemoryToolContext;
  canUseTool: ToolApprovalFn;
  emit: (e: ProviderEvent) => void;
}

/**
 * Execute one model-issued memory tool call end to end: emit tool_start, gate
 * through `canUseTool` (read-only memory tools auto-approve via isSafeTool), run
 * the def in-process, emit tool_complete. Never throws — an unknown tool or a
 * denial returns an error string the caller feeds back to the model as the
 * tool result, so the loop stays alive.
 */
export async function executeMemoryToolCall(
  toolName: string,
  args: Record<string, unknown>,
  deps: MemoryToolExecDeps,
): Promise<string> {
  const bare = toolName.startsWith(PREFIX) ? toolName.slice(PREFIX.length) : toolName;
  const def = memoryToolDefs().find((d) => d.name === bare);
  const toolId = randomUUID();
  const approvalId = `mem-${toolId}`;
  deps.emit({ type: "tool_start", toolId, sdkToolUseId: toolId, name: toolName, input: args, approvalId });

  if (!def) {
    const msg = `Unknown tool: ${toolName}`;
    deps.emit({ type: "tool_complete", sdkToolUseId: toolId, output: msg, success: false });
    return msg;
  }

  let verdict: Awaited<ReturnType<ToolApprovalFn>>;
  try {
    verdict = await deps.canUseTool(toolId, approvalId, toolName, args);
  } catch {
    verdict = { behavior: "deny" };
  }
  if (verdict.behavior !== "allow") {
    const msg = verdict.message ?? "Tool call denied by policy.";
    deps.emit({ type: "tool_complete", sdkToolUseId: toolId, output: msg, success: false });
    return msg;
  }

  try {
    const text = await def.run((verdict.updatedInput ?? args) as Record<string, unknown>, deps.ctx);
    deps.emit({ type: "tool_complete", sdkToolUseId: toolId, output: text, success: true });
    return text;
  } catch (e) {
    const msg = `Error: ${e instanceof Error ? e.message : String(e)}`;
    deps.emit({ type: "tool_complete", sdkToolUseId: toolId, output: msg, success: false });
    return msg;
  }
}
