/**
 * Subagent loading for ambient pack activation (docs/pack-loading.md). A pack's
 * registry ships Claude-Code-style subagent markdown files (a `--- frontmatter
 * ---` block with `name`/`description`/optional `tools`/`model`, then the system
 * prompt as the body). These are parsed into a provider-neutral `PackSubagent`
 * and passed to the Claude backend via the SDK's programmatic `agents` option —
 * symlinking `~/.claude/agents` does NOT work because the provider runs with
 * `settingSources: ["project"]`, which excludes the user tier.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PackSubagent {
  name: string;
  description: string;
  /** System prompt (the markdown body). */
  prompt: string;
  /** Optional tool allow-list for the subagent. */
  tools?: string[];
  model?: string;
}

/** Cap on a single subagent file — these are small; the bound stops a hostile
 *  agents file from OOMing the daemon. */
const MAX_SUBAGENT_BYTES = 512_000;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseTools(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") {
    const list = v.split(",").map((s) => s.trim()).filter(Boolean);
    return list.length ? list : undefined;
  }
  return undefined;
}

/** Parse one Claude-Code subagent markdown file. Returns undefined if it isn't a
 *  well-formed subagent (missing frontmatter / name / description). */
export function parseSubagentFile(path: string): PackSubagent | undefined {
  let text: string;
  try {
    if (statSync(path).size > MAX_SUBAGENT_BYTES) return undefined;
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const m = FRONTMATTER.exec(text);
  if (!m) return undefined;
  let fm: Record<string, unknown>;
  try {
    fm = (Bun.YAML.parse(m[1] ?? "") ?? {}) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!fm || typeof fm !== "object") return undefined;
  const name = typeof fm.name === "string" ? fm.name : undefined;
  const description = typeof fm.description === "string" ? fm.description : undefined;
  if (!name || !description) return undefined;
  const prompt = (m[2] ?? "").trim();
  if (!prompt) return undefined;
  const tools = parseTools(fm.tools);
  const model = typeof fm.model === "string" ? fm.model : undefined;
  return { name, description, prompt, ...(tools ? { tools } : {}), ...(model ? { model } : {}) };
}

/** Load every subagent from a directory of `*.md` files (best-effort per file;
 *  a malformed file is skipped, not fatal). */
export function loadSubagents(dir: string): PackSubagent[] {
  if (!existsSync(dir)) return [];
  const out: PackSubagent[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const sub = parseSubagentFile(join(dir, entry));
    if (sub) out.push(sub);
  }
  return out;
}
