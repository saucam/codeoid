/**
 * Shell-family compression rules — ls, cat, find, tree.
 *
 * Philosophy: drop signal-poor bulk, preserve navigational utility. A long
 * `ls` output is much less useful than "N files, grouped by extension, with
 * top-5 dirs". A 3000-line `cat` is rarely useful verbatim; head + footer
 * with "call recall" lets Claude make a decision without paying for it.
 */

import type { CompressionRule } from "../types.js";

// ── ls ───────────────────────────────────────────────────────────────────

const LS_RE = /^ls\b/;

export const lsRule: CompressionRule = {
  name: "ls",
  description:
    "Compress `ls` / `ls -la` output: under ~50 lines pass through; beyond, group by extension + show top-10 entries.",
  match: (cmd) => LS_RE.test(cmd.trim()),
  compress: (stdout, ctx) => {
    if (ctx.rawBytes < 2 * 1024) return null;

    const rawLines = stdout.split("\n").filter((l) => l.trim().length > 0);
    if (rawLines.length < 60) return null;

    // Parse: for `ls -l` output the first column is a permission string
    // starting with '-' or 'd' or 'l'. Plain `ls` = just names.
    const isLongFormat = rawLines.some((l) =>
      /^[-dlbcps][-rwxstST]{9}/.test(l),
    );

    const names = isLongFormat
      ? rawLines
          .filter((l) => !l.startsWith("total "))
          .map((l) => l.split(/\s+/).slice(8).join(" "))
      : rawLines;

    // Group by extension.
    const byExt = new Map<string, number>();
    for (const n of names) {
      const m = /\.([A-Za-z0-9]+)$/.exec(n);
      const ext = m ? m[1]!.toLowerCase() : "(none)";
      byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
    }

    const extSummary = Array.from(byExt.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([ext, n]) => `  .${ext}: ${n}`)
      .join("\n");

    const preview = rawLines.slice(0, 10).join("\n");
    const compressed =
      `${names.length} entries (ls output). Extensions:\n${extSummary}\n\nFirst 10:\n${preview}`;
    if (compressed.length >= stdout.length - 200) return null;

    return {
      compressed,
      originalBytes: ctx.rawBytes,
      ruleName: "ls",
      hint: `[codeoid: ls compressed — ${names.length} entries grouped by extension]`,
    };
  },
};

// ── cat ──────────────────────────────────────────────────────────────────

const CAT_RE = /^(?:cat|bat|less|more)\s+/;

export const catRule: CompressionRule = {
  name: "cat",
  description:
    "Head+tail truncate `cat`/`less`/`bat`/`more` output over 200 lines. Claude can call Read tool for full contents.",
  match: (cmd) => CAT_RE.test(cmd.trim()),
  compress: (stdout, ctx) => {
    if (ctx.rawBytes < 4 * 1024) return null;

    const lines = stdout.split("\n");
    if (lines.length < 200) return null;

    const head = lines.slice(0, 80).join("\n");
    const tail = lines.slice(-40).join("\n");
    const omitted = lines.length - 120;
    const compressed =
      `${head}\n\n[… ${omitted} lines omitted — use the Read tool on the file for full contents …]\n\n${tail}`;
    if (compressed.length >= stdout.length - 200) return null;

    return {
      compressed,
      originalBytes: ctx.rawBytes,
      ruleName: "cat",
      hint: `[codeoid: cat compressed — ${omitted} middle lines elided; Read tool has the full file]`,
    };
  },
};

// ── find / tree ──────────────────────────────────────────────────────────

const FIND_TREE_RE = /^(?:find|tree|fd)\b/;

export const findTreeRule: CompressionRule = {
  name: "find-tree",
  description:
    "Group `find` / `tree` / `fd` results by parent directory; keep tree of dirs + top-level file counts.",
  match: (cmd) => FIND_TREE_RE.test(cmd.trim()),
  compress: (stdout, ctx) => {
    if (ctx.rawBytes < 2 * 1024) return null;

    const paths = stdout.split("\n").filter((l) => l.trim().length > 0);
    if (paths.length < 60) return null;

    const byParent = new Map<string, number>();
    for (const p of paths) {
      const idx = p.lastIndexOf("/");
      const parent = idx === -1 ? "." : p.slice(0, idx);
      byParent.set(parent, (byParent.get(parent) ?? 0) + 1);
    }

    const rows = Array.from(byParent.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([dir, n]) => `  ${dir}/ — ${n} entries`)
      .join("\n");

    const compressed =
      `${paths.length} paths from ${byParent.size} directories. Top 25 by count:\n${rows}`;
    if (compressed.length >= stdout.length - 200) return null;

    return {
      compressed,
      originalBytes: ctx.rawBytes,
      ruleName: "find-tree",
      hint: `[codeoid: find/tree compressed — ${paths.length} paths across ${byParent.size} dirs]`,
    };
  },
};
