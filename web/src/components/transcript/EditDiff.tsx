/**
 * Inline diff view for `Edit`/`Write` tool calls.
 *
 * The Edit tool's input carries `{file_path, old_string, new_string}` —
 * everything we need to render a real before/after diff. The Write
 * tool only has the new content (no "before"); we render it as a
 * single-sided code block with a synthetic "+ added" rail so the user
 * can tell at a glance the file is being created/replaced wholesale.
 *
 * We use `diff.diffLines` (jsdiff) because Claude's edits land at a
 * line granularity ~99% of the time — char-level diffs would be too
 * noisy and word-level miss multi-line restructures. Each diff hunk
 * is highlighted via the shared shiki highlighter so syntax stays
 * readable even on the removed side.
 *
 * Shows up in two phases:
 *   - waiting_confirmation: the *proposed* edit, before approval. The
 *     user can read the diff in the approval bar context above.
 *   - completed: the *applied* edit. Same diff, just re-keyed off the
 *     final state. Cancelled / failed edits skip rendering this and
 *     fall through to the generic ToolStateBody.
 */

import { Component, For, createMemo, createResource } from "solid-js";
import * as Diff from "diff";

import { ensureLang, langForFilename } from "../../lib/shiki";

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface WriteInput {
  file_path: string;
  content: string;
}

export function isEditInput(input: unknown): input is EditInput {
  if (!input || typeof input !== "object") return false;
  const o = input as Record<string, unknown>;
  return (
    typeof o.file_path === "string" &&
    typeof o.old_string === "string" &&
    typeof o.new_string === "string"
  );
}

export function isWriteInput(input: unknown): input is WriteInput {
  if (!input || typeof input !== "object") return false;
  const o = input as Record<string, unknown>;
  return typeof o.file_path === "string" && typeof o.content === "string";
}

interface DiffLine {
  kind: "added" | "removed" | "context";
  text: string;
  /** Line number on the OLD side, when applicable. */
  oldLine?: number;
  /** Line number on the NEW side, when applicable. */
  newLine?: number;
}

const CONTEXT_LINES = 2;

function buildLineDiff(oldText: string, newText: string): DiffLine[] {
  const parts = Diff.diffLines(oldText, newText);
  const out: DiffLine[] = [];
  let oldLineNo = 1;
  let newLineNo = 1;
  for (const part of parts) {
    // Each part has a `value` that may end in a trailing newline.
    // Splitting and dropping a trailing empty entry preserves blank
    // lines that the user actually intended (an empty line shows up as
    // a separate part with value "\n", which split produces ["", ""]).
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const text of lines) {
      if (part.added) {
        out.push({ kind: "added", text, newLine: newLineNo++ });
      } else if (part.removed) {
        out.push({ kind: "removed", text, oldLine: oldLineNo++ });
      } else {
        out.push({
          kind: "context",
          text,
          oldLine: oldLineNo++,
          newLine: newLineNo++,
        });
      }
    }
  }
  return out;
}

/**
 * Trim long stretches of unchanged context to ~`CONTEXT_LINES` lines on
 * either side of each change. Inserts `null` separators that the
 * renderer surfaces as a "…" gap row, keeping the diff scannable when
 * the input strings include big surrounding files.
 */
function withCollapsedContext(lines: DiffLine[]): (DiffLine | null)[] {
  // Keep all changed lines; for runs of context, keep the leading +
  // trailing N lines around the nearest change.
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    if (cur && cur.kind !== "context") {
      for (
        let j = Math.max(0, i - CONTEXT_LINES);
        j <= Math.min(lines.length - 1, i + CONTEXT_LINES);
        j++
      ) {
        keep[j] = true;
      }
    }
  }
  // If everything was context, keep the whole thing — the user asked
  // for an Edit but nothing differed, surface the head as-is.
  if (!keep.some((k) => k)) {
    return lines.slice(0, 8);
  }
  const out: (DiffLine | null)[] = [];
  let prevKept = false;
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    if (keep[i] && cur) {
      out.push(cur);
      prevKept = true;
    } else if (prevKept) {
      out.push(null);
      prevKept = false;
    }
  }
  return out;
}

interface DiffIndices {
  /** Map from each non-added DiffLine reference → its index in the OLD-side buffer. */
  oldIndex: Map<DiffLine, number>;
  /** Map from each non-removed DiffLine reference → its index in the NEW-side buffer. */
  newIndex: Map<DiffLine, number>;
  /** OLD-side joined text — passed to shiki once, sliced per row. */
  oldText: string;
  /** NEW-side joined text. */
  newText: string;
}

/**
 * Build two side-buckets out of the line list AND a (line → bucket
 * index) map per side. The previous renderer recomputed
 * `lines.filter(...)` and `[].indexOf(...)` per row — O(n²) filters
 * on top of O(n) indexOf, total O(n³) for a diff with N lines.
 * Doing it once at the parent and looking up via Map cuts every
 * lookup to O(1).
 */
function buildDiffIndices(lines: (DiffLine | null)[]): DiffIndices {
  const oldIndex = new Map<DiffLine, number>();
  const newIndex = new Map<DiffLine, number>();
  const oldTextLines: string[] = [];
  const newTextLines: string[] = [];
  for (const l of lines) {
    if (!l) continue;
    if (l.kind !== "added") {
      oldIndex.set(l, oldTextLines.length);
      oldTextLines.push(l.text);
    }
    if (l.kind !== "removed") {
      newIndex.set(l, newTextLines.length);
      newTextLines.push(l.text);
    }
  }
  return {
    oldIndex,
    newIndex,
    oldText: oldTextLines.join("\n"),
    newText: newTextLines.join("\n"),
  };
}

const EditDiff: Component<{ input: EditInput }> = (props) => {
  const lang = createMemo(() => langForFilename(props.input.file_path));
  const lines = createMemo(() =>
    withCollapsedContext(
      buildLineDiff(props.input.old_string, props.input.new_string),
    ),
  );
  const indices = createMemo(() => buildDiffIndices(lines()));

  const [highlighted] = createResource(
    () => ({ idx: indices(), lang: lang() }),
    async ({ idx, lang }) => {
      const hl = await ensureLang(lang);
      const oldText = idx.oldText;
      const newText = idx.newText;
      const safeLang = hl.getLoadedLanguages().includes(lang) ? lang : "text";
      try {
        const oldHtml = hl.codeToHtml(oldText, {
          lang: safeLang,
          theme: "github-dark",
        });
        const newHtml = hl.codeToHtml(newText, {
          lang: safeLang,
          theme: "github-dark",
        });
        return { oldRows: extractRows(oldHtml), newRows: extractRows(newHtml) };
      } catch {
        return null;
      }
    },
  );

  return (
    <div class="overflow-hidden rounded border border-border bg-bg-active/30 font-mono text-[12px]">
      <header class="flex items-center gap-2 border-b border-border bg-bg-elev px-3 py-1.5 text-[11px]">
        <span class="text-fg-muted">✎ edit</span>
        <span class="truncate text-fg" title={props.input.file_path}>
          {props.input.file_path}
        </span>
        <span class="ml-auto text-[10px] text-fg-faint">
          {props.input.replace_all ? "all matches" : "first match"}
        </span>
      </header>
      <div class="flex flex-col">
        <For each={lines()}>
          {(line) => (
            <DiffRow
              line={line}
              indices={indices()}
              highlighted={highlighted()}
            />
          )}
        </For>
      </div>
    </div>
  );
};

const DiffRow: Component<{
  line: DiffLine | null;
  indices: DiffIndices;
  highlighted: { oldRows: string[]; newRows: string[] } | null | undefined;
}> = (props) => {
  if (props.line === null) {
    return (
      <div class="px-3 py-0.5 text-center text-[10px] tracking-widest text-fg-faint">
        …
      </div>
    );
  }
  const line = props.line;
  const bgClass =
    line.kind === "added"
      ? "bg-success/10 border-l-2 border-l-success/60"
      : line.kind === "removed"
        ? "bg-danger/10 border-l-2 border-l-danger/60"
        : "border-l-2 border-l-transparent";
  const sigil =
    line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
  const sigilColor =
    line.kind === "added"
      ? "text-success"
      : line.kind === "removed"
        ? "text-danger"
        : "text-fg-faint";

  // O(1) Map lookup against the precomputed side buckets. The
  // previous code re-filtered `lines` per row AND walked each side
  // bucket with `[].indexOf` to find this exact reference — O(n²)
  // filters layered on O(n) indexOf, total O(n³) renders for a
  // single diff. For added lines we want the NEW-side row; for
  // removed/context we prefer OLD-side. Context exists on both
  // sides; shiki produces identical output for unchanged text so
  // the choice is cosmetic.
  let highlightedRow: string | null = null;
  if (props.highlighted) {
    if (line.kind === "removed" || line.kind === "context") {
      const idx = props.indices.oldIndex.get(line);
      if (idx !== undefined) {
        highlightedRow = props.highlighted.oldRows[idx] ?? null;
      }
    }
    if (line.kind === "added" || (line.kind === "context" && !highlightedRow)) {
      const idx = props.indices.newIndex.get(line);
      if (idx !== undefined) {
        highlightedRow = props.highlighted.newRows[idx] ?? null;
      }
    }
  }

  return (
    <div class={`flex ${bgClass}`}>
      <span class="w-10 select-none border-r border-border/40 px-1 py-0.5 text-right text-[10px] text-fg-faint">
        {line.oldLine ?? ""}
      </span>
      <span class="w-10 select-none border-r border-border/40 px-1 py-0.5 text-right text-[10px] text-fg-faint">
        {line.newLine ?? ""}
      </span>
      <span class={`w-4 select-none px-1 py-0.5 ${sigilColor}`}>{sigil}</span>
      <span class="flex-1 overflow-x-auto whitespace-pre py-0.5 pr-3">
        {highlightedRow ? (
          <span innerHTML={highlightedRow} />
        ) : (
          <span class="text-fg">{line.text || " "}</span>
        )}
      </span>
    </div>
  );
};

/**
 * Crack the shiki HTML output (`<pre><code>...<span class=line>...</span></code></pre>`)
 * into one HTML chunk per line. We need this because the diff renderer
 * reorders lines; we can't ship the raw shiki output as one block.
 */
function extractRows(html: string): string[] {
  // shiki emits `<span class="line">…</span>` per source line. Match
  // them tolerantly — the class attribute may contain extra tokens.
  const matches: string[] = [];
  const re = /<span class="line"[^>]*>([\s\S]*?)<\/span>(?=\s*(?:<span class="line"|<\/code>))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    matches.push(m[1] ?? "");
  }
  return matches;
}

const WriteFile: Component<{ input: WriteInput }> = (props) => {
  const lang = createMemo(() => langForFilename(props.input.file_path));
  const lines = createMemo(() => props.input.content.split("\n"));
  const [rendered] = createResource(
    () => ({ content: props.input.content, lang: lang() }),
    async ({ content, lang }) => {
      const hl = await ensureLang(lang);
      const safeLang = hl.getLoadedLanguages().includes(lang) ? lang : "text";
      try {
        const html = hl.codeToHtml(content, {
          lang: safeLang,
          theme: "github-dark",
        });
        return extractRows(html);
      } catch {
        return null;
      }
    },
  );
  return (
    <div class="overflow-hidden rounded border border-border bg-bg-active/30 font-mono text-[12px]">
      <header class="flex items-center gap-2 border-b border-border bg-bg-elev px-3 py-1.5 text-[11px]">
        <span class="text-success">+ write</span>
        <span class="truncate text-fg" title={props.input.file_path}>
          {props.input.file_path}
        </span>
        <span class="ml-auto text-[10px] text-fg-faint">
          {lines().length} line{lines().length === 1 ? "" : "s"}
        </span>
      </header>
      <div class="flex flex-col">
        <For each={lines()}>
          {(text, i) => (
            <div class="flex border-l-2 border-l-success/60 bg-success/10">
              <span class="w-10 select-none border-r border-border/40 px-1 py-0.5 text-right text-[10px] text-fg-faint">
                {i() + 1}
              </span>
              <span class="w-4 select-none px-1 py-0.5 text-success">+</span>
              <span class="flex-1 overflow-x-auto whitespace-pre py-0.5 pr-3">
                {rendered() && rendered()![i()] ? (
                  <span innerHTML={rendered()![i()]} />
                ) : (
                  <span class="text-fg">{text || " "}</span>
                )}
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

export { EditDiff, WriteFile };
