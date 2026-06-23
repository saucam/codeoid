/**
 * Attachment resolver — reads attachment files from disk, enforces size +
 * content limits, and flattens a list of attachments into a prompt prefix
 * formatted as `<file path="...">...</file>` blocks that Claude is tuned to
 * pay attention to.
 *
 * Failures (missing file, oversize, binary, unreadable) surface inline as
 * `<file error="..." path="...">` markers rather than silently dropping —
 * Claude sees WHY an attachment wasn't usable and can tell the user.
 */

import {
  statSync,
  readFileSync,
  accessSync,
  constants,
  mkdirSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, resolve as resolvePath, join as joinPath, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { Attachment } from "../protocol/types.js";

/** Hard cap per individual attachment (bytes). 100 KB for text, 2 MB for binary. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024;
/** Hard cap per binary (image/PDF) attachment — generous enough for screenshots. */
export const MAX_BINARY_ATTACHMENT_BYTES = 2 * 1024 * 1024;
/** Hard cap on total attachment bytes per turn. 500 KB. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 500 * 1024;
/** First N bytes inspected to detect binary content. */
const BINARY_SNIFF_BYTES = 1024;
/** Subdirectory under the session workdir where binary payloads land. */
const ATTACHMENT_SUBDIR = ".codeoid/attachments";

export interface ResolvedAttachment {
  /** The path as recorded (workspace-relative when possible, for readability). */
  path: string;
  /** File content, possibly truncated with a trailing marker. */
  content?: string;
  /** Error marker — present iff `content` is undefined. */
  error?: string;
  /** Raw byte count (pre-truncation) for accounting. */
  bytes: number;
  /** True when the attachment was a binary payload written to disk (image/PDF). */
  binary?: boolean;
  /** Resolved mime type for binary attachments. */
  mimeType?: string;
}

export interface ResolverOptions {
  /** The session's working directory — all relative paths resolve here. */
  workdir: string;
  /**
   * Override limits. Kept per-call so tests can exercise boundaries
   * without mutating module-level constants.
   */
  maxBytes?: number;
  maxTotalBytes?: number;
}

/**
 * Resolve a list of attachments. Returns `{ resolved, promptPrefix }`
 * where `promptPrefix` is the chunk to splice into the turn prompt.
 */
export function resolveAttachments(
  attachments: readonly Attachment[],
  opts: ResolverOptions,
): { resolved: ResolvedAttachment[]; promptPrefix: string } {
  if (attachments.length === 0) return { resolved: [], promptPrefix: "" };
  const maxPer = opts.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const maxTotal = opts.maxTotalBytes ?? MAX_TOTAL_ATTACHMENT_BYTES;

  const resolved: ResolvedAttachment[] = [];
  let totalBytes = 0;

  for (const a of attachments) {
    // Binary payloads (image paste/drop) go through a separate writer that
    // materializes the bytes under the session workdir and rewrites `path`.
    // They don't count toward the text-attachment budget.
    if (a.data && a.mimeType) {
      resolved.push(resolveBinary(a, opts.workdir));
      continue;
    }

    const entry = resolveOne(a, opts.workdir, maxPer);
    // Enforce the total-bytes ceiling by truncating the next attachment
    // when we'd otherwise overflow.
    if (entry.content && totalBytes + entry.bytes > maxTotal) {
      const remaining = Math.max(0, maxTotal - totalBytes);
      if (remaining === 0) {
        entry.content = undefined;
        entry.error = `total attachment budget exceeded (${maxTotal} bytes)`;
      } else {
        entry.content = `${entry.content.slice(0, remaining)}\n… truncated: total attachment budget exceeded (${maxTotal} bytes) …`;
      }
    }
    totalBytes += Math.min(entry.bytes, maxPer);
    resolved.push(entry);
  }

  const promptPrefix = formatAsPrompt(resolved);
  return { resolved, promptPrefix };
}

/**
 * Decode a base64 attachment into the session's attachment subdir and return
 * a resolved entry that references the new on-disk path. Claude's Read tool
 * natively handles image files, so we just point it there via the prompt.
 */
function resolveBinary(a: Attachment, workdir: string): ResolvedAttachment {
  if (!a.data || !a.mimeType) {
    return { path: a.path, error: "missing data or mimeType", bytes: 0 };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(a.data, "base64");
  } catch (err) {
    return {
      path: a.path,
      error: `base64 decode failed: ${err instanceof Error ? err.message : String(err)}`,
      bytes: 0,
    };
  }
  if (bytes.length === 0) {
    return { path: a.path, error: "empty binary payload", bytes: 0 };
  }
  if (bytes.length > MAX_BINARY_ATTACHMENT_BYTES) {
    return {
      path: a.path,
      error: `binary attachment exceeds ${MAX_BINARY_ATTACHMENT_BYTES} bytes`,
      bytes: bytes.length,
    };
  }

  const ext = extensionForMime(a.mimeType) ?? deriveExtension(a.path) ?? "bin";
  const filename = `${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
  const dir = joinPath(workdir, ATTACHMENT_SUBDIR);
  const absPath = joinPath(dir, filename);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(absPath, bytes);
  } catch (err) {
    return {
      path: a.path,
      error: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      bytes: bytes.length,
    };
  }

  // Record the workspace-relative path so Claude's Read tool picks it up
  // without needing the absolute workdir prefix.
  const relPath = `${ATTACHMENT_SUBDIR}/${filename}`;
  return {
    path: relPath,
    bytes: bytes.length,
    binary: true,
    mimeType: a.mimeType,
  };
}

function extensionForMime(mime: string): string | null {
  switch (mime.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    case "image/svg+xml":
      return "svg";
    case "application/pdf":
      return "pdf";
    default:
      return null;
  }
}

function deriveExtension(path: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? m[1]!.toLowerCase() : null;
}

/** Infer a mime type from a local file path — used for @image.png mentions. */
function mimeFromPath(path: string): string | null {
  const ext = deriveExtension(path);
  if (!ext) return null;
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    default:
      return null;
  }
}

function resolveOne(
  a: Attachment,
  workdir: string,
  maxBytes: number,
): ResolvedAttachment {
  // Case 1: caller pushed content inline — honor it (paste flow).
  if (typeof a.content === "string") {
    const bytes = Buffer.byteLength(a.content, "utf8");
    if (bytes > maxBytes) {
      return {
        path: a.path,
        content: `${a.content.slice(0, maxBytes)}\n… truncated: inline content exceeded ${maxBytes} bytes …`,
        bytes,
      };
    }
    return { path: a.path, content: a.content, bytes };
  }

  // Case 2: read from disk.
  // SECURITY: bound the read to the session workdir. Without this, any
  // client with `session:send` (and thus `attachments:`) can stuff
  // `/etc/passwd` or `~/.aws/credentials` into the attachment list and
  // the contents flow into the prompt + scrollback + transcript +
  // memory. Resolves both lexically and via realpath so symlinked
  // shortcuts under workdir can't pivot out.
  let canonicalWorkdir: string;
  try {
    canonicalWorkdir = realpathSync(workdir);
  } catch {
    return {
      path: a.path,
      error: "workdir unresolvable; refusing attachment read",
      bytes: 0,
    };
  }
  // Resolve relative paths against the CANONICAL workdir so the prefix checks
  // below compare like-for-like. Resolving against the raw workdir broke on
  // any symlinked workdir (notably macOS tmpdir: /var/folders → /private/var/
  // folders), making every in-workdir path look like it escaped.
  const lexicallyResolved = isAbsolute(a.path)
    ? resolvePath(a.path)
    : resolvePath(canonicalWorkdir, a.path);
  const workdirPrefix = canonicalWorkdir.replace(/\/+$/, "") + sep;
  if (
    lexicallyResolved !== canonicalWorkdir &&
    !lexicallyResolved.startsWith(workdirPrefix)
  ) {
    return {
      path: a.path,
      error: `attachment path escapes workdir: ${a.path}`,
      bytes: 0,
    };
  }
  let absPath: string;
  try {
    absPath = realpathSync(lexicallyResolved);
  } catch {
    return {
      path: a.path,
      error: `unreadable or missing: ${a.path}`,
      bytes: 0,
    };
  }
  if (absPath !== canonicalWorkdir && !absPath.startsWith(workdirPrefix)) {
    return {
      path: a.path,
      error: `attachment path resolves outside workdir: ${a.path}`,
      bytes: 0,
    };
  }
  try {
    accessSync(absPath, constants.R_OK);
  } catch {
    return {
      path: a.path,
      error: `unreadable or missing: ${a.path}`,
      bytes: 0,
    };
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absPath);
  } catch (err) {
    return {
      path: a.path,
      error: `stat failed: ${err instanceof Error ? err.message : String(err)}`,
      bytes: 0,
    };
  }
  if (!stat.isFile()) {
    return {
      path: a.path,
      error: `not a regular file: ${a.path}`,
      bytes: 0,
    };
  }

  const rawBytes = stat.size;

  // Read a sniff window first to detect binary content cheaply.
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch (err) {
    return {
      path: a.path,
      error: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      bytes: rawBytes,
    };
  }

  const sniff = buf.subarray(0, Math.min(BINARY_SNIFF_BYTES, buf.length));
  if (sniff.includes(0)) {
    // Binary content — if it looks like an image/PDF by extension, pass it
    // through as a Read-tool pointer rather than blocking. Otherwise skip.
    const mime = mimeFromPath(a.path);
    if (mime && rawBytes <= MAX_BINARY_ATTACHMENT_BYTES) {
      return {
        path: a.path,
        bytes: rawBytes,
        binary: true,
        mimeType: mime,
      };
    }
    return {
      path: a.path,
      error: `binary file skipped (${rawBytes} bytes)`,
      bytes: rawBytes,
    };
  }

  if (buf.length <= maxBytes) {
    return { path: a.path, content: buf.toString("utf8"), bytes: rawBytes };
  }
  const truncated = buf.subarray(0, maxBytes).toString("utf8");
  return {
    path: a.path,
    content: `${truncated}\n… truncated: file exceeded ${maxBytes} bytes …`,
    bytes: rawBytes,
  };
}

/** Build the text block that gets prepended to the turn prompt. */
export function formatAsPrompt(resolved: readonly ResolvedAttachment[]): string {
  if (resolved.length === 0) return "";
  const blocks: string[] = [
    "<attachments>",
    "The user attached the following files to this turn. Treat them as authoritative context for this message. Pinned files are also included here until unpinned.",
    "",
  ];
  for (const r of resolved) {
    if (r.error) {
      blocks.push(`<file path="${escapeAttr(r.path)}" error="${escapeAttr(r.error)}" />`);
    } else if (r.binary) {
      // Binary payload: Claude's Read tool can view images/PDFs directly.
      // Tell it where the file lives and nudge it to open before responding.
      const mime = r.mimeType ?? "application/octet-stream";
      blocks.push(
        `<file path="${escapeAttr(r.path)}" type="${escapeAttr(mime)}" binary="true">`,
      );
      blocks.push(
        `The user attached a ${mime} file. Use the Read tool on the path above to view its contents before responding.`,
      );
      blocks.push("</file>");
    } else {
      blocks.push(`<file path="${escapeAttr(r.path)}">`);
      blocks.push(r.content ?? "");
      blocks.push("</file>");
    }
    blocks.push("");
  }
  blocks.push("</attachments>");
  blocks.push("");
  return blocks.join("\n");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
