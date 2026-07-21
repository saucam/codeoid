/**
 * Tool-safety classification — which tools are read-only and may run WITHOUT a
 * confirmation prompt (in guarded mode) or without burning the autonomous
 * budget. Pure + isolated so the boundary is unit-testable and can't silently
 * widen: an over-broad match here is a prompt-bypass, so it's security-relevant.
 */

import { MEMORY_MCP_SERVER_NAME } from "../memory/mcp-http.js";
import { MEMORY_TOOL_NAMES } from "../memory/tools.js";

/** Built-in read-only tools that never require confirmation. */
const SAFE_TOOLS = new Set<string>(["Read", "Grep", "Glob"]);

/** Namespace prefixes a backend gives the mounted memory MCP tools. */
const MEMORY_TOOL_PREFIXES = [
  `mcp__${MEMORY_MCP_SERVER_NAME}__`, // Claude in-process MCP
  `${MEMORY_MCP_SERVER_NAME}__`, // gemini-cli / codex URL mount
] as const;

/**
 * True for read-only tools safe to run unprompted. The memory recall tools are
 * read-only, but a backend namespaces them (`mcp__codeoid_memory__recall`,
 * `codeoid_memory__recall`, …). We require BOTH the exact namespace prefix AND
 * that the suffix is one of the known read-only tools — matching on the server
 * segment alone would let a look-alike (`x_codeoid_memory__wipe`) or a future
 * write-capable memory tool bypass confirmation. A different separator simply
 * prompts (fail-safe), never auto-approves by accident.
 */
export function isSafeTool(name: string): boolean {
  if (SAFE_TOOLS.has(name)) return true;
  for (const prefix of MEMORY_TOOL_PREFIXES) {
    if (name.startsWith(prefix)) {
      return (MEMORY_TOOL_NAMES as readonly string[]).includes(name.slice(prefix.length));
    }
  }
  return false;
}

// ── Capability-role enforcement (ambient pack activation — docs/pack-loading.md)

/** Built-in file-mutation tools. A `write:false` capability role (e.g. the
 *  reviewer) may not use these. Bash is deliberately NOT here — a reviewer keeps
 *  shell for read-only inspection (matching the ai-factory reviewer envelope
 *  `[read, grep, glob, bash]`); gating all of Bash would break inspection.
 *  NOTE: this makes the read-only role a call-time DENY of the write tools, NOT
 *  a hard sandbox — a determined agent could still mutate files via Bash
 *  (`>`, tee, sed -i, git apply). The role's system-prompt contract instructs
 *  the model not to; a true sandbox (Shield/OS fence) is a later slice. */
const WRITE_TOOLS = new Set<string>(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Built-in network tools. A role with `network:false` may not use these;
 *  `read-only` and `true` allow them (both built-ins are read-only fetches). */
const NETWORK_TOOLS = new Set<string>(["WebFetch", "WebSearch"]);

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}
export function isNetworkTool(name: string): boolean {
  return NETWORK_TOOLS.has(name);
}

/** A capability role's tool envelope (subset of the pack role schema). */
export interface ToolRole {
  write: boolean;
  network: boolean | "read-only";
  envelope: "all" | string[];
}

/**
 * If a capability role forbids `toolName`, returns a human reason; otherwise
 * null. Enforced at the `canUseTool` gate (call-time deny, cross-backend) —
 * NOT a static sandbox (the model still sees the tool and may attempt it). Only
 * the high-signal, cleanly-mapped rules are enforced: `write:false` blocks
 * file-mutation tools and `network:false` blocks the network tools. The role's
 * `envelope` allow-list is carried for display but not gated here (its category
 * names don't map 1:1 to concrete backend tool names); tighten in a later slice.
 */
export function roleDeniesTool(role: ToolRole, toolName: string): string | null {
  if (role.write === false && isWriteTool(toolName)) {
    return `capability role is read-only (write: false) — "${toolName}" is not permitted`;
  }
  if (role.network === false && isNetworkTool(toolName)) {
    return `capability role forbids network access (network: false) — "${toolName}" is not permitted`;
  }
  return null;
}
