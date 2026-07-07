/**
 * Fleet MCP server — the conductor's read-only view of the session fleet
 * (design §3, build plan P3). Injected ONLY into the `role:"conductor"`
 * session; normal sessions never see these tools.
 *
 * Read-only by construction: every tool observes (list / find / summarize /
 * recall / map) and none can act in a target session — dispatch (send-class)
 * arrives in P4 behind the confirm flow. Summaries come from the memory
 * engine's episode digests, never raw scrollback, so the conductor's context
 * stays O(active threads) (design §2).
 *
 * Provider-agnostic core: this module only builds tool handlers + an SDK MCP
 * server object. Which provider surfaces MCP tools is the provider's concern
 * (only the Claude provider supports MCP today).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { MemoryEngine } from "./memory/index.js";

const execFileAsync = promisify(execFile);

/** What the conductor is allowed to know about a session — metadata only. */
export interface FleetSessionView {
  id: string;
  name: string;
  workdir: string;
  workspaceId: string;
  status: string;
  role?: "conductor";
  providerId: string;
  model?: string;
  attachedClients: number;
  createdAt: string;
}

export interface FleetDeps {
  /** Tenant-scoped session snapshot (the manager closes over auth). */
  listSessions(): FleetSessionView[];
  /** Memory engine — powers fleet_find / fleet_summary / fleet_recall. */
  memory?: MemoryEngine;
  /** Audit sink — every fleet tool call lands in the audit log under the conductor's identity. */
  audit(action: string, detail: string): void;
  /** The conductor's own session id (excluded from find results). */
  conductorSessionId(): string;
}

/** Tool names as they appear to the provider allowlist (server key `codeoid_fleet`). */
export const FLEET_TOOL_NAMES = [
  "fleet_list",
  "fleet_find",
  "fleet_summary",
  "fleet_recall",
  "machine_map",
] as const;

/**
 * System-prompt append for the conductor session. Kept beside the fleet
 * tools because they define the conductor's whole contract.
 */
export const CONDUCTOR_SYSTEM_PROMPT_APPEND = `You are the codeoid CONDUCTOR — the owner's fleet supervisor, not a coding agent.

Your job is to ROUTE and OBSERVE, never to do the work yourself:
- Use fleet_list / machine_map to see what sessions exist and where.
- Use fleet_find to resolve "which session was X?" questions across all workspaces.
- Use fleet_summary for a compressed digest of one session; use fleet_recall to pull specific past context.
- You have NO tools to edit files, run commands, or act inside any session. In this phase you are read-only over the fleet; directing sessions arrives later.
- Never dump raw transcripts or long tool output into your replies. Answer with compact, source-attributed summaries (session name + what/when).
- When the owner references past work ("the authz fix", "that session about X"), resolve it with fleet_find first and confirm which session you mean.`;

const MAX_LIMIT = 20;
/** Per-repo git probe budget — machine_map must never hang the turn. */
const GIT_PROBE_TIMEOUT_MS = 2_000;

function ago(iso: string | number): string {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function sessionLine(s: FleetSessionView): string {
  const marker = s.role === "conductor" ? " [conductor — you]" : "";
  const model = s.model ? ` model=${s.model}` : "";
  return `- ${s.name} (${s.id.slice(0, 8)})${marker} — ${s.status}, ${s.attachedClients} client(s), provider=${s.providerId}${model}, workdir=${s.workdir}, created ${ago(s.createdAt)}`;
}

/** Resolve a user-supplied session reference (name or id/prefix) to a view. */
function resolveSession(
  sessions: FleetSessionView[],
  ref: string,
): FleetSessionView | undefined {
  return (
    sessions.find((s) => s.id === ref) ??
    sessions.find((s) => s.name === ref) ??
    sessions.find((s) => s.id.startsWith(ref))
  );
}

/**
 * Handler implementations, exposed separately from the SDK wiring so unit
 * tests can call them without an MCP transport. Each returns the tool's
 * text payload.
 */
export function createFleetHandlers(deps: FleetDeps) {
  return {
    async fleet_list(): Promise<string> {
      const sessions = deps.listSessions();
      deps.audit("fleet.list", `sessions=${sessions.length}`);
      if (sessions.length === 0) return "No sessions in the fleet.";
      // Group by workdir so the fleet reads as a machine map, not a flat list.
      const byWorkdir = new Map<string, FleetSessionView[]>();
      for (const s of sessions) {
        const group = byWorkdir.get(s.workdir) ?? [];
        group.push(s);
        byWorkdir.set(s.workdir, group);
      }
      const blocks: string[] = [];
      for (const [workdir, group] of byWorkdir) {
        blocks.push(`${workdir}:\n${group.map(sessionLine).join("\n")}`);
      }
      return `${sessions.length} session(s) across ${byWorkdir.size} workspace(s):\n\n${blocks.join("\n\n")}`;
    },

    async fleet_find(args: { query: string; limit?: number }): Promise<string> {
      deps.audit("fleet.find", `query=${args.query.slice(0, 200)}`);
      if (!deps.memory) {
        return "Memory is disabled on this daemon — fleet_find needs the memory engine. Use fleet_list instead.";
      }
      const sessions = deps.listSessions();
      const sessionNames = new Map(sessions.map((s) => [s.id, s.name]));
      const conductorId = deps.conductorSessionId();
      const hits = (
        await deps.memory.searchSessions({
          query: args.query,
          // workspaceId absent = cross-workspace global resolution (P1).
          limit: Math.min(args.limit ?? 5, MAX_LIMIT) + 1,
          sessionNames,
        })
      ).filter((h) => h.sessionId !== conductorId);
      if (hits.length === 0) {
        return `No session matched "${args.query}". It may predate memory, or try different terms.`;
      }
      const lines = hits.slice(0, Math.min(args.limit ?? 5, MAX_LIMIT)).map((h, i) => {
        const name = sessionNames.get(h.sessionId) ?? "(no longer running)";
        const evidence = h.snippets
          .slice(0, 2)
          .map((sn) => `    · [${sn.kind}] ${sn.summary}`)
          .join("\n");
        return `${i + 1}. ${name} (${h.sessionId.slice(0, 8)}) — ${h.matchCount} match(es), last activity ${ago(h.lastMatchAt)}\n${evidence}`;
      });
      return `Top session(s) for "${args.query}":\n${lines.join("\n")}`;
    },

    async fleet_summary(args: { session: string }): Promise<string> {
      const sessions = deps.listSessions();
      const target = resolveSession(sessions, args.session);
      deps.audit("fleet.summary", `session=${args.session.slice(0, 100)} resolved=${target?.id ?? "none"}`);
      if (!target) {
        return `No session matches "${args.session}". Use fleet_list to see the fleet.`;
      }
      const head = sessionLine(target);
      if (!deps.memory) return `${head}\n(no memory engine — activity digest unavailable)`;
      // Compressed digest: the session's recent episode SUMMARIES (one line
      // each), never raw scrollback/transcript — the never-OOC guarantee.
      const episodes = deps.memory
        .timeline(target.workspaceId, 60)
        .filter((e) => e.sessionId === target.id)
        .slice(0, 12);
      if (episodes.length === 0) return `${head}\n(no recorded activity yet)`;
      const lines = episodes.map(
        (e) => `- [${new Date(e.createdAt).toISOString()}] ${e.kind}${e.toolName ? `/${e.toolName}` : ""}: ${e.summary}`,
      );
      return `${head}\n\nRecent activity (${episodes.length} episode(s), newest first):\n${lines.join("\n")}`;
    },

    async fleet_recall(args: { query: string; limit?: number }): Promise<string> {
      deps.audit("fleet.recall", `query=${args.query.slice(0, 200)}`);
      if (!deps.memory) {
        return "Memory is disabled on this daemon — fleet_recall needs the memory engine.";
      }
      const sessionNames = new Map(deps.listSessions().map((s) => [s.id, s.name]));
      const hits = await deps.memory.recallGlobal({
        query: args.query,
        limit: Math.min(args.limit ?? 6, MAX_LIMIT),
      });
      if (hits.length === 0) return `Nothing recalled for "${args.query}".`;
      const lines = hits.map((h) => {
        const e = h.episode;
        const name = sessionNames.get(e.sessionId) ?? e.sessionId.slice(0, 8);
        return `- [${name}] ${e.kind}${e.toolName ? `/${e.toolName}` : ""}: ${e.summary}`;
      });
      return `Recalled ${hits.length} episode(s) across the fleet:\n${lines.join("\n")}`;
    },

    async machine_map(): Promise<string> {
      const sessions = deps.listSessions();
      deps.audit("fleet.machine_map", `workspaces=${new Set(sessions.map((s) => s.workdir)).size}`);
      if (sessions.length === 0) return "No sessions — the machine map is empty.";
      const byWorkdir = new Map<string, FleetSessionView[]>();
      for (const s of sessions) {
        const group = byWorkdir.get(s.workdir) ?? [];
        group.push(s);
        byWorkdir.set(s.workdir, group);
      }
      const blocks = await Promise.all(
        [...byWorkdir.entries()].map(async ([workdir, group]) => {
          const git = await probeGit(workdir);
          const members = group
            .map((s) => `${s.name} (${s.status}${s.role === "conductor" ? ", conductor" : ""})`)
            .join(", ");
          return `${workdir}\n  git: ${git}\n  sessions: ${members}`;
        }),
      );
      return `Machine map — ${byWorkdir.size} workspace(s):\n\n${blocks.join("\n\n")}`;
    },
  };
}

/** Branch + dirty state for a workdir; degrades to "not a git repo" fast. */
async function probeGit(workdir: string): Promise<string> {
  try {
    const { stdout: branch } = await execFileAsync(
      "git",
      ["-C", workdir, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: GIT_PROBE_TIMEOUT_MS },
    );
    const { stdout: status } = await execFileAsync(
      "git",
      ["-C", workdir, "status", "--porcelain"],
      { timeout: GIT_PROBE_TIMEOUT_MS },
    );
    const dirty = status.trim().length > 0 ? "dirty" : "clean";
    return `${branch.trim()} (${dirty})`;
  } catch {
    return "not a git repo";
  }
}

export function buildFleetMcpServer(deps: FleetDeps): McpSdkServerConfigWithInstance {
  const handlers = createFleetHandlers(deps);
  const text = (payload: string) => ({
    content: [{ type: "text" as const, text: payload }],
  });

  return createSdkMcpServer({
    name: "codeoid-fleet",
    version: "0.1.0",
    tools: [
      tool(
        "fleet_list",
        "List every session in the fleet, grouped by workspace — names, status, provider, attached clients. Your view of what exists right now.",
        {},
        async () => text(await handlers.fleet_list()),
      ),
      tool(
        "fleet_find",
        "Resolve a natural-language reference to the right session(s) across ALL workspaces — 'the authz fix', 'that session about migrations'. Returns ranked sessions with evidence snippets. Use this FIRST whenever the owner references past work.",
        {
          query: z.string().describe("Natural-language description of the work/session to find"),
          limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Max sessions to return (default 5)"),
        },
        async ({ query, limit }) => text(await handlers.fleet_find({ query, limit })),
      ),
      tool(
        "fleet_summary",
        "Compressed digest of ONE session: metadata plus its recent activity as one-line episode summaries. Never returns raw transcript.",
        {
          session: z.string().describe("Session name, id, or id prefix"),
        },
        async ({ session }) => text(await handlers.fleet_summary({ session })),
      ),
      tool(
        "fleet_recall",
        "Recall specific past context across the WHOLE fleet (every workspace, every session) — returns the most relevant episode summaries.",
        {
          query: z.string().describe("What to recall"),
          limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Max episodes (default 6)"),
        },
        async ({ query, limit }) => text(await handlers.fleet_recall({ query, limit })),
      ),
      tool(
        "machine_map",
        "Map of the machine: each workspace directory with its git branch/dirty state and which sessions live there.",
        {},
        async () => text(await handlers.machine_map()),
      ),
    ],
  });
}
