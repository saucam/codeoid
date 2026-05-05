/**
 * Per-model context-window catalog.
 *
 * Anthropic publishes context windows per model family; today the relevant
 * facts for codeoid are:
 *
 *   - claude-opus-4-7 (the "1M" variant): 1,000,000
 *   - claude-opus-4-x (default): 200,000
 *   - claude-sonnet-4-x: 200,000 (beta 1M is gated, treat as default)
 *   - claude-haiku-4-x: 200,000
 *
 * Aliases (`opus` / `sonnet` / `haiku`) resolve to the family's default
 * context window. When the SDK swaps in a different concrete model under
 * the alias, the daemon updates `SessionInfo.model` and we re-derive.
 *
 * Unknown models fall back to 200k — the conservative miss matches every
 * non-1M Claude model and keeps the percent-of-window accurate within
 * the model's actual capacity. Better to over-warn than under-warn.
 */

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const ONE_MILLION_CONTEXT = 1_000_000;

/**
 * Resolve the context window for a model id (or alias). Case-insensitive.
 * Matches by prefix + substring so future minor versions (e.g.
 * `claude-opus-4-7-1m-20260101`) don't break the table.
 */
export function contextWindowForModel(modelId: string | undefined | null): number {
  if (!modelId) return ONE_MILLION_CONTEXT; // codeoid default; opus-4-7 is the SDK default
  const m = modelId.toLowerCase();

  // Explicit 1M-context Opus variant.
  if (m.includes("opus-4-7") || m.includes("opus-4.7")) return ONE_MILLION_CONTEXT;
  if (m.includes("-1m")) return ONE_MILLION_CONTEXT;

  // Aliases (matching the daemon's model resolver).
  if (m === "opus" || m === "sonnet" || m === "haiku") {
    return m === "opus"
      ? ONE_MILLION_CONTEXT // codeoid's `opus` alias resolves to opus-4-7 (1M)
      : DEFAULT_CONTEXT_WINDOW;
  }

  // Other Claude models: 200k.
  if (m.startsWith("claude-")) return DEFAULT_CONTEXT_WINDOW;

  // Unknown — be conservative.
  return DEFAULT_CONTEXT_WINDOW;
}
