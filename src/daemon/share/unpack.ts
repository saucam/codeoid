/**
 * Unpack a `ShareBundle` into the daemon — verify the manifest,
 * rewrite paths back to the importer's local workdir, persist the
 * transcript + memory + per-turn rows under a fresh session id, and
 * (optionally) materialise pinned files.
 *
 * Pure-ish: takes the bundle + a target workdir + the existing daemon
 * deps, returns the new session id (and a structured manifest preview
 * for the caller to show in confirmation UI).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { TranscriptStore } from "../transcript.js";
import type { Episode, MemoryEngine } from "../memory/index.js";
import type {
  AuthContext,
  SessionMessage,
} from "../../protocol/types.js";

import {
  type ShareBundle,
  type ShareEpisode,
  checkBundleVersion,
  isShareBundle,
} from "./manifest.js";
import {
  decodePath,
  decodePathArray,
  restoreTextPaths,
} from "./path-rewrite.js";

export interface UnpackInput {
  bundle: ShareBundle;
  /** Local absolute path the importer is anchoring this session to. */
  targetWorkdir: string;
  /** Optional override for the imported session's name. */
  nameOverride?: string;
  /** Whether to materialise pinned files into the target workdir. */
  writePinnedFiles: boolean;
  /** Auth identity that requested the import — recorded as `created_by`. */
  importer: AuthContext;
}

export interface UnpackDependencies {
  transcript: TranscriptStore;
  memory: MemoryEngine | null;
  workspaceIdFor: (workdir: string) => string;
  /** Daemon-side hook to register the imported session. Returns the new id. */
  registerSession: (init: ImportedSessionInit) => Promise<string>;
}

export interface ImportedSessionInit {
  name: string;
  workdir: string;
  createdBy: string;
  /** Original session metadata for the `forked-from` provenance trail. */
  forkedFrom: {
    sessionId: string;
    sessionName: string;
    alias: string;
    aliasSource: string;
    exportedAt: string;
    exporterIdentity: { sub: string; name?: string };
  };
}

export interface UnpackResult {
  newSessionId: string;
  importedMessages: number;
  importedEpisodes: number;
  importedTurns: number;
  pinnedFilesWritten: number;
  warnings: string[];
}

/** First-pass shape check; surface friendly errors before doing real work. */
export function validateBundle(raw: unknown):
  | { ok: true; bundle: ShareBundle }
  | { ok: false; reason: string } {
  if (!isShareBundle(raw)) {
    return { ok: false, reason: "not a codeoid session bundle" };
  }
  const ver = checkBundleVersion(raw);
  if (!ver.ok) return ver;
  return { ok: true, bundle: raw };
}

export async function unpackBundle(
  input: UnpackInput,
  deps: UnpackDependencies,
): Promise<UnpackResult> {
  const { bundle, targetWorkdir } = input;
  const alias = bundle.manifest.workdir.alias;
  const warnings: string[] = [];

  const newSessionId = await deps.registerSession({
    name: input.nameOverride ?? bundle.manifest.session.name,
    workdir: targetWorkdir,
    createdBy: input.importer.sub,
    forkedFrom: {
      sessionId: bundle.manifest.session.id,
      sessionName: bundle.manifest.session.name,
      alias,
      aliasSource: bundle.manifest.workdir.aliasSource,
      exportedAt: bundle.manifest.exportedAt,
      exporterIdentity: {
        sub: bundle.manifest.exporterIdentity.sub,
        ...(bundle.manifest.exporterIdentity.name
          ? { name: bundle.manifest.exporterIdentity.name }
          : {}),
      },
    },
  });

  // ---------- Transcript ----------
  let importedMessages = 0;
  for (let i = 0; i < bundle.transcript.length; i++) {
    const msg = bundle.transcript[i]!;
    const restored = restoreMessage(msg, alias, targetWorkdir, newSessionId);
    await deps.transcript.append(newSessionId, restored, i + 1);
    importedMessages += 1;
  }

  // ---------- Memory episodes ----------
  let importedEpisodes = 0;
  if (deps.memory) {
    const workspaceId = deps.workspaceIdFor(targetWorkdir);
    for (const ep of bundle.episodes) {
      const restored = restoreEpisode(ep, alias, targetWorkdir, newSessionId, workspaceId);
      try {
        deps.memory.store.insert(restored);
        importedEpisodes += 1;
      } catch (err) {
        warnings.push(
          `episode ${ep.id} failed to insert: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ---------- Per-turn usage ----------
  let importedTurns = 0;
  if (deps.memory) {
    const workspaceId = deps.workspaceIdFor(targetWorkdir);
    for (const turn of bundle.turns) {
      try {
        deps.memory.store.recordTurnUsage({
          workspaceId,
          sessionId: newSessionId,
          turn,
        });
        importedTurns += 1;
      } catch (err) {
        warnings.push(
          `turn ${turn.turnNumber} failed to insert: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ---------- Pinned files ----------
  let pinnedFilesWritten = 0;
  if (input.writePinnedFiles && bundle.pinnedFiles) {
    for (const [encodedPath, snap] of Object.entries(bundle.pinnedFiles)) {
      const localAbs = decodePath(encodedPath, alias, targetWorkdir);
      try {
        // Don't clobber existing files unless they're identical.
        let existing: Buffer | null = null;
        try {
          existing = await fs.readFile(localAbs);
        } catch {
          /* missing — fine */
        }
        const incoming =
          snap.encoding === "base64"
            ? Buffer.from(snap.content, "base64")
            : Buffer.from(snap.content, "utf-8");
        if (existing && !existing.equals(incoming)) {
          warnings.push(`pinned file ${localAbs} already exists with different content — skipped`);
          continue;
        }
        if (!existing) {
          await fs.mkdir(path.dirname(localAbs), { recursive: true });
          await fs.writeFile(localAbs, incoming);
        }
        pinnedFilesWritten += 1;
      } catch (err) {
        warnings.push(
          `pinned file ${localAbs} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    newSessionId,
    importedMessages,
    importedEpisodes,
    importedTurns,
    pinnedFilesWritten,
    warnings,
  };
}

// ---------- helpers ----------

function restoreMessage(
  msg: SessionMessage,
  alias: string,
  targetWorkdir: string,
  newSessionId: string,
): SessionMessage {
  const out: SessionMessage = {
    ...msg,
    sessionId: newSessionId,
    content: restoreTextPaths(msg.content, alias, targetWorkdir),
  };
  if (msg.tool) {
    out.tool = {
      ...msg.tool,
      state: deepRestoreStrings(msg.tool.state, (s) =>
        restoreTextPaths(s, alias, targetWorkdir),
      ) as typeof msg.tool.state,
    };
  }
  if (msg.parts) {
    out.parts = msg.parts.map((p) => {
      if (p.kind === "code") {
        return {
          ...p,
          ...(p.filePath ? { filePath: decodePath(p.filePath, alias, targetWorkdir) } : {}),
        };
      }
      if (p.kind === "file_ref") {
        return { ...p, path: decodePath(p.path, alias, targetWorkdir) };
      }
      if (p.kind === "diff") {
        const np = { ...p, path: decodePath(p.path, alias, targetWorkdir) };
        if (p.originalPath) {
          (np as { originalPath?: string }).originalPath = decodePath(
            p.originalPath,
            alias,
            targetWorkdir,
          );
        }
        return np;
      }
      return p;
    });
  }
  return out;
}

function deepRestoreStrings(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === "string") return f(value);
  if (Array.isArray(value)) return value.map((v) => deepRestoreStrings(v, f));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepRestoreStrings(v, f);
    }
    return out;
  }
  return value;
}

function restoreEpisode(
  ep: ShareEpisode,
  alias: string,
  targetWorkdir: string,
  newSessionId: string,
  workspaceId: string,
): Omit<Episode, "id"> & { id?: string } {
  const restored: Omit<Episode, "id"> & { id?: string } = {
    id: randomUUID(), // fresh id; the bundle one might collide with a prior import
    workspaceId,
    sessionId: newSessionId,
    kind: ep.kind as Episode["kind"],
    ...(ep.toolName ? { toolName: ep.toolName } : {}),
    summary: restoreTextPaths(ep.summary, alias, targetWorkdir),
    content: restoreTextPaths(ep.content, alias, targetWorkdir),
    filePaths: decodePathArray(ep.filePaths, alias, targetWorkdir),
    tokenEstimate: ep.tokenEstimate,
    createdAt: ep.createdAt,
    createdBy: ep.createdBy,
  };
  return restored;
}
