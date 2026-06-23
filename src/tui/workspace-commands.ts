/**
 * Workspace slash commands — loaded from `<workdir>/.claude/commands/*.md`,
 * the same format Claude Code reads. Each file becomes a `/name` command;
 * the file body is used as the prompt template.
 *
 * Claude Code semantics we preserve:
 *   - `$ARGUMENTS` in the body is replaced with whatever the user typed after
 *     the command name
 *   - Optional YAML frontmatter with `description:` populates the hint panel
 *
 * The return shape mirrors `SlashCommand` so App.tsx can merge workspace
 * commands and built-ins into one flat overlay list.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceCommand {
  name: string; // e.g. "/refactor"
  description: string;
  /** Raw body with frontmatter stripped. Contains `$ARGUMENTS` placeholder. */
  template: string;
  /** Absolute source path so we can display it in the hint. */
  sourcePath: string;
}

/** Load workspace commands from `<workdir>/.claude/commands/`. */
export function loadWorkspaceCommands(workdir: string): WorkspaceCommand[] {
  const dir = join(workdir, ".claude", "commands");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: WorkspaceCommand[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const abs = join(dir, entry);
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      const raw = readFileSync(abs, "utf8");
      const { frontmatter, body } = splitFrontmatter(raw);
      out.push({
        name: `/${entry.replace(/\.md$/, "")}`,
        description: frontmatter.description ?? `workspace command (${entry})`,
        template: body,
        sourcePath: abs,
      });
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Apply a workspace command template to the user's args. */
export function expandWorkspaceCommand(
  cmd: WorkspaceCommand,
  args: string,
): string {
  return cmd.template.replace(/\$ARGUMENTS\b/g, args);
}

function splitFrontmatter(raw: string): {
  frontmatter: { description?: string };
  body: string;
} {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { frontmatter: {}, body: raw };
  }
  const end = raw.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: raw };
  const fm = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const out: { description?: string } = {};
  for (const line of fm.split("\n")) {
    const match = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, value] = match;
    if (key === "description") out.description = value!.replace(/^["']|["']$/g, "");
  }
  return { frontmatter: out, body };
}
