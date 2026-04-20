/**
 * Search compression — grep, rg, ag output.
 *
 * Search results have two modes:
 *   (a) single-line matches: `path:line:text` — rarely very bloated, but
 *       can explode on poorly-targeted queries.
 *   (b) context mode: `grep -A 3 -B 3` — groups of lines around each hit.
 *
 * Strategy: when total lines exceed 80, group by file and keep the first N
 * hits per file + total count per file. Claude can re-query tighter if it
 * needs more.
 */

import type { CompressionRule } from "../types.js";

const SEARCH_RE = /^(?:grep|rg|ripgrep|ag|ack)\b/;

export const searchRule: CompressionRule = {
  name: "search",
  description:
    "Group grep/rg/ag hits by file when there are many matches; show top-5 per file with counts.",
  match: (cmd) => SEARCH_RE.test(cmd.trim()),
  compress: (stdout, ctx) => {
    if (ctx.rawBytes < 2 * 1024) return null;

    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < 80) return null;

    // Try to parse as `path:line:match`. If fewer than half parse cleanly,
    // skip — this is probably `grep -r` or context output we can't group.
    type Hit = { path: string; line: string; raw: string };
    const hits: Hit[] = [];
    let parsed = 0;
    for (const l of lines) {
      const m = /^([^:]+):(\d+):(.*)$/.exec(l);
      if (m) {
        hits.push({ path: m[1]!, line: m[2]!, raw: l });
        parsed += 1;
      } else {
        hits.push({ path: "?", line: "", raw: l });
      }
    }
    if (parsed < lines.length * 0.6) return null;

    const byFile = new Map<string, Hit[]>();
    for (const h of hits) {
      if (h.path === "?") continue;
      if (!byFile.has(h.path)) byFile.set(h.path, []);
      byFile.get(h.path)!.push(h);
    }

    const ordered = Array.from(byFile.entries()).sort(
      (a, b) => b[1].length - a[1].length,
    );

    const outBlocks: string[] = [];
    let shown = 0;
    for (const [path, fileHits] of ordered) {
      const head = fileHits.slice(0, 5).map((h) => h.raw).join("\n");
      const tail =
        fileHits.length > 5
          ? `\n  … ${fileHits.length - 5} more hits in ${path} …`
          : "";
      outBlocks.push(`${path}: ${fileHits.length} match(es)\n${head}${tail}`);
      shown += fileHits.length;
      if (shown > 200) break; // cap global size
    }

    const compressed = `${hits.length} matches across ${byFile.size} files:\n\n${outBlocks.join("\n\n")}`;
    if (compressed.length >= stdout.length - 200) return null;

    return {
      compressed,
      originalBytes: ctx.rawBytes,
      ruleName: "search",
      hint: `[codeoid: search compressed — ${hits.length} matches in ${byFile.size} files]`,
    };
  },
};
