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

import { statSync, readFileSync, accessSync, constants } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { Attachment } from "../protocol/types.js";

/** Hard cap per individual attachment (bytes). 100 KB. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024;
/** Hard cap on total attachment bytes per turn. 500 KB. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 500 * 1024;
/** First N bytes inspected to detect binary content. */
const BINARY_SNIFF_BYTES = 1024;

export interface ResolvedAttachment {
  /** The path as recorded (workspace-relative when possible, for readability). */
  path: string;
  /** File content, possibly truncated with a trailing marker. */
  content?: string;
  /** Error marker — present iff `content` is undefined. */
  error?: string;
  /** Raw byte count (pre-truncation) for accounting. */
  bytes: number;
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
    const entry = resolveOne(a, opts.workdir, maxPer);
    // Enforce the total-bytes ceiling by truncating the next attachment
    // when we'd otherwise overflow.
    if (entry.content && totalBytes + entry.bytes > maxTotal) {
      const remaining = Math.max(0, maxTotal - totalBytes);
      if (remaining === 0) {
        entry.content = undefined;
        entry.error = `total attachment budget exceeded (${maxTotal} bytes)`;
      } else {
        entry.content = entry.content.slice(0, remaining) +
          `\n… truncated: total attachment budget exceeded (${maxTotal} bytes) …`;
      }
    }
    totalBytes += Math.min(entry.bytes, maxPer);
    resolved.push(entry);
  }

  const promptPrefix = formatAsPrompt(resolved);
  return { resolved, promptPrefix };
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
        content: a.content.slice(0, maxBytes) +
          `\n… truncated: inline content exceeded ${maxBytes} bytes …`,
        bytes,
      };
    }
    return { path: a.path, content: a.content, bytes };
  }

  // Case 2: read from disk.
  const absPath = isAbsolute(a.path) ? a.path : resolvePath(workdir, a.path);
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
    content: truncated + `\n… truncated: file exceeded ${maxBytes} bytes …`,
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
    } else {
      blocks.push(`<file path="${escapeAttr(r.path)}">`);
      blocks.push(r.content ?? "");
      blocks.push(`</file>`);
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
