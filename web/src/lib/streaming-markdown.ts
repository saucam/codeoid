/**
 * Helpers for rendering markdown that is still streaming in.
 *
 * The naive approach — handing the whole accumulated string to the markdown
 * component on every delta — re-runs a full unified() parse and rebuilds the
 * message's DOM subtree per chunk: O(L²) parse work over the life of a
 * stream, visible as tab stutter on long answers (#87). Two remedies here:
 *
 * 1. `createFrameThrottled` — collapse delta-rate updates (20–40/s) into at
 *    most one renderer update per animation frame.
 * 2. `splitStreamingBlocks` — split the accumulated text at safe block
 *    boundaries (blank lines outside code fences) so completed blocks are
 *    rendered once and memoized by string identity; only the small live
 *    tail re-parses per frame. Callers should render the FULL text as one
 *    document again once streaming ends, making the final output identical
 *    to the non-streaming path.
 */

import { createRenderEffect, createSignal, onCleanup, type Accessor } from "solid-js";

/**
 * Mirror `source` into a returned signal, but while `active` is true coalesce
 * updates to at most one per animation frame (taking the latest value at
 * flush time). When `active` is false the value passes straight through and
 * any pending frame is cancelled.
 */
export function createFrameThrottled(
  source: Accessor<string>,
  active: Accessor<boolean>,
): Accessor<string> {
  const [value, setValue] = createSignal(source());
  let frame: number | null = null;

  // Render effect: runs synchronously with the write, so the passthrough
  // (inactive) path never lags a frame behind the source.
  createRenderEffect(() => {
    const text = source(); // track the source even when a flush is pending
    if (!active()) {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      setValue(text);
      return;
    }
    if (frame !== null) return; // a flush is already scheduled for this frame
    frame = requestAnimationFrame(() => {
      frame = null;
      setValue(source());
    });
  });

  onCleanup(() => {
    if (frame !== null) cancelAnimationFrame(frame);
  });

  return value;
}

export interface StreamingBlocks {
  /** Completed markdown blocks — stable strings, safe to memoize. */
  blocks: string[];
  /** Everything after the last safe boundary — the live, re-parsed tail. */
  tail: string;
  /** True when `tail` is an OPEN (unclosed) fenced code block. The caller can
   * then render it as a plain `<pre>` while streaming instead of re-parsing the
   * whole growing block as markdown every frame (O(L²) on large code output). */
  tailOpenFence: boolean;
}

/** A fence line (``` or ~~~, up to three leading spaces per CommonMark).
 * Captures the marker run and whatever follows it. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Split streamed markdown at blank lines OUTSIDE fenced code blocks. The
 * final segment is returned as `tail` (it may still be growing). Boundaries
 * are deliberately conservative — a fence tracker is the only state — so a
 * streaming code block is never split in half. Constructs that span blank
 * lines (reference-link definitions, loose lists) can render slightly
 * differently ACROSS a boundary while streaming; that transience is the
 * trade-off, and it disappears when the caller re-renders the finished
 * message as one document.
 */
export function splitStreamingBlocks(text: string): StreamingBlocks {
  const blocks: string[] = [];
  /** The open fence's marker char + length, or null outside a fence. A
   * closer must use the SAME char, be at least as long, and carry nothing
   * but whitespace after it (CommonMark) — a literal ```-prefixed line
   * inside a ~~~ block, or a fence-like line with trailing text, is
   * content, not a closer. */
  let fence: { char: string; len: number } | null = null;
  let start = 0; // start offset of the current block
  let lineStart = 0;
  let blankRun = -1; // start offset of the current run of blank lines

  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== "\n") continue;
    const line = text.slice(lineStart, i);
    const m = FENCE_LINE.exec(line);
    if (m && fence === null) {
      // A fence OPENING after a blank run also completes the previous
      // block — otherwise a long streaming code block would drag the
      // finished paragraph before it into every tail re-parse.
      if (blankRun > start) {
        blocks.push(text.slice(start, blankRun));
        start = lineStart;
      }
      fence = { char: m[1]![0]!, len: m[1]!.length };
      blankRun = -1;
    } else if (
      m &&
      fence !== null &&
      m[1]![0] === fence.char &&
      m[1]!.length >= fence.len &&
      (m[2] ?? "").trim() === ""
    ) {
      // Matching closer.
      fence = null;
      blankRun = -1;
    } else if (fence === null && line.trim() === "") {
      // Track where the blank run began; the block ends before it.
      if (blankRun < 0) blankRun = lineStart;
    } else {
      // First non-blank line after a blank run outside a fence → the
      // previous block is complete. (Inside a fence blankRun is always -1,
      // so fence content — including non-closing fence-like lines — lands
      // here harmlessly.)
      if (blankRun > start) {
        blocks.push(text.slice(start, blankRun));
        start = lineStart;
      }
      blankRun = -1;
    }
    lineStart = i + 1;
  }

  return { blocks, tail: text.slice(start), tailOpenFence: fence !== null };
}
