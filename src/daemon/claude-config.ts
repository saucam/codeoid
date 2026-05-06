/**
 * Claude Code configuration introspection.
 *
 * Walks `~/.claude/` (global) and `<workdir>/.claude/` + `.claude.local/`
 * (workdir-scoped) and produces a structured snapshot of:
 *
 *   - agents       — `*.md` with frontmatter under `agents/`
 *   - skills       — `*.md` or `<dir>/SKILL.md` with frontmatter under `skills/`
 *   - mcpServers   — `mcpServers` block in `settings.json` / `settings.local.json`
 *   - hooks        — `hooks.{event}[].hooks[]` blocks in `settings.json` /
 *                    `settings.local.json`
 *
 * No filesystem watcher — callers fetch on demand. Parsing is graceful:
 * malformed frontmatter degrades to filename-derived `name`, no
 * `description`. Comment-style keys (`_comment`, leading `_`) are dropped.
 *
 * Pure helper, no daemon-internal state. Path semantics: returns absolute
 * paths so frontends can copy-and-open.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve `~` for this call. Reads `HOME` (or `USERPROFILE`) directly
 * because `os.homedir()` caches at process start and won't pick up
 * env overrides — annoying for testing.
 */
function homedir(): string {
  return process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
}

import type {
  ClaudeConfigAgent,
  ClaudeConfigHook,
  ClaudeConfigMcpServer,
  ClaudeConfigSkill,
  ClaudeConfigSnapshot,
  ClaudeConfigScope,
} from "../protocol/types.js";

// ---------- Public entrypoint ----------

export async function readClaudeConfig(workdir: string): Promise<ClaudeConfigSnapshot> {
  const home = homedir();
  const globalRoot = path.join(home, ".claude");
  const workRoots = [
    path.join(workdir, ".claude"),
    path.join(workdir, ".claude.local"),
  ];

  const agentsLists = await Promise.all([
    readAgentsDir(path.join(globalRoot, "agents"), "global"),
    ...workRoots.map((r) => readAgentsDir(path.join(r, "agents"), "workdir")),
  ]);

  const skillsLists = await Promise.all([
    readSkillsDir(path.join(globalRoot, "skills"), "global"),
    ...workRoots.map((r) => readSkillsDir(path.join(r, "skills"), "workdir")),
  ]);

  const settingsFiles: Array<{ path: string; scope: ClaudeConfigScope }> = [
    { path: path.join(globalRoot, "settings.json"), scope: "global" },
    { path: path.join(globalRoot, "settings.local.json"), scope: "global" },
    ...workRoots.flatMap((r) => [
      { path: path.join(r, "settings.json"), scope: "workdir" as const },
      { path: path.join(r, "settings.local.json"), scope: "workdir" as const },
    ]),
  ];
  const settingsLists = await Promise.all(
    settingsFiles.map((s) => readSettings(s.path, s.scope)),
  );

  const agents = dedupByPath(agentsLists.flat());
  const skills = dedupByPath(skillsLists.flat());
  const mcpServers = dedupBy(
    settingsLists.flatMap((s) => s.mcpServers),
    (m) => `${m.scope}:${m.name}`,
  );
  const hooks = settingsLists.flatMap((s) => s.hooks);

  return { agents, skills, mcpServers, hooks };
}

// ---------- Agents ----------

async function readAgentsDir(
  dir: string,
  scope: ClaudeConfigScope,
): Promise<ClaudeConfigAgent[]> {
  const entries = await safeReaddir(dir);
  const out: ClaudeConfigAgent[] = [];
  for (const ent of entries) {
    if (!ent.name.endsWith(".md")) continue;
    if (!ent.isFile() && !(await isFileFollowingSymlink(path.join(dir, ent.name)))) {
      continue;
    }
    const filePath = path.join(dir, ent.name);
    const content = await safeReadFile(filePath);
    if (content == null) continue;
    const fm = parseFrontmatter(content);
    const stem = ent.name.replace(/\.md$/i, "");
    const name = strField(fm, "name") ?? stem;
    const description = strField(fm, "description") ?? null;
    const tools = parseTools(fm["tools"]);
    out.push({
      name,
      description,
      path: filePath,
      scope,
      ...(tools.length > 0 ? { tools } : {}),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------- Skills ----------

async function readSkillsDir(
  dir: string,
  scope: ClaudeConfigScope,
): Promise<ClaudeConfigSkill[]> {
  const entries = await safeReaddir(dir);
  const out: ClaudeConfigSkill[] = [];
  for (const ent of entries) {
    const childPath = path.join(dir, ent.name);
    const targetIsFile =
      ent.isFile() ||
      (ent.isSymbolicLink() && (await isFileFollowingSymlink(childPath)));
    const targetIsDir =
      ent.isDirectory() ||
      (ent.isSymbolicLink() && (await isDirFollowingSymlink(childPath)));

    if (targetIsFile && ent.name.endsWith(".md")) {
      const content = await safeReadFile(childPath);
      if (content == null) continue;
      const fm = parseFrontmatter(content);
      const stem = ent.name.replace(/\.md$/i, "");
      out.push({
        name: strField(fm, "name") ?? stem,
        description: strField(fm, "description") ?? null,
        path: childPath,
        scope,
      });
      continue;
    }
    if (targetIsDir) {
      // skills/<dir>/SKILL.md is the convention. Fall back to the
      // first *.md if SKILL.md isn't present.
      const skillFile = await pickSkillFile(childPath);
      if (!skillFile) continue;
      const content = await safeReadFile(skillFile);
      if (content == null) continue;
      const fm = parseFrontmatter(content);
      out.push({
        name: strField(fm, "name") ?? ent.name,
        description: strField(fm, "description") ?? null,
        path: skillFile,
        scope,
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function pickSkillFile(dir: string): Promise<string | null> {
  const skillMd = path.join(dir, "SKILL.md");
  if (await exists(skillMd)) return skillMd;
  const entries = await safeReaddir(dir);
  for (const ent of entries) {
    if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
      return path.join(dir, ent.name);
    }
  }
  return null;
}

// ---------- Settings (mcpServers + hooks) ----------

async function readSettings(
  filePath: string,
  scope: ClaudeConfigScope,
): Promise<{ mcpServers: ClaudeConfigMcpServer[]; hooks: ClaudeConfigHook[] }> {
  const content = await safeReadFile(filePath);
  if (content == null) return { mcpServers: [], hooks: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { mcpServers: [], hooks: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { mcpServers: [], hooks: [] };
  }
  const obj = parsed as Record<string, unknown>;

  const mcpServers: ClaudeConfigMcpServer[] = [];
  const mcpRaw = obj["mcpServers"];
  if (mcpRaw && typeof mcpRaw === "object" && !Array.isArray(mcpRaw)) {
    for (const [name, def] of Object.entries(mcpRaw as Record<string, unknown>)) {
      if (name.startsWith("_")) continue;
      if (!def || typeof def !== "object") continue;
      const d = def as Record<string, unknown>;
      mcpServers.push({
        name,
        scope,
        path: filePath,
        command: typeof d["command"] === "string" ? (d["command"] as string) : null,
        args: Array.isArray(d["args"])
          ? (d["args"] as unknown[]).filter((x): x is string => typeof x === "string")
          : [],
        envKeys:
          d["env"] && typeof d["env"] === "object" && !Array.isArray(d["env"])
            ? Object.keys(d["env"] as Record<string, unknown>)
            : [],
        url: typeof d["url"] === "string" ? (d["url"] as string) : null,
        type: typeof d["type"] === "string" ? (d["type"] as string) : null,
      });
    }
  }

  const hooks: ClaudeConfigHook[] = [];
  const hooksRaw = obj["hooks"];
  if (hooksRaw && typeof hooksRaw === "object" && !Array.isArray(hooksRaw)) {
    for (const [event, defs] of Object.entries(hooksRaw as Record<string, unknown>)) {
      if (event.startsWith("_")) continue;
      if (!Array.isArray(defs)) continue;
      for (const def of defs as unknown[]) {
        if (!def || typeof def !== "object") continue;
        const d = def as Record<string, unknown>;
        const matcher = typeof d["matcher"] === "string" ? (d["matcher"] as string) : null;
        const inner = Array.isArray(d["hooks"]) ? (d["hooks"] as unknown[]) : [];
        for (const h of inner) {
          if (!h || typeof h !== "object") continue;
          const hh = h as Record<string, unknown>;
          if (typeof hh["command"] !== "string") continue;
          hooks.push({
            event,
            scope,
            path: filePath,
            matcher,
            kind: typeof hh["type"] === "string" ? (hh["type"] as string) : "command",
            command: hh["command"] as string,
          });
        }
      }
    }
  }

  return { mcpServers, hooks };
}

// ---------- Frontmatter parsing ----------

/**
 * Extract YAML frontmatter from a markdown document. Supports the
 * `---\n...\n---\n` opening-block convention. Returns a flat
 * `Record<string, unknown>` where each value is either a string, a
 * comma-list of strings (when the input was a comma-separated value),
 * or `null` for unrecognised shapes. We don't pull in a real YAML
 * parser — the slice that matters here is `name: ...` and
 * `description: ...`, both of which are scalar strings.
 */
export function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = text.slice(3, end).replace(/^\r?\n/, "");
  const out: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    if (line.length === 0 || line.trim().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip surrounding quotes.
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function strField(fm: Record<string, unknown>, key: string): string | null {
  const v = fm[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parseTools(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------- Filesystem helpers ----------

async function safeReaddir(dir: string): Promise<{ name: string; isFile(): boolean; isDirectory(): boolean }[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeReadFile(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isFileFollowingSymlink(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function isDirFollowingSymlink(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

// ---------- Dedup helpers ----------

function dedupBy<T>(items: T[], keyOf: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = keyOf(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function dedupByPath<T extends { path: string }>(items: T[]): T[] {
  return dedupBy(items, (it) => it.path);
}
