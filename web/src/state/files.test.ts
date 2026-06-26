/**
 * File-tree state — `loadDirectory` invariants.
 *
 * What we verify:
 *   1. loadDirectory without clearFirst shows a loading indicator only when
 *      entries are null (stale entries are kept visible).
 *   2. loadDirectory with clearFirst: true clears entries AND sets loading —
 *      so the "loading…" indicator always appears on session switch, even
 *      when stale entries exist from a previous visit.
 *   3. A successful response populates entries and clears loading.
 *   4. resetFileTreeForSession wipes bySession for the given id.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  _resetFilesForTest,
  loadDirectory,
  nodeOf,
  resetFileTreeForSession,
} from "./files";
import { _setClientForTest } from "./connection";

// ── Client stub ───────────────────────────────────────────────────────────────

type RequestFn = (msg: unknown, opts?: unknown) => Promise<unknown>;

function makeClient(requestImpl: RequestFn) {
  return {
    request: vi.fn(requestImpl),
    send: vi.fn(),
    nextId: vi.fn(() => Math.random().toString(36).slice(2)),
    onStatus: vi.fn(),
    onMessage: vi.fn(),
    shutdown: vi.fn(),
  };
}

/** A client whose request() hangs forever. Lets us inspect intermediate state. */
function hangingClient() {
  return makeClient(() => new Promise(() => {}));
}

/** A client whose request() resolves immediately with given entries. */
function resolvedClient(entries: unknown[]) {
  return makeClient(() =>
    Promise.resolve({
      type: "fs.list.result",
      requestId: "req-1",
      path: ".",
      entries,
    }),
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SESSION = "sess-A";
const OTHER = "sess-B";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("loadDirectory — clearFirst option", () => {
  beforeEach(() => {
    _resetFilesForTest();
  });

  it("without clearFirst: stale entries persist while loading", async () => {
    // Seed stale entries by doing a resolved load first.
    const resolvedC = resolvedClient([
      { name: "old.ts", path: "old.ts", kind: "file", size: 10 },
    ]);
    _setClientForTest(resolvedC as never);
    await loadDirectory(SESSION, ".");

    // Confirm entries exist.
    expect(nodeOf(SESSION, ".").entries).toHaveLength(1);

    // Now start a hanging load (simulating in-flight request).
    _setClientForTest(hangingClient() as never);
    void loadDirectory(SESSION, ".");  // no clearFirst

    // Stale entries must still be visible (no clearFirst).
    const node = nodeOf(SESSION, ".");
    expect(node.loading).toBe(true);
    expect(node.entries).not.toBeNull();           // stale entries remain
    expect(node.entries).toHaveLength(1);
  });

  it("with clearFirst: true entries are null while loading", async () => {
    // Seed stale entries.
    const resolvedC = resolvedClient([
      { name: "old.ts", path: "old.ts", kind: "file", size: 10 },
    ]);
    _setClientForTest(resolvedC as never);
    await loadDirectory(SESSION, ".");
    expect(nodeOf(SESSION, ".").entries).toHaveLength(1);

    // Hanging load with clearFirst.
    _setClientForTest(hangingClient() as never);
    void loadDirectory(SESSION, ".", { clearFirst: true });

    // Entries must be cleared — loading indicator condition is satisfied.
    const node = nodeOf(SESSION, ".");
    expect(node.loading).toBe(true);
    expect(node.entries).toBeNull();               // cleared → loading… shows
  });

  it("clearFirst on a never-loaded node — no crash, still shows loading", () => {
    _setClientForTest(hangingClient() as never);
    void loadDirectory(SESSION, ".", { clearFirst: true });

    const node = nodeOf(SESSION, ".");
    expect(node.loading).toBe(true);
    expect(node.entries).toBeNull();
  });

  it("successful response populates entries and clears loading flag", async () => {
    _setClientForTest(
      resolvedClient([
        { name: "src", path: "src", kind: "directory" },
        { name: "index.ts", path: "index.ts", kind: "file", size: 42 },
      ]) as never,
    );
    await loadDirectory(SESSION, ".");

    const node = nodeOf(SESSION, ".");
    expect(node.loading).toBe(false);
    expect(node.entries).toHaveLength(2);
    expect(node.entries![0]!.name).toBe("src");
  });

  it("clearFirst + successful response delivers fresh entries", async () => {
    // Seed stale entries.
    _setClientForTest(
      resolvedClient([{ name: "stale.ts", path: "stale.ts", kind: "file", size: 1 }]) as never,
    );
    await loadDirectory(SESSION, ".");

    // Load fresh with clearFirst.
    _setClientForTest(
      resolvedClient([{ name: "fresh.ts", path: "fresh.ts", kind: "file", size: 2 }]) as never,
    );
    await loadDirectory(SESSION, ".", { clearFirst: true });

    const node = nodeOf(SESSION, ".");
    expect(node.loading).toBe(false);
    expect(node.entries).toHaveLength(1);
    expect(node.entries![0]!.name).toBe("fresh.ts");
  });

  it("clearFirst is session-scoped — other session's state is unaffected", async () => {
    // Seed entries for both sessions.
    const multiResolved = resolvedClient([
      { name: "shared.ts", path: "shared.ts", kind: "file", size: 5 },
    ]);
    _setClientForTest(multiResolved as never);
    await loadDirectory(SESSION, ".");
    await loadDirectory(OTHER, ".");

    // Reload SESSION with clearFirst.
    _setClientForTest(hangingClient() as never);
    void loadDirectory(SESSION, ".", { clearFirst: true });

    // SESSION root is cleared while loading.
    expect(nodeOf(SESSION, ".").entries).toBeNull();
    // OTHER is unaffected.
    expect(nodeOf(OTHER, ".").entries).toHaveLength(1);
  });
});

describe("resetFileTreeForSession", () => {
  beforeEach(() => {
    _resetFilesForTest();
  });

  it("clears all state for the given session", async () => {
    _setClientForTest(
      resolvedClient([{ name: "file.ts", path: "file.ts", kind: "file", size: 1 }]) as never,
    );
    await loadDirectory(SESSION, ".");
    expect(nodeOf(SESSION, ".").entries).toHaveLength(1);

    resetFileTreeForSession(SESSION);

    // All state for SESSION wiped.
    expect(nodeOf(SESSION, ".").entries).toBeNull();
    expect(nodeOf(SESSION, ".").loading).toBe(false);
  });

  it("null session id is a no-op", () => {
    expect(() => resetFileTreeForSession(null)).not.toThrow();
  });

  it("resetting old session doesn't affect new session's state", async () => {
    _setClientForTest(
      resolvedClient([{ name: "a.ts", path: "a.ts", kind: "file", size: 1 }]) as never,
    );
    await loadDirectory(OTHER, ".");
    expect(nodeOf(OTHER, ".").entries).toHaveLength(1);

    resetFileTreeForSession(SESSION);  // reset different session

    // OTHER is unaffected.
    expect(nodeOf(OTHER, ".").entries).toHaveLength(1);
  });
});
