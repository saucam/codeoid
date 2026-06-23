/**
 * Rule registry — maintains the ordered list of compression rules and
 * applies the first matching one to a given command.
 *
 * Order matters: specific rules (e.g. `git-diff`) MUST come before generic
 * ones (e.g. `git-*`) so the specific rule wins. The registry is static at
 * process start — no hot-swap, no async loading. Deterministic.
 */

import type {
  CompressionContext,
  CompressionResult,
  CompressionRule,
} from "./types.js";

export interface RegistryOptions {
  /** Rules in priority order (first match wins). */
  rules: readonly CompressionRule[];
  /** Rule names disabled by user config. Takes precedence over matches. */
  disabledRules?: readonly string[];
  /** Command substrings that bypass compression entirely. */
  excludeCommands?: readonly string[];
  /** Full-command regexes that bypass compression. */
  excludePatterns?: readonly RegExp[];
}

export class CompressionRegistry {
  readonly rules: readonly CompressionRule[];
  readonly #disabled: Set<string>;
  readonly #excludeCommands: readonly string[];
  readonly #excludePatterns: readonly RegExp[];

  constructor(opts: RegistryOptions) {
    this.rules = opts.rules;
    this.#disabled = new Set(opts.disabledRules ?? []);
    this.#excludeCommands = opts.excludeCommands ?? [];
    this.#excludePatterns = opts.excludePatterns ?? [];
  }

  /**
   * Is the command eligible for compression at all? Two reasons to bypass:
   * (a) user-configured exclusion (substring or regex),
   * (b) no rule matches this command.
   */
  shouldCompress(command: string): boolean {
    if (this.isExcluded(command)) return false;
    return this.matchFirst(command) !== null;
  }

  /** Check user-level exclusion — does not consult the rule list. */
  isExcluded(command: string): boolean {
    const head = extractLeadingTokens(command, 2).join(" ");
    for (const ex of this.#excludeCommands) {
      if (head === ex || head.startsWith(`${ex} `)) return true;
    }
    for (const re of this.#excludePatterns) {
      if (re.test(command)) return true;
    }
    return false;
  }

  /** First matching (non-disabled) rule, or null. */
  matchFirst(command: string): CompressionRule | null {
    for (const r of this.rules) {
      if (this.#disabled.has(r.name)) continue;
      if (r.match(command)) return r;
    }
    return null;
  }

  /**
   * Apply the first matching rule. Returns null when the command is
   * excluded, no rule matches, or the rule explicitly opted out.
   */
  apply(
    command: string,
    stdout: string,
    ctx: CompressionContext,
  ): CompressionResult | null {
    if (this.isExcluded(command)) return null;
    const rule = this.matchFirst(command);
    if (!rule) return null;
    try {
      return rule.compress(stdout, ctx);
    } catch (err) {
      // Never throw out of compression — a bad rule must not drop stdout.
      console.error(
        `[codeoid/compress] rule ${rule.name} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}

/**
 * Extract the first N whitespace-separated tokens from a shell command.
 * Handles simple cases only — backticks / subshells / `env X=y cmd` are
 * intentionally not parsed; exclusion lists should use regex for those.
 */
export function extractLeadingTokens(command: string, n: number): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, n);
}
