/**
 * StatusBar — one-line context row above the prompt. Shows connection state,
 * focused session info, cumulative token/cost usage, and the last error.
 */

import React from "react";
import { Box, Text } from "ink";
import type { TuiSession } from "../types.js";
import { findModel } from "../../daemon/models.js";

interface Props {
  connection: "connecting" | "connected" | "reconnecting" | "error";
  focused: TuiSession | null;
  lastError: string | null;
}

const CONNECTION_COLOR: Record<Props["connection"], string> = {
  connecting: "yellow",
  connected: "green",
  reconnecting: "yellow",
  error: "red",
};

export function StatusBar({ connection, focused, lastError }: Props) {
  const usage = focused?.info.usage;
  return (
    <Box paddingX={1}>
      <Text color={CONNECTION_COLOR[connection]}>●</Text>
      <Text> {connection}</Text>
      {focused && (
        <>
          <Text dimColor>{"   │   "}</Text>
          <Text bold>{focused.info.name}</Text>
          <Text dimColor>{" @ "}</Text>
          <Text dimColor>{focused.info.workdir}</Text>
          <Text dimColor>{" · "}</Text>
          <Text>{focused.info.status}</Text>
          {focused.info.queuedMessages !== undefined &&
            focused.info.queuedMessages > 0 && (
              <Text color="yellow" bold>
                {" · ⎆ " + focused.info.queuedMessages + " queued"}
              </Text>
            )}
          <Text dimColor>{" · mode: "}</Text>
          <Text
            color={
              (focused.info.mode ?? "interactive") === "interactive"
                ? "white"
                : (focused.info.mode ?? "") === "auto-allow"
                  ? "blue"
                  : "magenta"
            }
            bold
          >
            {focused.info.mode ?? "interactive"}
          </Text>
          {focused.info.mode === "autonomous" &&
            focused.info.turnsRemaining !== undefined && (
              <Text dimColor>
                {" (" + focused.info.turnsRemaining + " actions left)"}
              </Text>
            )}
          {focused.info.model && (
            <>
              <Text dimColor>{" · "}</Text>
              <Text color="cyan">
                {findModel(focused.info.model)?.alias ?? focused.info.model}
              </Text>
            </>
          )}
          {focused.info.pinnedFiles && focused.info.pinnedFiles.length > 0 && (
            <>
              <Text dimColor>{" · pinned: "}</Text>
              <Text color="yellow">
                {focused.info.pinnedFiles.length}
              </Text>
              <Text dimColor>
                {" (" + focused.info.pinnedFiles.slice(0, 3).join(", ") +
                  (focused.info.pinnedFiles.length > 3 ? ", …" : "") + ")"}
              </Text>
            </>
          )}
          {usage && usage.numTurns > 0 && (
            <>
              <Text dimColor>{"   │   "}</Text>
              <Text color="cyan" bold>
                {formatCost(usage.totalCostUsd)}
              </Text>
              {usage.lastTurnCostUsd !== undefined && usage.lastTurnCostUsd > 0 && (
                <Text color="cyan" dimColor>
                  {" (Δ " + formatCost(usage.lastTurnCostUsd) + ")"}
                </Text>
              )}
              <Text dimColor>
                {" · " + formatTokens(totalInputOf(usage)) + " in / " +
                  formatTokens(usage.outputTokens) + " out"}
              </Text>
              {usage.cacheReadTokens > 0 && (
                <Text
                  color={pickCacheColor(usage)}
                  dimColor
                >
                  {" · " + formatPct(cacheRateCumulative(usage)) + " cache"}
                </Text>
              )}
              <Text dimColor>{" · " + usage.numTurns + " turns"}</Text>
              {usage.lastTurnInputTokens !== undefined && usage.lastTurnInputTokens > 0 && (
                <>
                  <Text dimColor>{" · ctx "}</Text>
                  <Text color={pickContextColor(usage.lastTurnInputTokens)} bold>
                    {formatTokens(usage.lastTurnInputTokens)}
                  </Text>
                  <Text dimColor>
                    {"/" + formatTokens(CONTEXT_WINDOW) + " ("}
                  </Text>
                  <Text color={pickContextColor(usage.lastTurnInputTokens)}>
                    {formatPct(usage.lastTurnInputTokens / CONTEXT_WINDOW)}
                  </Text>
                  <Text dimColor>{")"}</Text>
                </>
              )}
              {usage.peakInputTokens !== undefined &&
                usage.peakInputTokens > 0 &&
                usage.peakInputTokens !== usage.lastTurnInputTokens && (
                  <Text
                    color={pickContextColor(usage.peakInputTokens)}
                    dimColor
                  >
                    {" · peak " + formatTokens(Math.min(usage.peakInputTokens, CONTEXT_WINDOW))}
                    {/* When raw peak exceeds the window, that turn summed
                        multiple internal API calls (subagents/retries). The
                        sum isn't a real single-call context size — badge
                        it so the user knows not to trust the raw figure. */}
                    {usage.peakInputTokens > CONTEXT_WINDOW && (
                      <Text color="yellow">{" (Σ multi-call)"}</Text>
                    )}
                  </Text>
                )}
              {focused.info.rotation &&
                focused.info.rotation.count > 0 && (
                  <Text color="magenta" dimColor>
                    {" · 🔄 " + focused.info.rotation.count}
                  </Text>
                )}
            </>
          )}
        </>
      )}
      {lastError && (
        <>
          <Text dimColor>{"   │   "}</Text>
          <Text color="red">⚠ {lastError}</Text>
        </>
      )}
    </Box>
  );
}

/** Render a token count as 1234 / 12.3k / 1.2M to keep the status bar tight. */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 10_000) return (n / 1_000).toFixed(1) + "k";
  if (n < 1_000_000) return Math.round(n / 1_000) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

/**
 * Render cost in USD with one decimal below $10 (e.g. "$0.42", "$9.8") and
 * whole dollars above (e.g. "$42", "$1.2k"). Tiny costs collapse to "$0.00"
 * rather than a noisy exponential.
 */
function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 10) return "$" + usd.toFixed(2);
  if (usd < 100) return "$" + usd.toFixed(1);
  if (usd < 1_000) return "$" + Math.round(usd);
  return "$" + (usd / 1_000).toFixed(1) + "k";
}

/** Render a 0-1 ratio as a compact "NN%". */
function formatPct(r: number): string {
  if (!Number.isFinite(r) || r <= 0) return "0%";
  return Math.round(r * 100) + "%";
}

/** Total context tokens processed = new input + cache read + cache write. */
function totalInputOf(u: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/**
 * Cumulative cache hit rate across all turns. Denominator is the total
 * context size (new input + cache read + cache creation), NOT just
 * new input — Anthropic's `input_tokens` excludes cached tokens.
 */
function cacheRateCumulative(u: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  const total = totalInputOf(u);
  return total > 0 ? u.cacheReadTokens / total : 0;
}

/** Color the cache percentage by desirability (higher = greener). */
function pickCacheColor(u: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): string {
  const r = cacheRateCumulative(u);
  if (r >= 0.7) return "green";
  if (r >= 0.4) return "yellow";
  return "red";
}

/**
 * Claude's context window. Opus 4.7 + Sonnet 4.x (with the `context-1m`
 * beta) both hit 1M tokens. Pre-beta models cap at 200k but codeoid defaults
 * to the 1M setting and the SDK exposes the 1M beta explicitly, so 1M is
 * the right denominator for compaction-risk coloring here.
 */
const CONTEXT_WINDOW = 1_000_000;

/**
 * Color a context-size value by occupancy of the window.
 * > 80% → red (compaction imminent), 50-80% → yellow, < 50% → green.
 */
function pickContextColor(inputTokens: number): string {
  const r = inputTokens / CONTEXT_WINDOW;
  if (r >= 0.8) return "red";
  if (r >= 0.5) return "yellow";
  return "green";
}

