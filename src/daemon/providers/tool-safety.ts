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
