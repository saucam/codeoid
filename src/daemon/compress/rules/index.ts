/**
 * Built-in rule registry — ordered by specificity (specific first).
 *
 * Phase 2 ships just the generic head+tail fallback. Phase 3 adds
 * command-specific rules (git, test runners, search) that run BEFORE
 * the generic one.
 */

import type { CompressionRule } from "../types.js";
import { genericTruncateRule } from "./generic.js";
import { gitDiffRule, gitStatusRule, gitLogRule } from "./git.js";
import { lsRule, catRule, findTreeRule } from "./shell.js";
import { searchRule } from "./search.js";
import { testRunnerRule } from "./test-runners.js";

/**
 * Order matters — first match wins. Rules are listed from most specific to
 * most generic so a precise rule gets a shot before the catch-all truncator.
 */
export const BUILTIN_RULES: readonly CompressionRule[] = [
  // Git family (most specific shapes).
  gitDiffRule,
  gitStatusRule,
  gitLogRule,
  // Shell family.
  lsRule,
  catRule,
  findTreeRule,
  // Search family.
  searchRule,
  // Test runners — cover many commands; place late so command-specific rules
  // (e.g. `npm test` is explicitly handled here, not by a generic node rule).
  testRunnerRule,
  // Fallback.
  genericTruncateRule,
];

export {
  genericTruncateRule,
  gitDiffRule,
  gitStatusRule,
  gitLogRule,
  lsRule,
  catRule,
  findTreeRule,
  searchRule,
  testRunnerRule,
};
