/**
 * Model catalog — the set of Claude variants codeoid knows about + alias
 * resolution. Users interact with friendly names (`opus`, `sonnet`,
 * `haiku`); we resolve to the full Anthropic model id when plumbing into
 * the SDK's `query({ options: { model } })`.
 *
 * Why maintained here vs hard-coded on the SDK:
 *   - We need display labels + context-window sizes for the UI (picker,
 *     warnings when the new model has a smaller window than current ctx).
 *   - Aliases are opinionated — opus always maps to "current best" for
 *     planning work, haiku always to "fast + cheap" — not just the latest
 *     version bump. Decoupled from Anthropic's id changes.
 *   - A passthrough escape hatch (`resolveModel` accepts any string that
 *     looks like a full id) means users aren't locked to our opinions.
 */

export type ModelTier = "premium" | "balanced" | "fast";

export interface ModelDescriptor {
  /** Full Anthropic API model id. */
  id: string;
  /** Short alias the user types. */
  alias: string;
  /** Display label for pickers. */
  label: string;
  /** Context window size in tokens (with any betas that codeoid enables). */
  contextWindow: number;
  /** Rough tier for UI coloring / default routing choices. */
  tier: ModelTier;
  /** One-line description shown in the picker. */
  description: string;
}

/**
 * Canonical model list — order = picker display order (best-first for
 * planning, cheap-last for execution). Keep IDs stable; if Anthropic
 * ships a new point release, bump the id here and the alias stays valid.
 */
export const MODEL_CATALOG: readonly ModelDescriptor[] = [
  {
    id: "claude-opus-4-7",
    alias: "opus",
    label: "Opus 4.7",
    contextWindow: 1_000_000,
    tier: "premium",
    description: "Deepest reasoning. Best for planning, refactoring, and hard problems.",
  },
  {
    id: "claude-sonnet-4-6",
    alias: "sonnet",
    label: "Sonnet 4.6",
    contextWindow: 1_000_000,
    tier: "balanced",
    description: "Fast and capable. Good default for day-to-day coding.",
  },
  {
    id: "claude-haiku-4-5-20251001",
    alias: "haiku",
    label: "Haiku 4.5",
    contextWindow: 200_000,
    tier: "fast",
    description: "Cheapest + fastest. Good for simple edits and cheap subtasks.",
  },
];

/** Look up a descriptor by alias or full id. Case-insensitive on aliases. */
export function findModel(identifier: string): ModelDescriptor | null {
  if (!identifier) return null;
  const lower = identifier.toLowerCase().trim();
  for (const m of MODEL_CATALOG) {
    if (m.alias === lower) return m;
    if (m.id.toLowerCase() === lower) return m;
  }
  return null;
}

/**
 * Resolve user input → full model id. Accepts:
 *   - an alias ("opus" → "claude-opus-4-7")
 *   - a full known id (passed through)
 *   - any other string that looks like a Claude model id (passed through —
 *     user knows what they want; we don't gatekeep)
 * Returns null on empty/whitespace input.
 */
export function resolveModelId(identifier: string): string | null {
  const trimmed = identifier?.trim();
  if (!trimmed) return null;
  const known = findModel(trimmed);
  if (known) return known.id;
  // Passthrough: allow any "claude-*" id the caller provides even if it's
  // not in our catalog. Typos aren't caught here — they'll surface as
  // errors at SDK time, which is better than us refusing unknown-but-valid
  // point releases.
  if (/^claude-/.test(trimmed)) return trimmed;
  return null;
}

/** Default model when nothing else is specified. */
export const DEFAULT_MODEL_ALIAS = "opus";
