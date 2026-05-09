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

/**
 * Lazy per-language loader.
 *
 * The previous setup created the shiki highlighter with every
 * supported grammar pre-loaded — 24 languages worth, each pulling its
 * own TextMate JSON via dynamic imports that Vite eagerly bundled
 * into the initial chunk. Total cost was hundreds of KB of JS the
 * user paid for on first paint even when the only thing they were
 * looking at was a Bash diff.
 *
 * Instead we keep ONE highlighter, instantiated on first call with
 * just the theme, and lazily `loadLanguage()` each grammar the first
 * time it's needed. Most sessions touch 2-4 langs; subsequent diffs
 * for the same lang hit the cache directly. `loadedLangs` is the
 * dedup set so we only fire `loadLanguage` once per id even under
 * concurrent calls (the second caller just `await`s the cached
 * Promise via the Map).
 */
let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Map<string, Promise<void>>();

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({ themes: [SHIKI_THEME], langs: [] }),
    );
  }
  return highlighterPromise;
}

/**
 * Ensure `lang` is registered with the highlighter before calling
 * `codeToHtml({ lang })`. Pass-through for `"text"` (shiki has it
 * built-in). Returns the highlighter so call sites can chain.
 */
export async function ensureLang(lang: string): Promise<Highlighter> {
  const hl = await getHighlighter();
  if (lang === "text" || lang === "plaintext") return hl;
  if (hl.getLoadedLanguages().includes(lang)) return hl;
  let p = loadedLangs.get(lang);
  if (!p) {
    p = hl.loadLanguage(lang as never).then(
      () => undefined,
      (err) => {
        // If the lang id is unknown to shiki, drop the cache entry so
        // we don't keep a rejected promise around poisoning future
        // calls. Returning undefined lets call sites fall through to
        // the "text" path.
        loadedLangs.delete(lang);
        // eslint-disable-next-line no-console
        console.warn(`[codeoid] shiki loadLanguage(${lang}) failed`, err);
      },
    );
    loadedLangs.set(lang, p);
  }
  await p;
  return hl;
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
