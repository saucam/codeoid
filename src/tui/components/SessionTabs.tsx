/**
 * SessionTabs — horizontal strip shown at the top of the TUI. Replaces the
 * vertical SessionRail. Narrow, scannable, stays out of the way of the
 * transcript which now gets full terminal width.
 *
 * Each tab: status dot + name. Focused session is bold + underlined.
 * Badges (unread, pending approval, mode, pinned) render compactly.
 */

import React from "react";
import { Box, Text } from "ink";
import type { TuiSession } from "../types.js";

interface Props {
  sessions: TuiSession[];
  focusedId: string | null;
  width: number;
}

const STATUS_COLOR: Record<string, string> = {
  idle: "green",
  working: "yellow",
  waiting_approval: "red",
  error: "red",
};

export function SessionTabs({ sessions, focusedId }: Props) {
  if (sessions.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No sessions — Ctrl-N to create</Text>
      </Box>
    );
  }

  // NO flexWrap. A wrapping tab strip changes height (1 row ↔ 2 rows)
  // as status dots flip color, unread counters toggle, or approval
  // badges appear — and each height flip desyncs Ink's lastFrame
  // measurement, so the patchConsole path under-erases on the next
  // ScrollbackWriter write and the old tab row leaks into scrollback.
  // Fixed-1-row guarantees a stable live-dock footprint.
  return (
    <Box paddingX={1} overflowX="hidden">
      {sessions.map((s, i) => (
        <SessionTab
          key={s.info.id}
          session={s}
          focused={s.info.id === focusedId}
          showSeparator={i > 0}
        />
      ))}
    </Box>
  );
}

function SessionTab({
  session,
  focused,
  showSeparator,
}: {
  session: TuiSession;
  focused: boolean;
  showSeparator: boolean;
}) {
  const color = STATUS_COLOR[session.info.status] ?? "white";
  const mode = session.info.mode ?? "interactive";
  const modeBadge =
    mode === "auto-allow" ? " ᴀ" : mode === "autonomous" ? " ᴀ⚡" : "";
  const pinCount = session.info.pinnedFiles?.length ?? 0;

  // Focused tab: cyan block on both sides + inverse text. Guaranteed to
  // read correctly across terminals — doesn't rely on underline/bold alone.
  if (focused) {
    return (
      <Box>
        {showSeparator && <Text dimColor>{"  "}</Text>}
        <Text color="cyan" bold>▸ </Text>
        <Text color={color}>●</Text>
        <Text color="cyan" bold inverse>
          {" " + session.info.name + " "}
        </Text>
        {session.unread > 0 && <Text color="yellow">{` (${session.unread})`}</Text>}
        {session.pendingApproval && <Text color="red" bold>{" ⎆"}</Text>}
        {modeBadge && <Text color="magenta">{modeBadge}</Text>}
        {pinCount > 0 && <Text color="yellow">{` 📌${pinCount}`}</Text>}
      </Box>
    );
  }

  return (
    <Box>
      {showSeparator && <Text dimColor>{"  "}</Text>}
      <Text color={color}>●</Text>
      <Text dimColor>{" " + session.info.name}</Text>
      {session.unread > 0 && <Text color="yellow">{` (${session.unread})`}</Text>}
      {session.pendingApproval && <Text color="red" bold>{" ⎆"}</Text>}
      {modeBadge && <Text color="magenta">{modeBadge}</Text>}
      {pinCount > 0 && <Text color="yellow">{` 📌${pinCount}`}</Text>}
    </Box>
  );
}
