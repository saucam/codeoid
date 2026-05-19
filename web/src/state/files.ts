/**
 * File tree + viewer state for the focused session.
 *
 * Two pieces of state:
 *   - `tree[sessionId][path]` → cached directory listing (populated on
 *     expand). Subscribers re-render when an entry's listing changes.
 *   - `openFile` → the currently-displayed file in the right pane, with
 *     a `loading` flag while the request is in flight.
 *
 * The right pane is collapsed when `openFile` is null. `closeFile()` is
 * the explicit way to collapse it.
 *
 * All actions go through `getClient().request()` with a typed result
 * predicate, so we never have to chase response correlation by hand.
 */

import { batch, createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import { getClient, newRequestId } from "./connection";
import type {
  FsEntry,
  FsListResultMsg,
  FsReadResultMsg,
} from "../protocol/types";

interface NodeState {
  loading: boolean;
  /** Newest known listing for this directory. Empty array = empty dir. */
  entries: FsEntry[] | null;
  /** Whether the user has expanded this node in the tree. */
  expanded: boolean;
  /** Latest error message from a list attempt; cleared on success. */
  error: string | null;
}

type SessionFileState = Record<string, NodeState>;

interface FilesState {
  /** Per-session, per-path directory cache. */
  bySession: Record<string, SessionFileState>;
}

const [state, setState] = createStore<FilesState>({ bySession: {} });

function ensureNode(sessionId: string, path: string): NodeState {
  // The session map must exist as an object before we can set a path
  // key under it. A no-op `produce` does NOT create it, and a
  // function-updater leaf set (`setState(..., path, cur => ...)`) does
  // not auto-create an `undefined` intermediate — so the first call for
  // a freshly-focused session left `bySession[sessionId]` undefined and
  // the return below threw on `undefined[path]`. Create each level
  // explicitly, and only when absent so existing siblings/nodes (their
  // entries, expanded, loading) are never clobbered.
  if (!state.bySession[sessionId]) {
    setState("bySession", sessionId, {});
  }
  if (!state.bySession[sessionId]?.[path]) {
    setState("bySession", sessionId, path, {
      loading: false,
      entries: null,
      expanded: false,
      error: null,
    });
  }
  // Both levels are guaranteed to exist after the writes above; the
  // PLACEHOLDER fallback only satisfies the type and is never returned.
  return state.bySession[sessionId]?.[path] ?? PLACEHOLDER;
}

export function getNode(sessionId: string, path: string): NodeState | undefined {
  return state.bySession[sessionId]?.[path];
}

/** Reactive accessor for one node — components subscribe to this. */
export function nodeOf(sessionId: string, path: string): NodeState {
  return state.bySession[sessionId]?.[path] ?? PLACEHOLDER;
}

const PLACEHOLDER: NodeState = {
  loading: false,
  entries: null,
  expanded: false,
  error: null,
};

/** Toggle expanded state for a directory. Lazy-loads the listing on open. */
export async function toggleExpanded(sessionId: string, path: string): Promise<void> {
  ensureNode(sessionId, path);
  const cur = state.bySession[sessionId]![path]!;
  const willExpand = !cur.expanded;
  setState("bySession", sessionId, path, "expanded", willExpand);
  if (willExpand && cur.entries === null && !cur.loading) {
    await loadDirectory(sessionId, path);
  }
}

export async function loadDirectory(sessionId: string, path: string): Promise<void> {
  ensureNode(sessionId, path);
  setState("bySession", sessionId, path, {
    loading: true,
    error: null,
  });
  try {
    const id = newRequestId();
    const result = await getClient().request<FsListResultMsg>(
      { type: "fs.list", id, sessionId, path },
      {
        waitForResult: (m) =>
          m.type === "fs.list.result" && m.requestId === id ? m : undefined,
        timeoutMs: 10_000,
      },
    );
    setState("bySession", sessionId, path, {
      loading: false,
      entries: result.entries,
      error: null,
      // Auto-expand on first load (the user just clicked).
      expanded: true,
    });
  } catch (err) {
    setState("bySession", sessionId, path, {
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------- open file ----------

interface OpenFile {
  sessionId: string;
  path: string;
  loading: boolean;
  content: string | null;
  encoding: "utf-8" | "base64";
  size: number;
  language?: string;
  truncated: boolean;
  error: string | null;
}

const [openFile, setOpenFile] = createSignal<OpenFile | null>(null);

export const openedFile = openFile;

export async function openFilePath(sessionId: string, path: string): Promise<void> {
  setOpenFile({
    sessionId,
    path,
    loading: true,
    content: null,
    encoding: "utf-8",
    size: 0,
    truncated: false,
    error: null,
  });
  try {
    const id = newRequestId();
    const result = await getClient().request<FsReadResultMsg>(
      { type: "fs.read", id, sessionId, path },
      {
        waitForResult: (m) =>
          m.type === "fs.read.result" && m.requestId === id ? m : undefined,
        timeoutMs: 15_000,
      },
    );
    // Race protection: if the user opened another file mid-flight, drop
    // this stale response.
    const cur = openFile();
    if (!cur || cur.sessionId !== sessionId || cur.path !== path) return;
    setOpenFile({
      sessionId,
      path: result.path,
      loading: false,
      content: result.content,
      encoding: result.encoding,
      size: result.size,
      ...(result.language ? { language: result.language } : {}),
      truncated: result.truncated,
      error: null,
    });
  } catch (err) {
    const cur = openFile();
    if (!cur || cur.sessionId !== sessionId || cur.path !== path) return;
    setOpenFile({
      ...cur,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function closeFile(): void {
  setOpenFile(null);
}

/** Reset all file state when the focused session changes. */
export function resetFileTreeForSession(sessionId: string | null): void {
  batch(() => {
    setOpenFile(null);
    if (sessionId) {
      // Drop any stale tree state — daemon is canonical, re-load on
      // next expand. Keeps memory bounded across long-running tabs.
      setState("bySession", sessionId, {});
    }
  });
}

export function _resetFilesForTest(): void {
  batch(() => {
    setOpenFile(null);
    setState({ bySession: {} });
  });
}
