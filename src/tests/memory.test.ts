/**
 * Smoke test for the memory module.
 *
 * Exercises: store → chunker → engine → ranker, with a stub embedder so the
 * test runs fast and offline. Verifies:
 *   - FTS5 triggers fire (keyword search returns the right episode)
 *   - Embedding BLOB roundtrips through SQLite cleanly
 *   - Ranker combines signals and returns episodes sorted by score
 *   - Chunker emits one tool_call episode per completed tool invocation
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SqliteEpisodeStore,
  MemoryEngine,
  EpisodeChunker,
  workspaceIdFromPath,
} from "../daemon/memory/index.js";
import type { Embedder } from "../daemon/memory/embedder.js";
import type { SessionMessage } from "../protocol/types.js";

class StubEmbedder implements Embedder {
  readonly modelName = "stub-embed";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    // Deterministic pseudo-embeddings from text hash — same input → same vector.
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (let i = 0; i < t.length; i++) {
        v[i % this.dimensions]! += t.charCodeAt(i) / 1000;
      }
      // L2-normalize.
      let norm = 0;
      for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
      return v;
    });
  }
  async close(): Promise<void> {}
}

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-memory-"));
  dbPath = join(tmp, "memory.db");
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

describe("SqliteEpisodeStore", () => {
  it("round-trips an episode with embedding BLOB", () => {
    const store = new SqliteEpisodeStore(dbPath);
    const vec = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const saved = store.insert({
      workspaceId: "ws_test",
      sessionId: "sess1",
      kind: "tool_call",
      toolName: "Read",
      summary: "Read src/foo.ts",
      content: "user: look at foo\n\nTool: Read\nInput: src/foo.ts\nResult: contents...",
      filePaths: ["src/foo.ts"],
      tokenEstimate: 42,
      embedding: vec,
      embeddingModel: "stub",
      createdAt: Date.now(),
      createdBy: "user:yash",
    });

    const fetched = store.getEpisode(saved.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.summary).toBe("Read src/foo.ts");
    expect(fetched!.filePaths).toEqual(["src/foo.ts"]);
    expect(fetched!.embedding).toBeDefined();
    // Float32 precision — use closeTo rather than exact equality.
    const roundtripped = Array.from(fetched!.embedding!);
    expect(roundtripped.length).toBe(4);
    expect(roundtripped[0]!).toBeCloseTo(0.1, 5);
    expect(roundtripped[1]!).toBeCloseTo(0.2, 5);
    expect(roundtripped[2]!).toBeCloseTo(0.3, 5);
    expect(roundtripped[3]!).toBeCloseTo(0.4, 5);

    store.close();
  });

  it("FTS5 keyword search returns matching episodes", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.insert({
      workspaceId: "ws_test",
      sessionId: "s1",
      kind: "tool_call",
      toolName: "Bash",
      summary: "npm install",
      content: "Tool: Bash\nInput: npm install express",
      filePaths: [],
      tokenEstimate: 10,
      createdAt: Date.now(),
      createdBy: "u",
    });
    store.insert({
      workspaceId: "ws_test",
      sessionId: "s1",
      kind: "tool_call",
      toolName: "Read",
      summary: "Read package.json",
      content: "Tool: Read\nInput: package.json",
      filePaths: ["package.json"],
      tokenEstimate: 5,
      createdAt: Date.now(),
      createdBy: "u",
    });

    const hits = store.ftsSearch("ws_test", "express install", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.bm25).toBeLessThan(0); // bm25 uses negative scores (more negative = more relevant)

    store.close();
  });
});

describe("MemoryEngine.recall excludeSessionId", () => {
  it("excludes episodes from the caller's own session", async () => {
    const store = new SqliteEpisodeStore(dbPath);
    const embedder = new StubEmbedder();
    const engine = new MemoryEngine({ store, embedder });
    await engine.init();

    const now = Date.now();
    engine.ingest({
      workspaceId: "ws_a",
      sessionId: "current",
      kind: "tool_call",
      toolName: "Read",
      summary: "Read from current session",
      content: "auth.ts contents from current session",
      filePaths: ["auth.ts"],
      tokenEstimate: 10,
      createdAt: now,
      createdBy: "u",
    });
    engine.ingest({
      workspaceId: "ws_a",
      sessionId: "prior",
      kind: "tool_call",
      toolName: "Read",
      summary: "Read from prior session",
      content: "auth.ts contents from prior session",
      filePaths: ["auth.ts"],
      tokenEstimate: 10,
      createdAt: now - 1000,
      createdBy: "u",
    });

    await engine.drain();

    const withCurrent = await engine.recall({
      query: "auth contents",
      workspaceId: "ws_a",
      limit: 5,
    });
    const withoutCurrent = await engine.recall({
      query: "auth contents",
      workspaceId: "ws_a",
      excludeSessionId: "current",
      limit: 5,
    });

    expect(withCurrent.some((h) => h.episode.sessionId === "current")).toBe(true);
    expect(withoutCurrent.some((h) => h.episode.sessionId === "current")).toBe(false);
    expect(withoutCurrent.every((h) => h.episode.sessionId === "prior")).toBe(true);

    await engine.close();
  });
});

describe("MemoryEngine.recall", () => {
  it("ranks by hybrid vector + FTS + recency", async () => {
    const store = new SqliteEpisodeStore(dbPath);
    const embedder = new StubEmbedder();
    const engine = new MemoryEngine({ store, embedder });
    await engine.init();

    const now = Date.now();
    // Recent, relevant
    engine.ingest({
      workspaceId: "ws_a",
      sessionId: "s1",
      kind: "tool_call",
      toolName: "Read",
      summary: "Read auth.ts",
      content: "Tool: Read\nInput: auth.ts\nResult: oauth flow implementation",
      filePaths: ["src/auth.ts"],
      tokenEstimate: 20,
      createdAt: now - 1000,
      createdBy: "u",
    });
    // Old, unrelated
    engine.ingest({
      workspaceId: "ws_a",
      sessionId: "s1",
      kind: "tool_call",
      toolName: "Bash",
      summary: "ls -la",
      content: "Tool: Bash\nInput: ls -la\nResult: file listing",
      filePaths: [],
      tokenEstimate: 10,
      createdAt: now - 1000 * 60 * 60 * 24 * 30, // 30 days old
      createdBy: "u",
    });

    await engine.drain();

    const hits = await engine.recall({
      query: "oauth flow",
      workspaceId: "ws_a",
      limit: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.episode.toolName).toBe("Read"); // the relevant + recent one wins

    await engine.close();
  });
});

describe("workspaceIdFromPath", () => {
  it("returns the same ID for different worktrees of the same repo", () => {
    // codeoid repo itself is a git repo — use it for the test.
    const mainRepo = "/Workspace/codeoid";
    const srcSubdir = "/Workspace/codeoid/src";
    const mainId = workspaceIdFromPath(mainRepo);
    const subdirId = workspaceIdFromPath(srcSubdir);
    // Same git repo, different subdirectory → same workspace (anchored on git-common-dir).
    expect(mainId).toBe(subdirId);
  });

  it("returns different IDs for unrelated directories", () => {
    const a = workspaceIdFromPath("/tmp");
    const b = workspaceIdFromPath("/home");
    expect(a).not.toBe(b);
  });

  it("falls back to path hash for non-git dirs", () => {
    const id = workspaceIdFromPath("/tmp");
    expect(id).toMatch(/^ws_[a-f0-9]{16}$/);
  });
});

describe("EpisodeChunker", () => {
  it("emits one tool_call episode per completed tool invocation", () => {
    const emitted: Array<{ kind: string; toolName?: string; summary: string }> = [];
    const chunker = new EpisodeChunker(
      {
        workspaceId: workspaceIdFromPath("/tmp/project"),
        sessionId: "s1",
        createdBy: "u",
      },
      (ep) => emitted.push({ kind: ep.kind, toolName: ep.toolName, summary: ep.summary }),
    );

    const t = new Date().toISOString();

    // User message
    chunker.onMessage(msg("m1", "user", "please read foo.ts", t));
    // Tool call starts
    chunker.onMessage(
      msgTool("m2", "Read", { phase: "executing" }, { file_path: "foo.ts" }, t),
    );
    // Tool call completes
    chunker.onMessage(
      msgTool(
        "m2",
        "Read",
        { phase: "completed", success: true, output: "file contents" },
        { file_path: "foo.ts" },
        t,
      ),
    );
    // Assistant reply
    chunker.onMessage(msg("m3", "assistant", "Here's the content.", t));
    chunker.onTurnEnd();

    expect(emitted.length).toBe(2);
    expect(emitted[0]!.kind).toBe("tool_call");
    expect(emitted[0]!.toolName).toBe("Read");
    // Second episode is a user_turn — the pending user prompt + final assistant reply
    // get merged into one episode keyed by user intent.
    expect(emitted[1]!.kind).toBe("user_turn");
  });
});

// ── test helpers ────────────────────────────────────────────────────────

function msg(
  messageId: string,
  role: SessionMessage["role"],
  content: string,
  timestamp: string,
): SessionMessage {
  return {
    type: "session.message",
    sessionId: "s1",
    messageId,
    role,
    content,
    identity: { sub: "user:test", type: "human" },
    timestamp,
  };
}

function msgTool(
  messageId: string,
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  state: any,
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  input: any,
  timestamp: string,
): SessionMessage {
  const hasInput = state.phase === "waiting_confirmation" || state.phase === "executing";
  return {
    type: "session.message",
    sessionId: "s1",
    messageId,
    role: "tool_call",
    content: `${name}(...)`,
    identity: { sub: "agent:test", type: "agent" },
    tool: {
      toolId: "tid",
      name,
      state: hasInput ? { ...state, input } : state,
    },
    timestamp,
  };
}
