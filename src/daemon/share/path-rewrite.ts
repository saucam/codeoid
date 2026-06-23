/**
 * Path encoding/decoding for shareable bundles.
 *
 *   encode(absolutePath, workdir, alias) →
 *      `${alias}/${relative}`         when the path is under workdir
 *      `<external>/${absolutePath}`   otherwise (preserved verbatim)
 *
 *   decode(encodedPath, alias, targetWorkdir) →
 *      `${targetWorkdir}/${relative}` when prefix matches alias
 *      original absolute path         when prefixed `<external>/`
 *      passthrough                    otherwise (forward-compat)
 *
 * Pure helpers — every step has a unit test. Only function imports
 * `node:path` so we can test against POSIX semantics deterministically.
 */

import path from "node:path";

export const EXTERNAL_PREFIX = "<external>/";

/**
 * Encode `absolute` against `workdir` using `alias` as the cross-
 * machine label. Treats path equality at the canonical-string level —
 * symlink resolution is the caller's job (we don't want to hit the
 * filesystem during a packing pass).
 */
export function encodePath(
  absolute: string,
  workdir: string,
  alias: string,
): string {
  if (!absolute) return absolute;
  const norm = canonicalPosix(absolute);
  const wd = canonicalPosix(workdir).replace(/\/$/, "");
  if (norm === wd) return alias;
  if (wd.length > 0 && norm.startsWith(`${wd}/`)) {
    return `${alias}/${norm.slice(wd.length + 1)}`;
  }
  // Absolute path outside workdir — preserve verbatim with the
  // <external>/ marker so importers can still surface it.
  if (path.isAbsolute(norm)) {
    return `${EXTERNAL_PREFIX}${norm.replace(/^\/+/, "")}`;
  }
  // Relative paths get tagged as alias-relative (rare; tools usually emit absolute).
  return `${alias}/${norm}`;
}

/**
 * Decode `encoded` against `alias` and `targetWorkdir`. Inverse of
 * `encodePath`. Bare passthrough when the prefix doesn't match either
 * the alias or `<external>/` — preserves forward-compat.
 */
export function decodePath(
  encoded: string,
  alias: string,
  targetWorkdir: string,
): string {
  if (!encoded) return encoded;

  if (encoded.startsWith(EXTERNAL_PREFIX)) {
    return `/${encoded.slice(EXTERNAL_PREFIX.length).replace(/^\/+/, "")}`;
  }
  if (encoded === alias) return canonicalPosix(targetWorkdir).replace(/\/$/, "");
  if (encoded.startsWith(`${alias}/`)) {
    const rel = encoded.slice(alias.length + 1);
    const wd = canonicalPosix(targetWorkdir).replace(/\/$/, "");
    return `${wd}/${rel}`;
  }
  return encoded;
}

export function encodePathArray(
  paths: readonly string[],
  workdir: string,
  alias: string,
): string[] {
  return paths.map((p) => encodePath(p, workdir, alias));
}

export function decodePathArray(
  paths: readonly string[],
  alias: string,
  targetWorkdir: string,
): string[] {
  return paths.map((p) => decodePath(p, alias, targetWorkdir));
}

/**
 * Replace inline absolute path references inside arbitrary text
 * (tool outputs, message content). Best-effort — substitutes literal
 * matches of `workdir` with `alias` and tags external absolute paths.
 *
 * Conservative: only rewrites literal absolute paths starting with `/`
 * that prefix-match `workdir`. Doesn't try to fix paths that contain
 * env-expanded vars, cwd-relative paths, or paths without a leading
 * slash — false-positive risk too high.
 */
export function rewriteTextPaths(
  text: string,
  workdir: string,
  alias: string,
): string {
  if (!text) return text;
  const wd = canonicalPosix(workdir).replace(/\/$/, "");
  if (wd.length === 0) return text;
  // Word-boundary-ish: don't rewrite `/home/yash/Workspace/codeoid` if
  // it's a prefix of `/home/yash/Workspace/codeoid-ui`. Require the
  // next char (when present) to be `/`, end-of-line, or whitespace.
  return splitReplace(text, wd, (next) => {
    if (next === "" || next === "/" || /\s/.test(next)) {
      return alias + (next === "/" ? "" : "");
    }
    return null; // not a real prefix — leave alone
  });
}

/**
 * Inverse of `rewriteTextPaths`: substitutes the alias prefix with the
 * target workdir. Used by the importer when materialising tool output
 * into the new session's transcript.
 */
export function restoreTextPaths(
  text: string,
  alias: string,
  targetWorkdir: string,
): string {
  if (!text) return text;
  return splitReplace(text, alias, (next) => {
    if (next === "" || next === "/" || /\s/.test(next)) {
      return canonicalPosix(targetWorkdir).replace(/\/$/, "") + (next === "/" ? "" : "");
    }
    return null;
  });
}

// ---------- helpers ----------

function canonicalPosix(p: string): string {
  // Normalise without touching the filesystem. Collapses `//` and
  // resolves `.` segments. Leaves `..` alone — caller passes already-
  // canonical paths.
  return p.replace(/\/+/g, "/");
}

/**
 * Replace every occurrence of `needle` in `text` with whatever
 * `replacer` returns based on the next character. Returning `null`
 * leaves the occurrence untouched. Avoids regex pitfalls around
 * special characters in workdir paths.
 */
function splitReplace(
  text: string,
  needle: string,
  replacer: (next: string) => string | null,
): string {
  if (!needle) return text;
  let i = 0;
  const out: string[] = [];
  while (i < text.length) {
    const idx = text.indexOf(needle, i);
    if (idx < 0) {
      out.push(text.slice(i));
      break;
    }
    out.push(text.slice(i, idx));
    const next = text.charAt(idx + needle.length);
    const rep = replacer(next);
    if (rep == null) {
      out.push(needle);
    } else {
      out.push(rep);
    }
    i = idx + needle.length;
  }
  return out.join("");
}
