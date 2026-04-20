/**
 * Minimal unified-diff renderer for Edit/Write tool calls.
 *
 * Input → `old_string` + `new_string` (the Edit-tool primitive).
 * Output → a sequence of `DiffRow`s tagged "context" | "added" | "removed".
 *
 * We align the two strings with LCS and emit a hunk-style diff. For very
 * large inputs we truncate to keep the Ink render cheap; the full content
 * stays accessible via memory recall.
 */

export interface DiffRow {
  kind: "context" | "added" | "removed";
  text: string;
}

const MAX_LINES = 80;

/** Produce a line-granular diff. */
export function computeDiff(oldStr: string, newStr: string): DiffRow[] {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  if (a.length === 1 && b.length === 1 && a[0] === "" && b[0] === "") return [];

  // Standard LCS DP.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  // Walk back.
  const rows: DiffRow[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      rows.push({ kind: "context", text: a[i - 1]! });
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      rows.push({ kind: "removed", text: a[i - 1]! });
      i--;
    } else {
      rows.push({ kind: "added", text: b[j - 1]! });
      j--;
    }
  }
  while (i > 0) {
    rows.push({ kind: "removed", text: a[--i]! });
  }
  while (j > 0) {
    rows.push({ kind: "added", text: b[--j]! });
  }

  rows.reverse();

  if (rows.length <= MAX_LINES) return rows;
  const head = rows.slice(0, Math.floor(MAX_LINES * 0.7));
  const tail = rows.slice(-Math.floor(MAX_LINES * 0.3));
  const omitted = rows.length - head.length - tail.length;
  return [
    ...head,
    { kind: "context", text: `… ${omitted} more rows …` },
    ...tail,
  ];
}

/** Head+tail truncation of a long tool output (Bash stdout, Read contents). */
export function truncateToolOutput(
  text: string,
  headLines = 8,
  tailLines = 2,
): string {
  if (!text) return text;
  const lines = text.split("\n");
  if (lines.length <= headLines + tailLines + 1) return text;
  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);
  const omitted = lines.length - headLines - tailLines;
  return [...head, `… ${omitted} more lines …`, ...tail].join("\n");
}
