/**
 * Compressor public types — rules, context, result shape.
 *
 * Rules are declarative: each one carries a `match(command)` predicate and a
 * `compress(stdout, ctx)` transformer. The registry fires the first rule
 * whose match returns true; rules are ordered by specificity (git diff before
 * generic `git *`, etc.).
 *
 * Rules MUST be pure functions of their inputs — no disk, no network, no
 * clock. Keeps compression deterministic and unit-testable.
 */

/** Per-invocation context passed to every rule. */
export interface CompressionContext {
  /** Working directory where the command ran. */
  workdir: string;
  /** Exact shell command string (pre-split). */
  originalCommand: string;
  /** Exit code — rules can preserve verbosity on non-zero. */
  exitCode: number;
  /** True when the raw stdout exceeded the rule's size threshold. */
  isLarge: boolean;
  /** Raw byte count (for telemetry + decision-making). */
  rawBytes: number;
  /** Env snapshot — useful for workspace-aware trimming. */
  env: Readonly<Record<string, string>>;
}

/**
 * Output of a single rule. `null` = rule opted out (pass-through).
 * On a hit, `compressed` is the text that replaces stdout; other fields
 * are metadata for telemetry + Claude-facing hints.
 */
export interface CompressionResult {
  /** Text shown to Claude in place of raw stdout. */
  compressed: string;
  /** Original bytes before compression (for ratio reporting). */
  originalBytes: number;
  /** Rule that won the match (stable id for telemetry). */
  ruleName: string;
  /**
   * Optional hint appended to the compressed body. Format hint is consistent
   * so Claude learns to look for it — e.g.,
   *   `[codeoid: compressed 87%; call recall("exact command") for raw output]`
   */
  hint?: string;
}

/** A single declarative compression rule. */
export interface CompressionRule {
  /** Stable identifier — appears in telemetry + rule bypass lists. */
  name: string;
  /** Human-readable description for `codeoid rules` CLI output. */
  description: string;
  /**
   * Predicate: given the shell command string, does this rule apply?
   * Implementations should be cheap (regex / substring), not heavy parsers.
   */
  match: (command: string) => boolean;
  /**
   * Transform. Return `null` to pass stdout through unchanged — e.g., when
   * the output is already small enough to not warrant compression.
   */
  compress: (stdout: string, ctx: CompressionContext) => CompressionResult | null;
}

/** Metadata returned by the runner for observability. */
export interface CompressionOutcome {
  /** Stdout actually shown to Claude (may be compressed or raw). */
  stdout: string;
  /** Raw bytes pre-compression. */
  originalBytes: number;
  /** Bytes after compression. Equals originalBytes when no rule fired. */
  compressedBytes: number;
  /** Ratio 0..1 (compressedBytes / originalBytes). 1.0 = no compression. */
  ratio: number;
  /** Rule name that fired, or null for pass-through. */
  ruleName: string | null;
  /** Original exit code of the underlying command. */
  exitCode: number;
  /** Stderr is NEVER compressed — error messages need fidelity. */
  stderr: string;
}

/** Known rule name — used for config-based opt-out (compress.excludeRules). */
export type RuleName = string;
