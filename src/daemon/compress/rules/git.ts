/**
 * Git-family compression rules.
 *
 * Shipped rules (priority order):
 *   - git-diff    collapse long unchanged context, drop binary diffs,
 *                 keep @@ hunk headers + added/removed lines intact.
 *   - git-status  trim when enormous (huge untracked lists); otherwise pass.
 *   - git-log     collapse repeated author/committer blocks; keep headers.
 *
 * All rules preserve the data Claude actually uses to reason: hunk headers,
 * file paths, added/removed lines, error messages. They drop noise:
 * unchanged context beyond the 3-line default, binary markers with full
 * "Binary files differ" blocks, long untracked-file dumps.
 */

import type { CompressionRule } from "../types.js";

// ── git diff ─────────────────────────────────────────────────────────────

/**
 * Matches `git diff`, `git show`, `git log -p`, and common aliases.
 * Intentionally loose — we'd rather grab a `git diff --name-only` run (which
 * is already small and our rule will pass through) than miss a real diff.
 */
const GIT_DIFF_RE = /^git\s+(?:diff|show|log\s+.*-p\b|log\s+-p\b|format-patch)\b/;

export const gitDiffRule: CompressionRule = {
  name: "git-diff",
  description:
    "Compress `git diff` / `git show` / `git log -p` output — drop binary diffs, collapse long unchanged blocks, preserve hunk headers.",
  match: (cmd) => GIT_DIFF_RE.test(cmd.trim()),
  compress: (stdout, ctx) => {
    // Small diffs pass through — preserving full context matters for review.
    if (ctx.rawBytes < 4 * 1024) return null;

    const lines = stdout.split("\n");
    const out: string[] = [];
    let droppedBinary = 0;
    let collapsedContext = 0;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;

      // Binary-file block: `diff --git a/foo.png b/foo.png` followed by
      //   Binary files a/foo.png and b/foo.png differ
      if (line.startsWith("diff --git") && i + 3 < lines.length) {
        const peek = lines[i + 3] ?? "";
        if (peek.startsWith("Binary files") || peek.includes("GIT binary patch")) {
          out.push(line + "  [binary diff elided]");
          droppedBinary += 1;
          // Skip forward until next `diff --git` or end.
          i += 1;
          while (i < lines.length && !lines[i]!.startsWith("diff --git")) i += 1;
          continue;
        }
      }

      // Context lines start with " " (single space). Collapse runs of 4+.
      if (line.startsWith(" ")) {
        let run = 0;
        const start = i;
        while (i < lines.length && lines[i]!.startsWith(" ")) {
          run += 1;
          i += 1;
        }
        if (run >= 4) {
          // Keep first 2 + last 1 of the context run, drop the middle.
          out.push(lines[start]!);
          out.push(lines[start + 1]!);
          out.push(`… ${run - 3} unchanged lines …`);
          out.push(lines[start + run - 1]!);
          collapsedContext += run - 3;
        } else {
          for (let k = 0; k < run; k++) out.push(lines[start + k]!);
        }
        continue;
      }

      out.push(line);
      i += 1;
    }

    const compressed = out.join("\n");
    // Fallthrough: if our output isn't meaningfully smaller, bail.
    if (compressed.length >= stdout.length - 200) return null;

    const summary =
      (droppedBinary > 0 ? `${droppedBinary} binary diff(s) elided; ` : "") +
      (collapsedContext > 0 ? `${collapsedContext} unchanged context lines collapsed` : "");

    return {
      compressed,
      originalBytes: ctx.rawBytes,
      ruleName: "git-diff",
      hint: `[codeoid: git-diff compression — ${summary}; call recall for the full diff]`,
    };
  },
};

// ── git status ───────────────────────────────────────────────────────────

const GIT_STATUS_RE = /^git\s+status\b/;

export const gitStatusRule: CompressionRule = {
  name: "git-status",
  description:
    "Trim massive `git status` outputs (lots of untracked files). Small statuses pass through.",
  match: (cmd) => GIT_STATUS_RE.test(cmd.trim()),
  compress: (stdout, ctx) => {
    if (ctx.rawBytes < 4 * 1024) return null;

    const lines = stdout.split("\n");
    // Keep summary + modified/staged sections, truncate "Untracked files"
    // list which is often the offender.
    const untrackedIdx = lines.findIndex((l) => l.startsWith("Untracked files"));
    if (untrackedIdx === -1) return null;

    const kept = lines.slice(0, untrackedIdx + 2); // include header + blank
    const untrackedLines = lines.slice(untrackedIdx + 2);
    // Keep first 10 untracked entries + count.
    const shown = untrackedLines.slice(0, 10);
    const remainingCount = Math.max(0, untrackedLines.length - 10 - 1); // drop trailing blank
    const tail = remainingCount > 0
      ? [`\t… ${remainingCount} more untracked files omitted …`]
      : [];

    const compressed = [...kept, ...shown, ...tail].join("\n");
    if (compressed.length >= stdout.length - 200) return null;

    return {
      compressed,
      originalBytes: ctx.rawBytes,
      ruleName: "git-status",
      hint: `[codeoid: git-status compressed — ${remainingCount} untracked files elided]`,
    };
  },
};

// ── git log (no -p) ──────────────────────────────────────────────────────

const GIT_LOG_RE = /^git\s+log\b(?!.*(?:\s-p\b|\s--patch\b))/;

export const gitLogRule: CompressionRule = {
  name: "git-log",
  description:
    "Compress plain `git log` by collapsing repeated author blocks; keeps commit headers intact.",
  match: (cmd) => GIT_LOG_RE.test(cmd.trim()),
  compress: (stdout, ctx) => {
    if (ctx.rawBytes < 4 * 1024) return null;

    // For long logs, keep the first 20 and last 10 commits.
    const commitBlocks = splitByCommit(stdout);
    if (commitBlocks.length <= 30) return null;

    const head = commitBlocks.slice(0, 20).join("\n");
    const tail = commitBlocks.slice(-10).join("\n");
    const elided = commitBlocks.length - 30;
    const compressed = `${head}\n\n[… ${elided} older commits elided — call recall for the full log …]\n\n${tail}`;
    if (compressed.length >= stdout.length - 200) return null;

    return {
      compressed,
      originalBytes: ctx.rawBytes,
      ruleName: "git-log",
      hint: `[codeoid: git-log compressed — ${elided} older commits elided]`,
    };
  },
};

function splitByCommit(s: string): string[] {
  // git log entries start with `commit <sha>` at column 0.
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of s.split("\n")) {
    if (/^commit [0-9a-f]{7,}/.test(line) && buf.length > 0) {
      out.push(buf.join("\n"));
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.length > 0) out.push(buf.join("\n"));
  return out;
}
