/**
 * Target context-window resolution for cross-backend history seeding.
 *
 * Hybrid model: exact per-model window when known (Claude via MODEL_CATALOG,
 * a few non-Claude overrides), else a conservative per-provider default, else
 * a fallback. The seed budget is a fraction of that window in chars.
 */

import { describe, it, expect } from "bun:test";
import {
  targetContextWindow,
  seedBudgetChars,
  FALLBACK_CONTEXT_WINDOW,
  SEED_WINDOW_FRACTION,
  SEED_CHARS_PER_TOKEN,
} from "../daemon/providers/context-windows.js";

describe("targetContextWindow", () => {
  it("uses the exact Claude catalog window for a known Claude model/alias", () => {
    expect(targetContextWindow("claude", "opus")).toBe(1_000_000);
    expect(targetContextWindow("claude", "claude-opus-4-8")).toBe(1_000_000);
    // Haiku is a smaller window — proves per-model precision, not just provider default.
    expect(targetContextWindow("claude", "claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("falls back to the per-provider default when the model is unknown/absent", () => {
    // The common fork case: target model not chosen yet.
    expect(targetContextWindow("claude", undefined)).toBe(200_000);
    expect(targetContextWindow("codex", null)).toBe(256_000);
    expect(targetContextWindow("openai", undefined)).toBe(128_000);
    expect(targetContextWindow("gemini", undefined)).toBe(1_000_000);
    expect(targetContextWindow("gemini-cli", undefined)).toBe(1_000_000);
    expect(targetContextWindow("pi", undefined)).toBe(200_000);
  });

  it("applies high-confidence non-Claude per-model overrides", () => {
    expect(targetContextWindow("openai", "gpt-4o")).toBe(128_000);
    expect(targetContextWindow("openai", "gpt-4.1-mini")).toBe(1_000_000);
    expect(targetContextWindow("gemini", "gemini-2.5-pro")).toBe(1_000_000);
  });

  it("uses the global fallback for an unknown provider", () => {
    expect(targetContextWindow("brand-new-backend", undefined)).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(targetContextWindow("brand-new-backend", "some-model")).toBe(FALLBACK_CONTEXT_WINDOW);
  });
});

describe("seedBudgetChars", () => {
  it("is a fraction of the target window converted to chars", () => {
    const window = targetContextWindow("gemini", undefined); // 1M
    expect(seedBudgetChars("gemini", undefined)).toBe(
      Math.floor(window * SEED_WINDOW_FRACTION * SEED_CHARS_PER_TOKEN),
    );
  });

  it("a bigger target window yields a bigger seed budget (less truncation)", () => {
    // gemini (1M) must allow a strictly larger seed than openai (128k default).
    expect(seedBudgetChars("gemini", undefined)).toBeGreaterThan(seedBudgetChars("openai", undefined));
  });

  it("leaves headroom below the raw window (never spends 100%)", () => {
    expect(SEED_WINDOW_FRACTION).toBeLessThan(1);
    const rawWindowChars = targetContextWindow("codex", undefined) * SEED_CHARS_PER_TOKEN;
    expect(seedBudgetChars("codex", undefined)).toBeLessThan(rawWindowChars);
  });
});
