/**
 * ContextStrategy — the pluggable policy for how a session hands its history to
 * an incoming backend on switch/fork (and, later, how it augments per-turn).
 *
 * This is the swap seam: the strategy decides WHAT context the model starts
 * with; the per-backend providers decide HOW it's delivered (transport). Swap a
 * strategy here without touching any backend wiring.
 *
 *   - TranscriptStrategy         — today's behavior: render the full history as
 *                                  a text transcript seed (bounded to the target
 *                                  window). The default and the fallback.
 *   - VerbatimWorkingSetStrategy — seed a compact session map + let the model
 *                                  page the verbatim store on demand via the
 *                                  recall tools. Used only when the incoming
 *                                  backend actually has those tools mounted;
 *                                  otherwise it falls back to the transcript.
 *
 * Selection is by `CODEOID_CONTEXT_STRATEGY` (default `transcript`), so this
 * ships with zero behavior change until a strategy is explicitly enabled and a
 * backend opts in via `supportsMemoryTools`.
 *
 * Best-effort by contract: the session wraps `seed()` in try/catch, so a
 * strategy never needs to — a throw degrades to an unseeded start.
 */

import type { CanonicalTurn, HistorySeedResult } from "./canonical.js";
import type { SessionProvider } from "./interface.js";

export interface SeedContext {
  provider: SessionProvider;
  history: readonly CanonicalTurn[];
  /** Memory present AND enabled (`CODEOID_MEMORY !== "0"`). */
  memoryEnabled: boolean;
  /** Char budget for a transcript seed, sized to the target model window. */
  seedBudgetChars: number;
  /** Lazily builds the compact session-map anchor (session-owned; needs its internals). */
  buildSessionMap: () => string;
}

export interface SeedOutcome {
  applied: boolean;
  /** Set when a transcript seed dropped older turns (for user-facing surfacing). */
  truncation?: HistorySeedResult;
  /** Which path actually ran — for logging + tests. */
  via: "transcript" | "session-map" | "none";
}

export interface ContextStrategy {
  readonly name: string;
  seed(ctx: SeedContext): Promise<SeedOutcome>;
}

/** Today's behavior: a bounded full-history text transcript. Default + fallback. */
export class TranscriptStrategy implements ContextStrategy {
  readonly name = "transcript";
  async seed(ctx: SeedContext): Promise<SeedOutcome> {
    if (!ctx.provider.seedFromHistory) return { applied: false, via: "none" };
    const result = await ctx.provider.seedFromHistory(ctx.history, {
      maxChars: ctx.seedBudgetChars,
    });
    return { applied: true, truncation: result ?? undefined, via: "transcript" };
  }
}

/** Compact session map + on-demand verbatim paging. Falls back to the transcript
 *  for any backend that doesn't yet have the recall tools mounted. */
export class VerbatimWorkingSetStrategy implements ContextStrategy {
  readonly name = "verbatim-working-set";
  #fallback = new TranscriptStrategy();
  async seed(ctx: SeedContext): Promise<SeedOutcome> {
    // Context-light path only when the incoming backend can actually page the
    // store — else the model gets a map it can't expand. Then it's the seedText
    // transport (the same first-prompt channel the transcript seed uses).
    if (ctx.memoryEnabled && ctx.provider.supportsMemoryTools && ctx.provider.seedText) {
      ctx.provider.seedText(ctx.buildSessionMap());
      return { applied: true, via: "session-map" };
    }
    return this.#fallback.seed(ctx);
  }
}

export type ContextStrategyName = "transcript" | "verbatim-working-set";

/** Pick the strategy from the environment. Defaults to transcript (no change). */
export function selectContextStrategy(
  env: Record<string, string | undefined> = process.env,
): ContextStrategy {
  switch ((env.CODEOID_CONTEXT_STRATEGY ?? "transcript").toLowerCase()) {
    case "vws":
    case "verbatim-working-set":
    case "session-map":
      return new VerbatimWorkingSetStrategy();
    default:
      return new TranscriptStrategy();
  }
}
