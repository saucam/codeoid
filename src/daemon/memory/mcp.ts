/**
 * Memory MCP server — exposes the memory recall tools to Claude via the Agent
 * SDK's in-process MCP API (createSdkMcpServer + tool), so no subprocess or IPC
 * is involved.
 *
 * This is now a THIN adapter: the tool bodies + formatting live in the
 * transport-neutral registry (./tools.ts) so every other backend can expose the
 * same tools. The server is bound to a single (workspace, session) pair — that
 * binding is the tenant scope; tools take no scope arguments.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { MemoryEngine } from "./engine.js";
import { memoryToolDefs, type MemoryToolContext } from "./tools.js";

export interface MemoryMcpBinding {
  workspaceId: string;
  /** Current session ID — used to exclude the caller's own turns from recall by default. */
  sessionId: string;
}

export function buildMemoryMcpServer(
  engine: MemoryEngine,
  binding: MemoryMcpBinding,
): McpSdkServerConfigWithInstance {
  const ctx: MemoryToolContext = {
    engine,
    workspaceId: binding.workspaceId,
    sessionId: binding.sessionId,
  };
  const tools = memoryToolDefs().map((def) =>
    tool(def.name, def.description, def.zodShape, async (args) => ({
      content: [{ type: "text" as const, text: await def.run(args, ctx) }],
    })),
  );
  return createSdkMcpServer({
    name: "codeoid-memory",
    version: "0.1.0",
    tools,
  });
}
