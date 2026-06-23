/**
 * File-system protocol handler — `fs.list` and `fs.read` verbs.
 *
 * Scoped strictly to a session's `workdir`. Every requested path is
 * resolved + canonicalised (`fs.realpath`), then prefix-checked against
 * the session's canonical workdir. Symlink escapes are blocked because
 * `realpath` follows them and we still verify the *resolved* path stays
 * inside.
 *
 * Read responses are UTF-8 by default; binary files (NUL byte detected
 * within the first 4 KiB) come back base64-encoded with
 * `encoding: "base64"` so frontends can decide whether to render them.
 *
 * Hard ceilings:
 *   - List: 5 000 entries returned per call (truncate with no marker —
 *     the user should narrow the path).
 *   - Read: per-call cap is `min(msg.maxBytes ?? DEFAULT, ABSOLUTE_MAX)`.
 *
 * The daemon's overall `fs:read` scope guards both verbs at the message
 * router; this module assumes scope was already enforced.
 */

import { promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  FsBrowseDirMsg,
  FsBrowseDirResultMsg,
  FsEntry,
  FsListMsg,
  FsListResultMsg,
  FsReadMsg,
  FsReadResultMsg,
} from "../protocol/types.js";

const DEFAULT_READ_BYTES = 1024 * 1024; // 1 MiB
const ABSOLUTE_MAX_READ_BYTES = 10 * 1024 * 1024; // 10 MiB hard ceiling
const MAX_LIST_ENTRIES = 5_000;
const BINARY_PROBE_BYTES = 4096;

/** Names hidden from list results unless explicitly enabled by the client. */
const DEFAULT_HIDDEN: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "__pycache__",
  ".DS_Store",
  ".idea",
  ".vscode",
  "target", // Rust
  "dist",
  "build",
  ".next",
  ".turbo",
]);

export class FsAccessError extends Error {
  constructor(
    message: string,
    public readonly code: "not_found" | "forbidden" | "invalid_request" | "internal",
  ) {
    super(message);
    this.name = "FsAccessError";
  }
}

/**
 * Resolve a user-supplied path (relative to workdir) into an absolute
 * canonical path that's guaranteed to live inside `workdir`. Throws
 * `FsAccessError` on traversal / symlink escapes.
 */
export async function resolveSafe(
  workdir: string,
  userPath: string,
): Promise<{ absolute: string; relative: string }> {
  // Canonicalise the workdir once. If the workdir itself doesn't exist
  // we can't host fs operations against it.
  let canonicalWorkdir: string;
  try {
    canonicalWorkdir = await fs.realpath(workdir);
  } catch {
    throw new FsAccessError(`workdir does not exist: ${workdir}`, "not_found");
  }

  const cleaned = userPath === "" || userPath === "/" ? "." : userPath;
  // path.resolve handles `..`, absolute paths, and Windows-style backslashes.
  const joined = path.resolve(canonicalWorkdir, cleaned);

  // realpath follows symlinks; an escape is detectable on the *resolved*
  // path. If the entry doesn't exist yet (e.g. listing a stale dir),
  // we still validate the parent so the answer is "not found" not
  // "forbidden".
  let resolved: string;
  try {
    resolved = await fs.realpath(joined);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new FsAccessError(`no such path: ${cleaned}`, "not_found");
    }
    throw new FsAccessError(
      `cannot resolve path: ${(err as Error).message}`,
      "internal",
    );
  }

  if (
    resolved !== canonicalWorkdir &&
    !resolved.startsWith(canonicalWorkdir + path.sep)
  ) {
    throw new FsAccessError(
      `path escapes session workdir: ${cleaned}`,
      "forbidden",
    );
  }

  const rel = path.relative(canonicalWorkdir, resolved) || ".";
  return { absolute: resolved, relative: rel };
}

export async function handleFsList(
  msg: Pick<FsListMsg, "id" | "path">,
  workdir: string,
): Promise<FsListResultMsg> {
  const { absolute, relative } = await resolveSafe(workdir, msg.path);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absolute);
  } catch (err) {
    throw new FsAccessError(
      `cannot stat: ${(err as Error).message}`,
      "internal",
    );
  }
  if (!stat.isDirectory()) {
    throw new FsAccessError(`not a directory: ${relative}`, "invalid_request");
  }

  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(absolute, { withFileTypes: true });
  } catch (err) {
    throw new FsAccessError(
      `cannot read directory: ${(err as Error).message}`,
      "internal",
    );
  }

  const out: FsEntry[] = [];
  for (const dirent of dirents) {
    if (out.length >= MAX_LIST_ENTRIES) break;
    if (DEFAULT_HIDDEN.has(dirent.name)) continue;
    const childAbs = path.join(absolute, dirent.name);
    const childRel = path.relative(
      await fs.realpath(workdir),
      childAbs,
    );
    let kind: "file" | "directory" = dirent.isDirectory() ? "directory" : "file";
    const isSymlink = dirent.isSymbolicLink();
    let size: number | undefined;
    let mtimeMs: number | undefined;
    try {
      const childStat = await fs.stat(childAbs);
      kind = childStat.isDirectory() ? "directory" : "file";
      if (kind === "file") size = childStat.size;
      mtimeMs = childStat.mtimeMs;
    } catch {
      // Stat failed (broken symlink, race) — keep the dirent's view.
    }
    out.push({
      name: dirent.name,
      path: childRel,
      kind,
      ...(size !== undefined ? { size } : {}),
      ...(mtimeMs !== undefined ? { mtimeMs } : {}),
      ...(isSymlink ? { isSymlink: true } : {}),
    });
  }

  // Stable sort: directories first, then files, alphabetic within each.
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    type: "fs.list.result",
    requestId: msg.id,
    path: relative,
    entries: out,
  };
}

export async function handleFsRead(
  msg: Pick<FsReadMsg, "id" | "path" | "maxBytes">,
  workdir: string,
): Promise<FsReadResultMsg> {
  const { absolute, relative } = await resolveSafe(workdir, msg.path);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absolute);
  } catch (err) {
    throw new FsAccessError(
      `cannot stat: ${(err as Error).message}`,
      "internal",
    );
  }
  if (stat.isDirectory()) {
    throw new FsAccessError(
      `is a directory: ${relative}`,
      "invalid_request",
    );
  }

  const cap = Math.max(
    1,
    Math.min(msg.maxBytes ?? DEFAULT_READ_BYTES, ABSOLUTE_MAX_READ_BYTES),
  );
  const truncated = stat.size > cap;

  let buf: Buffer;
  try {
    const handle = await fs.open(absolute, "r");
    try {
      const length = Math.min(stat.size, cap);
      const tmp = Buffer.alloc(length);
      const { bytesRead } = await handle.read(tmp, 0, length, 0);
      buf = tmp.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (err) {
    throw new FsAccessError(
      `cannot read file: ${(err as Error).message}`,
      "internal",
    );
  }

  const isBinary = looksBinary(buf);
  const language = detectLanguage(relative);

  return {
    type: "fs.read.result",
    requestId: msg.id,
    path: relative,
    content: isBinary ? buf.toString("base64") : buf.toString("utf-8"),
    encoding: isBinary ? "base64" : "utf-8",
    size: stat.size,
    truncated,
    ...(language ? { language } : {}),
  };
}

/**
 * Configured root for `fs.browse_dir`. The user picks workdirs for new
 * sessions from anywhere under this; the daemon rejects paths that
 * resolve outside.
 *
 * Default: the daemon process's HOME directory. Override via
 * `CODEOID_FS_BROWSE_ROOT` env var (e.g. `/workspaces` for a
 * containerised setup).
 */
function browseRoot(): string {
  const override = process.env.CODEOID_FS_BROWSE_ROOT;
  if (override && override.trim().length > 0) return override;
  return os.homedir();
}

export async function handleFsBrowseDir(
  msg: Pick<FsBrowseDirMsg, "id" | "path">,
): Promise<FsBrowseDirResultMsg> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(browseRoot());
  } catch {
    throw new FsAccessError(
      `browse root does not exist: ${browseRoot()}`,
      "internal",
    );
  }

  const requested = msg.path && msg.path.trim().length > 0 ? msg.path : canonicalRoot;
  // path.resolve handles relative-to-root + absolute paths uniformly.
  const joined = path.isAbsolute(requested)
    ? requested
    : path.resolve(canonicalRoot, requested);

  let resolved: string;
  try {
    resolved = await fs.realpath(joined);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new FsAccessError(`no such path: ${requested}`, "not_found");
    }
    throw new FsAccessError(
      `cannot resolve path: ${(err as Error).message}`,
      "internal",
    );
  }

  if (
    resolved !== canonicalRoot &&
    !resolved.startsWith(canonicalRoot + path.sep)
  ) {
    throw new FsAccessError(
      `path escapes browse root (${canonicalRoot}): ${requested}`,
      "forbidden",
    );
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    throw new FsAccessError(
      `cannot stat: ${(err as Error).message}`,
      "internal",
    );
  }
  if (!stat.isDirectory()) {
    throw new FsAccessError(`not a directory: ${requested}`, "invalid_request");
  }

  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(resolved, { withFileTypes: true });
  } catch (err) {
    throw new FsAccessError(
      `cannot read directory: ${(err as Error).message}`,
      "internal",
    );
  }

  const out: FsEntry[] = [];
  for (const dirent of dirents) {
    if (out.length >= MAX_LIST_ENTRIES) break;
    if (DEFAULT_HIDDEN.has(dirent.name)) continue;
    if (dirent.name.startsWith(".")) continue; // hide all dotfiles in browse mode
    const childAbs = path.join(resolved, dirent.name);
    const isSymlink = dirent.isSymbolicLink();
    let isDirectory = dirent.isDirectory();
    let mtimeMs: number | undefined;
    try {
      const childStat = await fs.stat(childAbs);
      isDirectory = childStat.isDirectory();
      mtimeMs = childStat.mtimeMs;
    } catch {
      // Broken symlink or race — keep dirent's view.
    }
    if (!isDirectory) continue; // browse mode = directories only
    out.push({
      name: dirent.name,
      path: childAbs, // ABSOLUTE here so client can dispatch directly
      kind: "directory",
      ...(mtimeMs !== undefined ? { mtimeMs } : {}),
      ...(isSymlink ? { isSymlink: true } : {}),
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));

  const parent =
    resolved === canonicalRoot ? null : path.dirname(resolved);

  return {
    type: "fs.browse_dir.result",
    requestId: msg.id,
    path: resolved,
    root: canonicalRoot,
    parent,
    entries: out,
  };
}

// ---------- helpers ----------

function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, Math.min(buf.length, BINARY_PROBE_BYTES));
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) return true;
  }
  return false;
}

/**
 * Cheap language hint from the file extension. Matches what shiki accepts
 * as a `lang` value. Unknown extensions return undefined — the client
 * renders as plain text.
 */
function detectLanguage(filePath: string): string | undefined {
  const base = path.basename(filePath).toLowerCase();
  // Filename match wins over extension for things like Dockerfile / Makefile.
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "make";
  if (base === ".gitignore" || base === ".dockerignore") return "ignore";
  const ext = path.extname(base).slice(1);
  return EXT_TO_LANG[ext];
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "jsonc",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  rs: "rust",
  go: "go",
  py: "python",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  md: "md",
  mdx: "mdx",
  html: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
  graphql: "graphql",
  proto: "proto",
  hcl: "hcl",
  tf: "hcl",
  dockerfile: "dockerfile",
  ini: "ini",
  xml: "xml",
  vue: "vue",
  svelte: "svelte",
  lua: "lua",
  zig: "zig",
};
