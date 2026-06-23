/**
 * OSC-8 hyperlink helper — wraps text in the ANSI OSC-8 escape sequence so
 * supporting terminals (WezTerm, Kitty, iTerm2, VS Code terminal, Alacritty,
 * GNOME Terminal / VTE) render it as a clickable link. On unsupported
 * terminals the raw escapes are invisible — the label text still renders,
 * so there's no visible regression.
 *
 * Wire format:
 *   ESC ] 8 ; ; <uri> ESC \ <label> ESC ] 8 ; ; ESC \
 */

import { isAbsolute, resolve as resolvePath } from "node:path";

const ESC = "\x1b";
const BEL = "\x07";

/**
 * Wrap `label` as an OSC-8 hyperlink pointing at `uri`. On terminals without
 * support, the escapes are ignored and the user just sees `label` — so calling
 * this unconditionally is safe. `supportsOsc8()` lets the caller short-circuit
 * when rendering a lot of text.
 */
export function osc8(uri: string, label: string): string {
  if (!uri) return label;
  // Terminator: ESC \ is the documented ST (String Terminator). BEL (0x07)
  // is an older but more widely-honored alternative. We use BEL because
  // several terminals (notably macOS Terminal.app forks) mis-parse ST.
  return `${ESC}]8;;${uri}${BEL}${label}${ESC}]8;;${BEL}`;
}

/**
 * Build a `file://` URI for a filesystem path, resolving relative paths
 * against `baseDir` when provided. Editors registered for `file://` URIs
 * (VS Code, Cursor, IntelliJ) open the file on click.
 */
export function fileUri(path: string, baseDir?: string): string {
  const abs = isAbsolute(path) ? path : baseDir ? resolvePath(baseDir, path) : path;
  // Encode the path component properly — spaces, non-ASCII, etc. File URIs
  // use the host-less form `file:///abs/path` on POSIX. We don't split the
  // segments to preserve characters like "~" that some editors want raw.
  const normalized = abs.startsWith("/") ? abs : `/${abs}`;
  return `file://${encodeURI(normalized).replace(/#/g, "%23")}`;
}

/**
 * Detect whether the current terminal is known to honor OSC-8 hyperlinks.
 * Errs on the side of "yes" for well-known good terminals; falls back to
 * "no" when we can't tell (raw escapes would still be harmless but the
 * user might see confused underline styling on very old terminals).
 */
export function supportsOsc8(): boolean {
  if (process.env.CODEOID_DISABLE_OSC8) return false;
  if (process.env.CODEOID_FORCE_OSC8) return true;
  if (!process.stdout.isTTY) return false;

  const termProgram = process.env.TERM_PROGRAM;
  if (termProgram) {
    const known = new Set([
      "WezTerm",
      "iTerm.app",
      "vscode",
      "Cursor",
      "Ghostty",
      "Tabby",
      "rio",
      "Hyper",
    ]);
    if (known.has(termProgram)) return true;
    // Apple_Terminal renders OSC-8 only on recent macOS builds; be cautious.
    if (termProgram === "Apple_Terminal") return false;
  }

  // Kitty advertises itself via KITTY_WINDOW_ID.
  if (process.env.KITTY_WINDOW_ID) return true;
  if (process.env.TERM === "xterm-kitty") return true;

  // Alacritty exposes ALACRITTY_LOG / ALACRITTY_WINDOW_ID (support is recent
  // but on by default).
  if (process.env.ALACRITTY_LOG || process.env.ALACRITTY_WINDOW_ID) {
    return true;
  }

  // VTE-based terminals (GNOME Terminal, Tilix, Terminator) set VTE_VERSION.
  // OSC-8 support landed in VTE 0.50 (2017). Anything modern enough to run
  // this CLI is fine.
  if (process.env.VTE_VERSION) return true;

  // ConEmu / Windows Terminal.
  if (process.env.WT_SESSION) return true;

  return false;
}

/** Convenience — OSC-8-wrap iff the terminal supports it, else pass through. */
export function maybeLink(uri: string, label: string): string {
  return supportsOsc8() ? osc8(uri, label) : label;
}
