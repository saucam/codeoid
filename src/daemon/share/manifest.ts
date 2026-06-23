/**
 * Bundle manifest types — the wire/disk format for shareable sessions.
 *
 * Format v1: a single JSON object containing everything needed to fork
 * a session on another machine. No tarball complexity for v1 — JSON
 * round-trips through clipboard / gist / Slack / git-blob easily, and
 * lets a teammate inspect what they're about to import.
 *
 * Future-compat: bumping `version` lets the unpacker reject older
 * bundles cleanly. New fields default to undefined; never repurpose
 * an existing field's meaning.
 */

import type {
  SessionMessage,
  TurnUsage,
} from "../../protocol/types.js";

export const SHARE_FORMAT_VERSION = 1;

/** Minimum format version this daemon understands when unpacking. */
export const MIN_SHARE_FORMAT_VERSION = 1;

export interface ShareBundle {
  /** Always "codeoid.session" — discriminator for "is this a bundle?" */
  kind: "codeoid.session";
  version: number;
  manifest: ShareManifest;
  transcript: SessionMessage[];
  episodes: ShareEpisode[];
  turns: TurnUsage[];
  /**
   * Pinned files captured at export time, keyed by path-relative-to-
   * workdir. Content is base64 — keeps the JSON tarball-stable for
   * binary as well as text.
   */
  pinnedFiles?: Record<string, ShareFileSnapshot>;
}

export interface ShareManifest {
  exportedAt: string; // ISO 8601
  exporterIdentity: ShareIdentity;
  /** Original session metadata at export time. */
  session: ShareSessionMeta;
  /** Workdir alias the bundle was rewritten against. */
  workdir: ShareWorkdirInfo;
  /** Counts for quick preview (don't trust on import — re-derive). */
  counts: {
    messages: number;
    episodes: number;
    turns: number;
    pinnedFiles: number;
  };
  /**
   * Protocol guarantees we use for path rewriting. Encoded so
   * unpackers reading future bundles can see we honored them.
   */
  pathPolicy: {
    /** Format like `${alias}/${relative}` for in-workdir refs. */
    aliasRelative: true;
    /** External paths get the `<external>/` prefix. */
    externalPrefix: "<external>/";
  };
}

export interface ShareIdentity {
  /** SPIFFE/WIMSE URI (verbatim from auth). */
  sub: string;
  /** Display name when present. */
  name?: string;
  /** Identity type (human / agent / subagent / system). */
  type?: string;
}

export interface ShareSessionMeta {
  id: string;
  name: string;
  createdAt: string;
  model?: string;
  fallbackModel?: string;
  mode?: string;
  rotationCount?: number;
}

export interface ShareWorkdirInfo {
  /** Stable cross-machine label (e.g. `github.com/saucam/codeoid`).
   *  Falls back to a `local:<basename>` form when no git remote. */
  alias: string;
  /** Absolute path on the exporter's machine — for diagnostics only. */
  originalAbsolute: string;
  /** Source the alias came from. Lets the importer judge the mapping. */
  aliasSource:
    | "git-remote"
    | "git-toplevel-basename"
    | "directory-name"
    | "explicit";
}

export interface ShareEpisode {
  id: string;
  kind: string;
  toolName?: string;
  summary: string;
  content: string;
  /** Path-rewritten file references. */
  filePaths: string[];
  tokenEstimate: number;
  createdAt: number;
  createdBy: string;
}

export interface ShareFileSnapshot {
  /** Original absolute path on the exporter's machine. */
  originalPath: string;
  /** Captured content. */
  content: string;
  /** "utf-8" or "base64" for binary blobs. */
  encoding: "utf-8" | "base64";
  /** Bytes on disk. */
  size: number;
  /** Mtime in unix ms — caller decides whether to write-or-merge on import. */
  mtimeMs: number;
}

// ---------- guards ----------

export function isShareBundle(x: unknown): x is ShareBundle {
  if (!x || typeof x !== "object") return false;
  const obj = x as Record<string, unknown>;
  return (
    obj.kind === "codeoid.session" &&
    typeof obj.version === "number" &&
    !!obj.manifest &&
    typeof obj.manifest === "object" &&
    Array.isArray(obj.transcript) &&
    Array.isArray(obj.episodes) &&
    Array.isArray(obj.turns)
  );
}

/** Reject bundles older than `MIN_SHARE_FORMAT_VERSION` or in the future. */
export function checkBundleVersion(bundle: ShareBundle): { ok: true } | { ok: false; reason: string } {
  if (bundle.version > SHARE_FORMAT_VERSION) {
    return {
      ok: false,
      reason: `bundle format v${bundle.version} is newer than this daemon (v${SHARE_FORMAT_VERSION})`,
    };
  }
  if (bundle.version < MIN_SHARE_FORMAT_VERSION) {
    return {
      ok: false,
      reason: `bundle format v${bundle.version} predates the minimum supported v${MIN_SHARE_FORMAT_VERSION}`,
    };
  }
  return { ok: true };
}
