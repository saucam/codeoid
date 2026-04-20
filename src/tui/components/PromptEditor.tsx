/**
 * PromptEditor — multi-line text input with history, cursor, and slash
 * commands. Replaces ink-text-input which only supports a single line.
 *
 * Bindings:
 *   Enter           — submit (unless the buffer is empty)
 *   Alt+Enter       — insert newline
 *   Ctrl+J          — insert newline (universal fallback)
 *   \<Enter>        — type backslash then Enter to append newline
 *   Up / Down       — when cursor is on first/last line, cycle history
 *   Left / Right    — move cursor in the buffer
 *   Home / End      — line start / end
 *   Ctrl+A / Ctrl+E — line start / end (emacs-style)
 *   Ctrl+U          — clear to line start
 *   Ctrl+K          — clear to line end
 *   Ctrl+W          — delete previous word
 *   Backspace       — delete previous char (joins lines across newline)
 *
 * History is held in-process per TUI session; not persisted across runs (yet).
 */

import React, { useMemo } from "react";
import { Box, Text, useInput } from "ink";

export interface PromptEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Cursor position in the buffer, 0..value.length. */
  cursor: number;
  onCursorChange: (pos: number) => void;
  /** Shared prompt history (most recent first). */
  history: string[];
  onHistoryCycle: (direction: "prev" | "next") => void;
  disabled?: boolean;
  placeholder?: string;
}

export function PromptEditor(props: PromptEditorProps) {
  const {
    value,
    onChange,
    onSubmit,
    cursor,
    onCursorChange,
    onHistoryCycle,
    disabled,
    placeholder,
  } = props;

  useInput(
    (input, key) => {
      if (disabled) return;

      // Submit.
      if (key.return && !key.meta && !key.shift) {
        // Special: trailing backslash acts as "continue on next line".
        if (value.endsWith("\\")) {
          const next = `${value.slice(0, -1)}\n`;
          onChange(next);
          onCursorChange(next.length);
          return;
        }
        if (value.trim().length > 0) {
          onSubmit();
        }
        return;
      }

      // Newline triggers.
      if ((key.return && (key.meta || key.shift)) || (key.ctrl && input === "j")) {
        insertAtCursor("\n");
        return;
      }

      // Cursor movement.
      if (key.leftArrow) {
        onCursorChange(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        onCursorChange(Math.min(value.length, cursor + 1));
        return;
      }

      // History cycling — only when at first/last visual line.
      if (key.upArrow) {
        const before = value.slice(0, cursor);
        const onFirstLine = !before.includes("\n");
        if (onFirstLine) {
          onHistoryCycle("prev");
          return;
        }
        // Move cursor to same column on previous line.
        moveCursorVertically(-1);
        return;
      }
      if (key.downArrow) {
        const after = value.slice(cursor);
        const onLastLine = !after.includes("\n");
        if (onLastLine) {
          onHistoryCycle("next");
          return;
        }
        moveCursorVertically(1);
        return;
      }

      // Line-edit shortcuts.
      if (key.ctrl && input === "a") {
        onCursorChange(lineStartOf(value, cursor));
        return;
      }
      if (key.ctrl && input === "e") {
        onCursorChange(lineEndOf(value, cursor));
        return;
      }
      if (key.ctrl && input === "u") {
        const start = lineStartOf(value, cursor);
        onChange(value.slice(0, start) + value.slice(cursor));
        onCursorChange(start);
        return;
      }
      if (key.ctrl && input === "k") {
        const end = lineEndOf(value, cursor);
        onChange(value.slice(0, cursor) + value.slice(end));
        return;
      }
      if (key.ctrl && input === "w") {
        const start = wordBackBoundary(value, cursor);
        onChange(value.slice(0, start) + value.slice(cursor));
        onCursorChange(start);
        return;
      }

      // Backspace / delete.
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        onCursorChange(cursor - 1);
        return;
      }

      // Printable input.
      if (input && !key.ctrl && !key.meta) {
        insertAtCursor(input);
      }

      function insertAtCursor(s: string) {
        onChange(value.slice(0, cursor) + s + value.slice(cursor));
        onCursorChange(cursor + s.length);
      }

      function moveCursorVertically(dir: -1 | 1) {
        const lines = value.split("\n");
        let lineIdx = 0;
        let col = 0;
        let running = 0;
        for (let i = 0; i < lines.length; i++) {
          const len = lines[i]!.length;
          if (cursor <= running + len) {
            lineIdx = i;
            col = cursor - running;
            break;
          }
          running += len + 1; // +1 for the \n
        }
        const targetLine = lineIdx + dir;
        if (targetLine < 0 || targetLine >= lines.length) return;
        const targetCol = Math.min(col, lines[targetLine]!.length);
        let newCursor = 0;
        for (let i = 0; i < targetLine; i++) newCursor += lines[i]!.length + 1;
        newCursor += targetCol;
        onCursorChange(newCursor);
      }
    },
    { isActive: !disabled },
  );

  // ── Render ───────────────────────────────────────────────────────────────

  const lines = useMemo(() => splitWithCursor(value, cursor), [value, cursor]);
  const showPlaceholder = value.length === 0 && placeholder;

  return (
    <Box flexDirection="column">
      {showPlaceholder ? (
        <Box>
          <Text color="cyan" bold>
            {"› "}
          </Text>
          <Text dimColor>{placeholder}</Text>
        </Box>
      ) : (
        lines.map((line, i) => (
          <Box key={i}>
            <Text color="cyan" bold>
              {i === 0 ? "› " : "  "}
            </Text>
            <Text>
              {line.before}
              <Text inverse>{line.under}</Text>
              {line.after}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface LineSegment {
  before: string;
  under: string;
  after: string;
}

/**
 * Split `value` into lines and mark which character the cursor sits on for
 * inverse rendering. If cursor is at end of value or end of a line, the
 * inverse character is a single space so the user can still see the caret.
 */
function splitWithCursor(value: string, cursor: number): LineSegment[] {
  if (value.length === 0) {
    return [{ before: "", under: " ", after: "" }];
  }
  const segments: LineSegment[] = [];
  const lines = value.split("\n");
  let running = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineStart = running;
    const lineEnd = running + line.length;
    if (cursor >= lineStart && cursor <= lineEnd) {
      const inLine = cursor - lineStart;
      const under = inLine < line.length ? line[inLine]! : " ";
      segments.push({
        before: line.slice(0, inLine),
        under,
        after: line.slice(inLine + (inLine < line.length ? 1 : 0)),
      });
    } else {
      segments.push({ before: line, under: "", after: "" });
    }
    running = lineEnd + 1;
  }
  return segments;
}

function lineStartOf(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && value[i - 1] !== "\n") i--;
  return i;
}

function lineEndOf(value: string, cursor: number): number {
  let i = cursor;
  while (i < value.length && value[i] !== "\n") i++;
  return i;
}

function wordBackBoundary(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(value[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(value[i - 1]!)) i--;
  return i;
}
