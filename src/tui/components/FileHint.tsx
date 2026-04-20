/**
 * FileHint — overlay that lists path suggestions when the user has an `@`
 * token in the prompt buffer. Mirrors SlashHint's presentation so the two
 * feel like siblings.
 */

import React from "react";
import { Box, Text } from "ink";

interface Props {
  query: string;
  matches: string[];
  selectedIdx: number;
}

export function FileHint({ query, matches, selectedIdx }: Props) {
  if (matches.length === 0) {
    return (
      <Box borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text dimColor>No files match "{query}"</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
    >
      {matches.slice(0, 10).map((path, i) => (
        <Box key={path}>
          <Text color={i === selectedIdx ? "yellow" : "white"} bold={i === selectedIdx}>
            {i === selectedIdx ? "▸ " : "  "}
            {path}
          </Text>
        </Box>
      ))}
      <Box marginTop={0}>
        <Text dimColor>
          ↑↓ to move · Tab/Enter to pick · Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
