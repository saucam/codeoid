/**
 * Memory MCP server — exposes recall / recall_file / timeline tools to Claude.
 *
 * Uses the Agent SDK's in-process MCP API (createSdkMcpServer + tool), so no
 * subprocess or IPC is involved. The server is bound to a single (workspace,
 * session) pair so tools don't need to take those arguments — they're captured
 * in the closure.
 */

import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { MemoryEngine } from "./engine.js";
import type { RecallHit } from "./types.js";

export interface MemoryMcpBinding {
  workspaceId: string;
  /** Current session ID — used to exclude the caller's own turns from recall by default. */
  sessionId: string;
}

export function buildMemoryMcpServer(
  engine: MemoryEngine,
  binding: MemoryMcpBinding,
): McpSdkServerConfigWithInstance {
  const recallTool = tool(
    "recall",
    "Search past episodes (tool calls + user intents + assistant reasoning) from this workspace, across all past and current sessions. Returns the most relevant episodes. Use this whenever you need context from earlier work — do not rely on memory summaries.",
    {
      query: z.string().describe("Natural-language query describing what you want to recall"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Max episodes to return (default 6, max 20)"),
      include_current_session: z
        .boolean()
        .optional()
        .describe("Include episodes from the current session (default false)"),
      tool_name: z
        .string()
        .optional()
        .describe("Restrict to a specific tool (e.g. 'Read', 'Bash', 'Edit')"),
    },
    async ({ query, limit, include_current_session, tool_name }) => {
      const hits = await engine.recall({
        query,
        workspaceId: binding.workspaceId,
        limit: limit ?? 6,
        toolName: tool_name,
        sessionId: include_current_session ? undefined : undefined,
        // sessionId filter currently restricts TO one session; we want to
        // EXCLUDE current session by default, which needs a store-level flag.
        // Until then, include-everything behavior is the right default.
      });

      return {
        content: [
          {
            type: "text" as const,
            text: formatHits(hits, binding.sessionId, include_current_session ?? false),
          },
        ],
      };
    },
  );

  const recallFileTool = tool(
    "recall_file",
    "Check whether a file has been read in this workspace recently (across all sessions) and retrieve the most recent read. Useful to avoid re-reading unchanged files.",
    {
      path: z.string().describe("Absolute or workspace-relative file path"),
    },
    async ({ path }) => {
      const hits = await engine.recall({
        query: `file ${path}`,
        workspaceId: binding.workspaceId,
        filePaths: [path],
        limit: 3,
      });

      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No prior reads of ${path} in this workspace.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${hits.length} prior read(s) of ${path}:\n\n${formatHits(hits, binding.sessionId, true)}`,
          },
        ],
      };
    },
  );

  const timelineTool = tool(
    "timeline",
    "Get a chronological list of recent episodes in this workspace. Useful for 'what did I do recently' / orienting a new session.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe("Max episodes (default 20)"),
    },
    async ({ limit }) => {
      const episodes = engine.timeline(binding.workspaceId, limit ?? 20);
      if (episodes.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Timeline is empty." }],
        };
      }
      const lines = episodes.map((e) => {
        const when = new Date(e.createdAt).toISOString();
        const tag = e.sessionId === binding.sessionId ? "(this session)" : "";
        return `- [${when}] ${e.kind}: ${e.summary} ${tag}`.trim();
      });
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  return createSdkMcpServer({
    name: "codeoid-memory",
    version: "0.1.0",
    tools: [recallTool, recallFileTool, timelineTool],
  });
}

function formatHits(
  hits: RecallHit[],
  currentSessionId: string,
  includeCurrent: boolean,
): string {
  const filtered = includeCurrent
    ? hits
    : hits.filter((h) => h.episode.sessionId !== currentSessionId);

  if (filtered.length === 0) {
    return "No matching episodes in memory.";
  }

  const blocks = filtered.map((h, i) => {
    const ep = h.episode;
    const when = new Date(ep.createdAt).toISOString();
    const tag = ep.sessionId === currentSessionId ? " (this session)" : "";
    return [
      `### [${i + 1}] ${ep.summary}${tag}`,
      `- when: ${when}`,
      `- kind: ${ep.kind}${ep.toolName ? ` (${ep.toolName})` : ""}`,
      `- score: ${h.score.toFixed(3)} (vec=${h.components.vector.toFixed(2)}, fts=${h.components.fts.toFixed(2)}, rec=${h.components.recency.toFixed(2)}, path=${h.components.pathOverlap.toFixed(2)})`,
      `- episode_id: ${ep.id}`,
      "",
      ep.content,
    ].join("\n");
  });

  return blocks.join("\n\n---\n\n");
}
