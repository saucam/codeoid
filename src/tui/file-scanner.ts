/**
 * Workspace file scanner — produces a fuzzy-searchable list of files relative
 * to a session's workdir. Cached per-workdir; explicit invalidate on request.
 *
 * We intentionally limit the scan:
 *   - Hard cap of 5000 files per workdir (pathological cases truncate)
 *   - Skip node_modules, .git, dist, build, .next, target
 *   - Skip anything starting with `.` at any depth (dotfiles + dotdirs), except
 *     for a few allowed ones (`.claude`, `.env.example`)
 *   - Stop descending if `.gitignore` exists — we don't parse it, but the above
 *     skip list covers 95% of what a gitignore would hide
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MAX_FILES = 5000;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  ".turbo",
  ".venv",
  "__pycache__",
  ".cache",
  "coverage",
  ".pnpm",
  "out",
]);

const ALLOW_DOTDIRS = new Set([".claude", ".vscode"]);

/** In-memory cache. Key = workdir. */
const cache = new Map<string, { files: string[]; loadedAt: number }>();
const CACHE_TTL_MS = 30_000;

export function scanWorkspaceFiles(workdir: string, force = false): string[] {
  const hit = cache.get(workdir);
  if (!force && hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) {
    return hit.files;
  }

  const files: string[] = [];
  const stack: string[] = [workdir];

  while (stack.length > 0 && files.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.startsWith(".") && !ALLOW_DOTDIRS.has(entry)) continue;
      if (SKIP_DIRS.has(entry)) continue;
      const abs = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(abs);
      } else if (st.isFile()) {
        files.push(relative(workdir, abs));
      }
    }
  }

  files.sort();
  cache.set(workdir, { files, loadedAt: Date.now() });
  return files;
}

/**
 * Fuzzy-match the scan results against a query. Returns a ranked prefix-
 * weighted list. Not a full fuzzy — just substring + basename-priority —
 * but fast and good enough for TUI autocomplete.
 */
export function fuzzyMatch(files: readonly string[], query: string, limit = 20): string[] {
  if (!query) return files.slice(0, limit);
  const q = query.toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];
  for (const f of files) {
    const lf = f.toLowerCase();
    if (!lf.includes(q)) continue;
    // Favor: matches in basename > prefix matches > later matches.
    const basename = lf.split("/").pop() ?? lf;
    let score = 0;
    if (basename.startsWith(q)) score = 1000 - f.length;
    else if (basename.includes(q)) score = 800 - f.length;
    else if (lf.startsWith(q)) score = 600 - f.length;
    else score = 400 - lf.indexOf(q);
    scored.push({ path: f, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.path);
}
