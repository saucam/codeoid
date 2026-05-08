/**
 * Shared shiki highlighter — singleton + small lang inference helper.
 *
 * Both `FileViewer` and `DiffBlock` need syntax highlighting. Loading
 * shiki twice doubles the bundle weight (and the WASM init cost), so
 * the highlighter lives here as a single Promise, lazy-instantiated on
 * first call and reused for the rest of the session.
 *
 * The lang list mirrors what we ship in the daemon's content-type
 * inference; if the daemon ever surfaces a language outside this list,
 * fall back to plain text rather than letting shiki throw.
 */
import type { Highlighter } from "shiki";

export const SHIKI_THEME = "github-dark";

const SHIKI_LANGS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "yaml",
  "toml",
  "rust",
  "go",
  "python",
  "ruby",
  "java",
  "c",
  "cpp",
  "csharp",
  "bash",
  "md",
  "html",
  "css",
  "scss",
  "sql",
  "graphql",
  "dockerfile",
  "ini",
  "xml",
];

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({ themes: [SHIKI_THEME], langs: SHIKI_LANGS }),
    );
  }
  return highlighterPromise;
}

/**
 * Best-effort filename → shiki lang id. Returns `"text"` (no
 * highlighting) for anything we don't recognise — shiki accepts that
 * verbatim and just renders plain text.
 */
export function langForFilename(path: string | undefined): string {
  if (!path) return "text";
  const lower = path.toLowerCase();
  // Filenames whose shape (not extension) determines the language.
  if (lower.endsWith(".dockerfile") || lower.endsWith("/dockerfile")) return "dockerfile";
  if (lower.endsWith("makefile") || lower.endsWith(".mk")) return "bash";

  const ext = lower.split(".").pop() ?? "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return "ts";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "js";
    case "jsx":
      return "jsx";
    case "json":
    case "jsonc":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
      return "toml";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "py":
      return "python";
    case "rb":
      return "ruby";
    case "java":
      return "java";
    case "c":
    case "h":
      return "c";
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
      return "cpp";
    case "cs":
      return "csharp";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "md":
    case "markdown":
      return "md";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "scss":
    case "sass":
      return "scss";
    case "sql":
      return "sql";
    case "graphql":
    case "gql":
      return "graphql";
    case "ini":
    case "conf":
      return "ini";
    case "xml":
      return "xml";
    default:
      return "text";
  }
}
