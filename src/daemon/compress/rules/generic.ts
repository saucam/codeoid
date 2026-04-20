/**
 * Generic fall-through rule — head+tail truncator for large outputs.
 *
 * This is the "catch-all" at the tail of the registry. More specific rules
 * (git, test runners, etc.) should come before it so they handle their
 * shape better. But even without a specific rule, a 10k-line dump gets
 * trimmed to head + tail with the middle replaced by a line count.
 *
 * Heuristic: kick in at ≥ 4 KB. Below that the output is cheap to keep raw.
 */

import type { CompressionRule } from "../types.js";

const HEAD_LINES = 30;
const TAIL_LINES = 20;
const MIN_BYTES = 4 * 1024;

export const genericTruncateRule: CompressionRule = {
  name: "generic-head-tail",
  description:
    "Last-resort truncator for any command whose output is >=4 KB; keeps the first " +
    `${HEAD_LINES} + last ${TAIL_LINES} lines with the middle replaced by a count.`,
  match: () => true, // always matches; lives at the tail of the registry
  compress: (stdout, ctx) => {
    const bytes = Buffer.byteLength(stdout, "utf8");
    if (bytes < MIN_BYTES) return null; // small enough, pass through

    const lines = stdout.split("\n");
    if (lines.length <= HEAD_LINES + TAIL_LINES) return null;

    const head = lines.slice(0, HEAD_LINES).join("\n");
    const tail = lines.slice(-TAIL_LINES).join("\n");
    const omitted = lines.length - HEAD_LINES - TAIL_LINES;
    const compressed = `${head}\n\n[… ${omitted} lines omitted — call recall for full output …]\n\n${tail}`;

    return {
      compressed,
      originalBytes: ctx.rawBytes,
      ruleName: "generic-head-tail",
    };
  },
};
