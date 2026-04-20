/**
 * Test-runner compression — the 80/20 token win for agentic coding.
 *
 * Test output is the worst token offender: hundreds of "✓ passing" lines
 * for every failure that actually matters. This rule keeps the summary +
 * all failures + surrounding context, drops passing line noise.
 *
 * Covers: bun test, vitest, jest, playwright, pytest, go test, cargo test,
 * rspec. We match on the command prefix, then apply a generic "drop lines
 * that look like 'pass'" heuristic + preserve summary + error blocks.
 */

import type { CompressionRule } from "../types.js";

const TEST_RE =
  /^(?:bun\s+test|pnpm\s+test|npm\s+test|yarn\s+test|npx\s+vitest|npx\s+jest|vitest|jest|playwright\s+test|pytest|python\s+-m\s+pytest|go\s+test|cargo\s+test|cargo\s+nextest|rspec|rake\s+test)\b/;

/** Patterns that identify a "passing" line we can drop. */
const PASS_LINE_RE =
  /^(?:\s*(?:[\u2713\u2714\u2705\u221a]|ok|PASS|PASSED|passed|✓|✔)\s)/;

/** Patterns that identify a failure / summary line we MUST keep. */
const FAIL_LINE_RE =
  /(?:FAIL|FAILED|failed|FAILURE|✗|✘|\u2718|✖|ERR|Error|error|AssertionError|Expected|expect|panic|TypeError|exception)/;
const SUMMARY_RE =
  /(?:test result|Ran \d+|Tests:|\d+\s+(?:passed|passing|failed|failing|pending|skipped)|\d+\s+tests?\s+(?:complete|passed|failed))/i;

export const testRunnerRule: CompressionRule = {
  name: "test-runner",
  description:
    "Strip passing-test noise from bun/jest/vitest/pytest/go test/cargo test output; preserve failures + summary lines.",
  match: (cmd) => TEST_RE.test(cmd.trim()),
  compress: (stdout, ctx) => {
    if (ctx.rawBytes < 2 * 1024) return null;

    const lines = stdout.split("\n");
    const out: string[] = [];
    let droppedPasses = 0;
    let keptFailures = 0;
    let inFailureBlock = false;
    let failureBlockRemaining = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Failure block mode: keep subsequent non-empty lines as context
      // (stack traces, expected/actual diffs) until we hit a blank.
      if (inFailureBlock) {
        out.push(line);
        if (line.trim().length === 0) {
          failureBlockRemaining -= 1;
          if (failureBlockRemaining <= 0) inFailureBlock = false;
        }
        continue;
      }

      // Ordering matters: check PASS before SUMMARY, because a passing line
      // like "✓ test 0 passed" would match the loose "\d+ passed" fragment
      // in SUMMARY_RE. PASS pattern requires the check/word at line start,
      // so real summary lines (which don't start with ✓) are safe.
      if (FAIL_LINE_RE.test(line)) {
        keptFailures += 1;
        inFailureBlock = true;
        failureBlockRemaining = 2; // keep until 2 blank lines
        out.push(line);
        continue;
      }

      if (PASS_LINE_RE.test(line)) {
        droppedPasses += 1;
        continue;
      }

      if (SUMMARY_RE.test(line)) {
        out.push(line);
        continue;
      }

      out.push(line);
    }

    // If we didn't drop anything meaningful, bail.
    if (droppedPasses === 0 && keptFailures === 0) return null;

    // Collapse runs of 3+ blank lines into one.
    const collapsed = out.join("\n").replace(/\n{3,}/g, "\n\n");
    if (collapsed.length >= stdout.length - 200) return null;

    return {
      compressed: collapsed,
      originalBytes: ctx.rawBytes,
      ruleName: "test-runner",
      hint: `[codeoid: test-runner compressed — dropped ${droppedPasses} passing lines, kept ${keptFailures} failure marker(s)]`,
    };
  },
};
