/**
 * StatusBar — one-line context row above the prompt. Shows connection state,
 * focused session info, and last error.
 */

import React from "react";
import { Box, Text } from "ink";
import type { TuiSession } from "../types.js";

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
