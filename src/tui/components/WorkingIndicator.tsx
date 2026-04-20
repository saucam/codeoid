/**
 * WorkingIndicator — session-level "something is happening right now" feedback.
 *
 * Renders continuously while the focused session's status is `working`, even
 * when no live message has arrived yet (e.g. the model is still reasoning
 * internally, or waiting for its first token). Animated spinner + cycling
 * verb + elapsed seconds + interrupt hint. Goes away the instant status
 * flips back to `idle`/`error`.
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { Subagent } from "../../protocol/types.js";

interface Props {
  /** unix ms when work started. Used to compute elapsed seconds live. */
  startedAt: number;
  /** Primary session agent URI (SPIFFE / WIMSE). */
  agentUri?: string;
  /** Active sub-agents, if any. Most-recent first looks best visually. */
  subagents?: Subagent[];
}

const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/** Cycling verbs — pure flavor, gives the indicator a sense of motion. */
const VERBS = [
  "Thinking",
  "Reasoning",
  "Reading",
  "Considering",
  "Cross-referencing memory",
  "Planning",
  "Writing",
  "Weaving",
  "Reviewing",
];

export function WorkingIndicator({ startedAt, agentUri, subagents }: Props) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, []);

  const elapsedMs = Date.now() - startedAt;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
  const verb = VERBS[Math.floor(tick / 30) % VERBS.length];

  const activeSubs = (subagents ?? []).filter((s) => s.active);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="yellow">{frame}</Text>
        <Text>{" "}</Text>
        <Text color="cyan" bold>
          {verb}…
        </Text>
        <Text dimColor>{`  ${formatElapsed(elapsedSec)}`}</Text>
        <Text dimColor>{"  ·  Ctrl-X to interrupt"}</Text>
      </Box>
      {agentUri && (
        <Box>
          <Text dimColor>acting as </Text>
          <Text color="magenta" dimColor>
            {shortenUri(agentUri)}
          </Text>
        </Box>
      )}
      {activeSubs.length > 0 && (
        <Box flexDirection="column">
          {activeSubs.map((s) => (
            <Box key={s.agentId}>
              <Text dimColor>  via </Text>
              <Text color="green" bold>
                {s.agentType}
              </Text>
              <Text dimColor> {shortenUri(s.wimseUri ?? s.agentId)}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** Shorten a SPIFFE/WIMSE URI for display — keep the last 2 path segments. */
function shortenUri(uri: string): string {
  if (!uri.startsWith("spiffe://")) return uri;
  try {
    const rest = uri.slice("spiffe://".length);
    const parts = rest.split("/");
    if (parts.length <= 3) return uri;
    return `…/${parts.slice(-2).join("/")}`;
  } catch {
    return uri;
  }
}

function formatElapsed(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
