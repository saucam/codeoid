/**
 * Low-level ANSI primitives for the scrollback renderer.
 *
 * This module is the only place we talk to the terminal in bytes. Everything
 * else in `src/tui/ansi/` composes strings out of these. Keeping the vocab
 * narrow (SGR codes, OSC8, reset) makes the renderer testable and avoids
 * spreading terminal quirks across every message type.
 *
 * Production-grade concerns handled here:
 *   - `NO_COLOR` / non-TTY → downgrade to plain text (no SGR escapes at all)
 *   - `TERM=dumb` → same
 *   - Always emit SGR reset at the end of every styled run so color never
 *     bleeds into subsequent writes (e.g. the live region below)
 *   - Explicit escape detection via regex — we don't rely on a polyfill
 *   - East-asian wide-char width via a small lookup (enough for emoji + CJK
 *     in tool paths and assistant content; not trying to be a full Unicode
 *     width library — that lives in `string-width` if we ever need it)
 */

const ESC = "\x1b";
const CSI = `${ESC}[`;

/** SGR (Select Graphic Rendition) parameters we use. */
export const SGR = {
	reset: 0,
	bold: 1,
	dim: 2,
	italic: 3,
	underline: 4,
	inverse: 7,
	// Foreground colors (30-37 standard, 90-97 bright).
	black: 30,
	red: 31,
	green: 32,
	yellow: 33,
	blue: 34,
	magenta: 35,
	cyan: 36,
	white: 37,
	gray: 90,
	brightRed: 91,
	brightGreen: 92,
	brightYellow: 93,
	brightBlue: 94,
	brightMagenta: 95,
	brightCyan: 96,
	brightWhite: 97,
	// Default foreground — resets only the fg channel (leaves bold etc.).
	defaultFg: 39,
} as const;

export type SgrKey = keyof typeof SGR;

/**
 * Whether the current environment supports color. Honors `NO_COLOR`
 * (https://no-color.org) and `TERM=dumb`. We default to "yes" when stdout
 * is a TTY because the overwhelming majority of modern terminals handle
 * 16-color SGR without issue — same assumption Ink itself makes.
 */
export function supportsColor(): boolean {
	if (process.env.NO_COLOR) return false;
	if (process.env.CODEOID_NO_COLOR) return false;
	if (process.env.TERM === "dumb") return false;
	if (process.env.FORCE_COLOR) return true;
	// isTTY is false when piped (e.g. `codeoid | tee`). Preserve scrollback by
	// stripping color there — users piping to files don't want escape soup.
	return Boolean(process.stdout.isTTY);
}

/**
 * Wrap `text` in SGR codes. When `supportsColor()` is false, returns the
 * bare text. We always close with `SGR.reset` (0) to prevent any style
 * leaking into the next write — even partial leaks break Ink's live region
 * when it redraws on top of the leaked state.
 */
export function sgr(text: string, ...styles: SgrKey[]): string {
	if (!text) return text;
	if (styles.length === 0) return text;
	if (!supportsColor()) return text;
	const codes = styles.map((s) => SGR[s]).join(";");
	return `${CSI}${codes}m${text}${CSI}${SGR.reset}m`;
}

/** Convenience: common single-style wrappers. */
export const bold = (t: string) => sgr(t, "bold");
export const dim = (t: string) => sgr(t, "dim");
export const italic = (t: string) => sgr(t, "italic");
export const underline = (t: string) => sgr(t, "underline");
export const red = (t: string) => sgr(t, "red");
export const green = (t: string) => sgr(t, "green");
export const yellow = (t: string) => sgr(t, "yellow");
export const blue = (t: string) => sgr(t, "blue");
export const magenta = (t: string) => sgr(t, "magenta");
export const cyan = (t: string) => sgr(t, "cyan");
export const gray = (t: string) => sgr(t, "gray");

/** Regex that matches any CSI SGR sequence we or anyone else emits. */
const ANSI_SGR = /\x1b\[[0-9;]*m/g;
/** Regex for OSC sequences terminated by BEL or ST (ESC \). */
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Strip all ANSI escape sequences — useful for width math and tests. */
export function stripAnsi(s: string): string {
	return s.replace(ANSI_OSC, "").replace(ANSI_SGR, "");
}

// ── Untrusted-content sanitizer ───────────────────────────────────────────────
//
// `stripAnsi` removes ALL escapes (for width math). The security sanitizer below
// does the opposite trade-off: it removes only the escape sequences that let
// UNTRUSTED content (model output, tool stdout, file contents, streamed deltas)
// *act on* the user's terminal, while preserving the SGR color/style and OSC-8
// hyperlinks that our own renderer emits — so styled scrollback still renders.

/** OSC sequences other than OSC-8 hyperlinks: clipboard write (52), window /
 * icon title (0/1/2), and any other `ESC ] <cmd> ; … (BEL | ST)`. OSC-8
 * (`ESC ] 8 ; …`, emitted by `osc8.ts`) is preserved via the negative lookahead. */
const ANSI_OSC_NON8 = /\x1b\](?!8[;\x07\x1b])[^\x07\x1b]*(?:\x07|\x1b\\)?/g;
/** DCS / APC / PM / SOS device-control strings: `ESC (P|_|^|X) … (ST)?`. */
const ANSI_DEVICE_CTRL = /\x1b[P_^X][^\x1b]*(?:\x1b\\)?/g;
/** CSI sequences other than SGR — cursor moves, screen clears, mode sets. The
 * final byte is anything in `@`…`~` EXCEPT `m` (0x6d), which is SGR and stays. */
const ANSI_CSI_NON_SGR = /\x1b\[[0-?]*[ -/]*[@-ln-~]/g;
/** Any other single-char `ESC` sequence (charset select, full reset, keypad…),
 * but never `ESC [` (CSI/SGR) or `ESC ]` (OSC/OSC-8), which are handled above. */
const ANSI_ESC_OTHER = /\x1b[^[\]]/g;
/** C0 control bytes that must not reach the terminal from untrusted content.
 * Excludes TAB (09), LF (0a), CR (0d), ESC (1b), and BEL (07). ESC is consumed
 * by the sequence rules above so SGR / OSC-8 introducers survive; BEL is the
 * OSC terminator (kept so preserved OSC-8 links stay intact — a lone BEL only
 * rings the terminal bell). */
const C0_UNSAFE = /[\x00-\x06\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

/**
 * Neutralize terminal control sequences embedded in UNTRUSTED content before it
 * is written to the TTY. Removes clipboard writes (OSC 52), title spoofing
 * (OSC 0/1/2), cursor/screen manipulation (non-SGR CSI), and device-control
 * strings (DCS/APC/PM/SOS); preserves SGR color/style and OSC-8 hyperlinks that
 * the renderer itself emits. Newlines, tabs, and carriage returns survive; other
 * C0 controls do not.
 *
 * Apply at every boundary where model/tool bytes reach the terminal. Preserving
 * OSC-8 keeps our clickable file links working; an OSC-8 link smuggled through
 * untrusted content survives as a (low-severity) residual — see SECURITY.md.
 */
export function sanitizeTerminalOutput(s: string): string {
	if (!s) return s;
	return s
		.replace(ANSI_OSC_NON8, "")
		.replace(ANSI_DEVICE_CTRL, "")
		.replace(ANSI_CSI_NON_SGR, "")
		.replace(ANSI_ESC_OTHER, "")
		// A dangling escape introducer at end-of-chunk (lone `ESC`, or `ESC [`
		// with params/intermediates but no final byte) would otherwise be
		// completed by the first bytes of the NEXT write — strip it too.
		.replace(/\x1b\[?[0-?]*[ -/]*$/, "")
		.replace(C0_UNSAFE, "");
}

/**
 * East-asian wide ranges (subset — enough for CJK + common emoji blocks).
 * A full table is huge; this covers the 99%+ case for code/docs/chat text.
 * Returns 2 for wide, 1 for normal, 0 for zero-width (combining marks).
 */
function charWidth(cp: number): 0 | 1 | 2 {
	if (cp === 0) return 0;
	// C0 / C1 control — not displayable as single columns; treat as 0.
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	// Zero-width: combining marks, ZWJ, ZWNJ, variation selectors.
	if (
		(cp >= 0x0300 && cp <= 0x036f) ||
		(cp >= 0x200b && cp <= 0x200f) ||
		(cp >= 0xfe00 && cp <= 0xfe0f) ||
		cp === 0x200d ||
		cp === 0x2060
	) {
		return 0;
	}
	// Wide: CJK, hangul, emoji pictographs, fullwidth forms.
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x33ff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f680 && cp <= 0x1f6ff) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x2fffd) ||
		(cp >= 0x30000 && cp <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

/**
 * Display width of a string in terminal columns, after stripping ANSI.
 * Not Unicode-complete but covers the strings we actually emit (paths,
 * prose, tool names, emoji indicators). Used for wrap decisions.
 */
export function displayWidth(s: string): number {
	const plain = stripAnsi(s);
	let w = 0;
	for (const ch of plain) {
		w += charWidth(ch.codePointAt(0) ?? 0);
	}
	return w;
}

/**
 * Soft-wrap a single line of ANSI-styled text to `cols` columns.
 *
 * Preserves SGR styling across wrap boundaries by re-opening the active
 * style after each inserted newline. Wide chars count as 2 cols. We try
 * to break at the last space before the column limit; if the line has
 * no spaces (e.g. a long path) we hard-break at the column.
 *
 * Returns an array of lines (no trailing newlines). Callers join with
 * `\n` or emit one-per-write as appropriate.
 */
export function wrapLine(line: string, cols: number): string[] {
	if (cols <= 0 || displayWidth(line) <= cols) return [line];
	// Tokenize into runs of (optional-SGR-prefix, grapheme). We don't re-open
	// style on wrap for now — keeping the implementation simple. SGR always
	// ends with a reset anyway (see `sgr()`), so there's no leak risk; the
	// worst case is a wrapped styled run losing its color on the continuation
	// line. Acceptable for a v1; revisit if we see ugly cases in the wild.
	const out: string[] = [];
	let cur = "";
	let curW = 0;
	const tokens = tokenize(line);
	for (const tok of tokens) {
		if (tok.width === 0) {
			// ANSI escape — keep grouped with next visible char (adds no width).
			cur += tok.text;
			continue;
		}
		if (curW + tok.width > cols) {
			// Try a soft break at the last whitespace within `cur`.
			const breakAt = cur.lastIndexOf(" ");
			if (breakAt > 0 && breakAt > curW - cols) {
				out.push(cur.slice(0, breakAt));
				cur = cur.slice(breakAt + 1);
				curW = displayWidth(cur);
			} else {
				out.push(cur);
				cur = "";
				curW = 0;
			}
		}
		cur += tok.text;
		curW += tok.width;
	}
	if (cur) out.push(cur);
	return out.length ? out : [line];
}

/** Break a string into ANSI-escape + visible-char tokens for width math. */
function tokenize(s: string): Array<{ text: string; width: number }> {
	const out: Array<{ text: string; width: number }> = [];
	let i = 0;
	while (i < s.length) {
		// ANSI SGR
		if (s[i] === ESC && s[i + 1] === "[") {
			const end = s.indexOf("m", i + 2);
			if (end > 0) {
				out.push({ text: s.slice(i, end + 1), width: 0 });
				i = end + 1;
				continue;
			}
		}
		// OSC (for OSC8 hyperlinks)
		if (s[i] === ESC && s[i + 1] === "]") {
			// Find terminator: BEL or ESC \
			let end = s.length;
			for (let j = i + 2; j < s.length; j++) {
				const c = s[j];
				if (c === "\x07") {
					end = j + 1;
					break;
				}
				if (c === ESC && s[j + 1] === "\\") {
					end = j + 2;
					break;
				}
			}
			out.push({ text: s.slice(i, end), width: 0 });
			i = end;
			continue;
		}
		// Regular char (handle surrogate pairs via codepoint iteration).
		const cp = s.codePointAt(i);
		if (cp === undefined) break;
		const len = cp > 0xffff ? 2 : 1;
		out.push({ text: s.slice(i, i + len), width: charWidth(cp) });
		i += len;
	}
	return out;
}

/**
 * Global SGR reset string. Emit this at the end of any sequence of writes
 * that could be interrupted (e.g. before yielding to Ink's render). Safe
 * to call unconditionally — degrades to empty string when color is off.
 */
export function resetAll(): string {
	if (!supportsColor()) return "";
	return `${CSI}${SGR.reset}m`;
}
