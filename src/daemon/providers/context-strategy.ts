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
import { formatTimeline } from "../memory/index.js";
import type { Episode } from "../memory/index.js";

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

// ── Session-map anchor (the VWS seed content) ─────────────────────────────────

export interface SessionMapInput {
  workdir: string;
  sessionName: string;
  sessionId: string;
  /** The last few turns, verbatim — survives even if the model never pages. */
  recentTurns: readonly CanonicalTurn[];
  /** Recent episodes for the ordered page table (each carries an episode_id). */
  timelineEpisodes: readonly Episode[];
}

const clampSeed = (s: string, n = 2000): string => (s.length > n ? `${s.slice(0, n)}\n…` : s);

/**
 * Render the compact `<session_map>` anchor for a cross-backend switch/fork.
 * Pure + provider-agnostic (so it's directly testable): a continuation notice,
 * the recall-tool advertisement, an ordered page table of recent episodes (each
 * with an episode_id), and the last few turns verbatim. Nothing is summarized —
 * everything else is one recall/get_episode away.
 */
export function renderSessionMap(input: SessionMapInput): string {
  const parts: string[] = [];
  parts.push("<session_map>");
  parts.push(
    "You are continuing an ongoing session that was running on another agent backend. This is a CONTINUATION — do not re-introduce yourself or repeat completed work.",
  );
  parts.push("");
  parts.push(`Workspace: ${input.workdir}. Session: "${input.sessionName}".`);
  parts.push("");
  parts.push(
    "The full prior history is preserved verbatim in codeoid memory — page any of it in on demand (nothing is summarized):",
  );
  parts.push("  - recall(query)              — semantic search across all prior episodes");
  parts.push("  - timeline(offset?, limit?)  — walk the full history in order; each line has an episode_id");
  parts.push("  - get_episode(episode_id)    — fetch one past turn or tool result verbatim");
  parts.push("  - recall_file(path)          — the most recent prior read of a file");
  parts.push("The workspace index in your system prompt lists the topics + hot files in memory.");
  parts.push("");
  if (input.timelineEpisodes.length > 0) {
    parts.push("## Recent episodes (newest first — page older with `timeline` offset)");
    parts.push(formatTimeline([...input.timelineEpisodes], input.sessionId, 0));
    parts.push("");
  }
  const recent = input.recentTurns.slice(-3);
  if (recent.length > 0) {
    parts.push(`## Last ${recent.length} turn(s) (verbatim)`);
    for (const t of recent) {
      if (t.role === "user") {
        parts.push(`### User\n${clampSeed(t.content)}`);
      } else {
        const seg: string[] = ["### Assistant"];
        if (t.content) seg.push(clampSeed(t.content));
        for (const tc of t.toolCalls ?? []) seg.push(`[tool: ${tc.name}]`);
        parts.push(seg.join("\n"));
      }
    }
    parts.push("");
  }
  parts.push("</session_map>");
  parts.push("");
  return parts.join("\n");
}

// ── Rotation seed anchor (in-session context rollover) ─────────────────────────

export interface RotationSeedInput {
  workdir: string;
  sessionName: string;
  rotationCount: number;
  /** The last user turn before the rotation, or null when memory is off. */
  lastUserTurn: string | null;
}

/**
 * Render the `<rotation_context>` anchor for an IN-SESSION context rollover
 * (distinct from a cross-backend switch/fork, which uses the transcript seed or
 * the session map). Same task-anchor shape: a continuation notice, the recall
 * tool advertisement (including get_episode for verbatim by-id paging), and the
 * last user turn. Pure + exported so the tests exercise the real renderer
 * instead of a hand-mirrored copy.
 */
export function renderRotationSeed(input: RotationSeedInput): string {
  const parts: string[] = [];
  parts.push("<rotation_context>");
  parts.push(
    "Codeoid just rotated this session's backing Claude Code context to stay below the compaction ceiling. This is a CONTINUATION, not a new session.",
  );
  parts.push("");
  parts.push(
    `Workspace: ${input.workdir}. Rotation #${input.rotationCount} of this session ("${input.sessionName}").`,
  );
  parts.push("");
  parts.push("Prior turns are preserved verbatim in codeoid memory. Retrieve on demand:");
  parts.push("  - `recall(query)`               — semantic search across all prior episodes");
  parts.push("  - `recall_file(path)`           — most recent prior Read of a specific file");
  parts.push("  - `timeline(offset?, limit?)`   — walk activity in order; each line has an episode_id");
  parts.push("  - `get_episode(episode_id)`     — fetch one past turn or tool result verbatim");
  parts.push(
    "The workspace index in your system prompt already advertises what topics + files are in memory.",
  );
  parts.push("");
  if (input.lastUserTurn) {
    parts.push("Most recent user turn before the rotation:");
    parts.push("---");
    parts.push(input.lastUserTurn.length > 2000 ? `${input.lastUserTurn.slice(0, 2000)}\n…` : input.lastUserTurn);
    parts.push("---");
  } else {
    parts.push("No prior user turn recorded (memory disabled). Rely on the user's next message.");
  }
  parts.push("</rotation_context>");
  parts.push("");
  return parts.join("\n");
}
