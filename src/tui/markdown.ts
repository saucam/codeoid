/**
 * Minimal markdown → terminal renderer. Handles the 80% of markdown we see in
 * assistant responses without pulling in a full parser:
 *
 *   - ATX headings (#, ##, ###)
 *   - Fenced code blocks (``` or ~~~)
 *   - Inline code (`code`)
 *   - Bold (**x** or __x__), italic (*x* or _x_)
 *   - Unordered lists (- and *), ordered lists (1. 2.)
 *   - Blockquotes (>)
 *   - Horizontal rules (---, ___)
 *
 * Output is a list of `Segment`s: a plain string plus optional ANSI style
 * hints. Consumers (Transcript) turn these into Ink <Text> elements with the
 * appropriate color/bold/dim props.
 */

export type SegmentStyle =
  | "plain"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bold"
  | "italic"
  | "code-inline"
  | "code-block"
  | "list-bullet"
  | "list-number"
  | "quote"
  | "rule"
  | "link";

export interface Segment {
  style: SegmentStyle;
  text: string;
  /** For list items — indent depth in spaces. */
  indent?: number;
  /** For ordered lists — the number prefix ("1.", "2."). */
  prefix?: string;
}

/** Render markdown as a sequence of segments, one per visual line/span. */
export function renderMarkdown(md: string): Segment[][] {
  const lines = md.split("\n");
  const out: Segment[][] = [];
  let inCode: { lang: string; body: string[] } | null = null;

  for (const raw of lines) {
    if (inCode) {
      if (/^\s*(```|~~~)\s*$/.test(raw)) {
        // Close code block — emit each body line as a code-block segment.
        for (const body of inCode.body) {
          out.push([{ style: "code-block", text: body }]);
        }
        inCode = null;
      } else {
        inCode.body.push(raw);
      }
      continue;
    }

    const fence = /^(\s*)(```|~~~)\s*(\w*)/.exec(raw);
    if (fence) {
      inCode = { lang: fence[3] ?? "", body: [] };
      continue;
    }

    const trimmed = raw.replace(/\s+$/, "");

    // Horizontal rule.
    if (/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/.test(trimmed)) {
      out.push([{ style: "rule", text: "" }]);
      continue;
    }

    // Headings.
    const h = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (h) {
      const level = h[1]!.length;
      const styleKey = level === 1 ? "heading1" : level === 2 ? "heading2" : "heading3";
      out.push([{ style: styleKey, text: h[2]! }]);
      continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(trimmed)) {
      out.push([{ style: "quote", text: trimmed.replace(/^\s*>\s?/, "") }]);
      continue;
    }

    // Ordered list.
    const ol = /^(\s*)(\d+)\.\s+(.*)$/.exec(raw);
    if (ol) {
      out.push([
        {
          style: "list-number",
          text: ol[3]!,
          indent: ol[1]!.length,
          prefix: `${ol[2]}. `,
        },
        ...inline(ol[3]!, raw),
      ]);
      // Replace the plain head with the parsed inline variant:
      out[out.length - 1] = [
        {
          style: "list-number",
          text: "",
          indent: ol[1]!.length,
          prefix: `${ol[2]}. `,
        },
        ...inline(ol[3]!),
      ];
      continue;
    }

    // Unordered list.
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (ul) {
      out.push([
        { style: "list-bullet", text: "", indent: ul[1]!.length, prefix: "• " },
        ...inline(ul[2]!),
      ]);
      continue;
    }

    // Plain paragraph line with inline formatting.
    out.push(inline(trimmed));
  }

  // Unclosed fence — dump what we collected as code.
  if (inCode) {
    for (const body of inCode.body) {
      out.push([{ style: "code-block", text: body }]);
    }
  }

  return out;
}

/** Parse inline formatting (bold, italic, inline code, links). */
export function inline(text: string, _raw?: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let buf = "";

  const flush = () => {
    if (buf) {
      out.push({ style: "plain", text: buf });
      buf = "";
    }
  };

  while (i < text.length) {
    // Inline code.
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ style: "code-inline", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Bold **x** or __x__.
    if (text.startsWith("**", i) || text.startsWith("__", i)) {
      const marker = text.slice(i, i + 2);
      const end = text.indexOf(marker, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ style: "bold", text: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    // Italic *x* or _x_ (single char marker, not inside of bold).
    if ((text[i] === "*" || text[i] === "_") && text[i + 1] !== text[i]) {
      const marker = text[i]!;
      const end = text.indexOf(marker, i + 1);
      if (
        end > i + 1 &&
        // Avoid matching ** as italic (already handled above).
        text[end + 1] !== marker
      ) {
        flush();
        out.push({ style: "italic", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Markdown link [text](url) — render as "text (url)".
    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd > close + 2) {
          flush();
          out.push({
            style: "link",
            text: `${text.slice(i + 1, close)} (${text.slice(close + 2, urlEnd)})`,
          });
          i = urlEnd + 1;
          continue;
        }
      }
    }

    buf += text[i];
    i++;
  }

  flush();
  return out;
}
