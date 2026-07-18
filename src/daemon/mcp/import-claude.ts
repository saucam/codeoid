/**
 * Importer — fold Claude Code's `~/.claude.json` GLOBAL `mcpServers` into the
 * codeoid registry so servers a user already configured for Claude become
 * available on EVERY backend (S5 of docs/provider-mcp-registry-design.md).
 *
 * Scope: only the top-level (global) `mcpServers` block is imported — it's
 * daemon-wide, matching the registry's shape. Per-project servers
 * (`projects[workdir].mcpServers`) stay claude-only for now: they're
 * workdir-scoped and don't fit a daemon-wide registry (documented limitation).
 *
 * Config `mcpServers` WINS on a name collision (an explicit codeoid entry
 * overrides an imported one). Imported servers default to `trust: prompt` — a
 * user's arbitrary Claude server is not assumed read-only.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RawMcpServerConfig } from "../../config.js";

/** Best-effort read of the global `mcpServers` from `~/.claude.json`, mapped to
 *  registry `RawMcpServerConfig`s. Never throws — a missing/malformed file, or
 *  an entry that is neither stdio nor http, is simply skipped. */
export function importClaudeMcpServers(
  home: string = homedir(),
): Record<string, RawMcpServerConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const raw = (parsed as Record<string, unknown>).mcpServers;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};

  const out: Record<string, RawMcpServerConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const spec = mapEntry(value);
    if (spec) out[name] = spec;
  }
  return out;
}

/** Map one `~/.claude.json` server entry (stdio `{command,args,env}` or http
 *  `{url,headers}`) to a registry `RawMcpServerConfig` with codeoid defaults. */
function mapEntry(value: unknown): RawMcpServerConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const base = {
    args: [] as string[],
    env: {} as Record<string, string>,
    headers: {} as Record<string, string>,
    trust: "prompt" as const,
    scope: "workspace" as const,
    enabled: true,
    native: false,
  };
  if (typeof v.command === "string") {
    return {
      ...base,
      command: v.command,
      args: stringArray(v.args) ?? [],
      env: stringRecord(v.env) ?? {},
    } as RawMcpServerConfig;
  }
  if (typeof v.url === "string") {
    return { ...base, url: v.url, headers: stringRecord(v.headers) ?? {} } as RawMcpServerConfig;
  }
  return null; // neither stdio nor http → skip
}

function stringArray(x: unknown): string[] | null {
  return Array.isArray(x) && x.every((e) => typeof e === "string") ? (x as string[]) : null;
}

function stringRecord(x: unknown): Record<string, string> | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  // Coerce primitives (a user's ~/.claude.json env may hold numbers/booleans);
  // a single non-string value must not discard the whole block. Non-primitive
  // values (objects/arrays/null) are skipped — env/header values are scalars.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}
