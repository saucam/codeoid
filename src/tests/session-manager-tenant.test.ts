/**
 * SessionManager handler coverage for the tenant-scoped workspace id.
 *
 * The isolation property itself is proven in memory.test.ts; here we drive the
 * three handlers that derive a workspace id from the caller's auth
 * (session.search, session.export, session.import) through `handle()` so the
 * tenant binding is exercised end-to-end (and can't silently regress).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SessionManager } from "../daemon/session-manager.js";
import {
  SqliteEpisodeStore,
  MemoryEngine,
  workspaceIdFromPath,
} from "../daemon/memory/index.js";
import type { Embedder } from "../daemon/memory/embedder.js";
import type { AuthContext } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";

class StubEmbedder implements Embedder {
  readonly modelName = "stub";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (let i = 0; i < t.length; i++) v[i % this.dimensions]! += t.charCodeAt(i) / 1000;
      let norm = 0;
      for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
      return v;
    });
  }
  async close(): Promise<void> {}
}

const AUTH: AuthContext = {
  sub: "user:tenant-a",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-a",
  projectId: "proj-a",
};
const CLIENT = { id: "client-a", auth: AUTH, send: () => {} };

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let episodeStore: SqliteEpisodeStore;
let memory: MemoryEngine;
let manager: SessionManager;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-mgr-tenant-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  episodeStore = new SqliteEpisodeStore(join(tmp, "memory.db"));
  memory = new MemoryEngine({ store: episodeStore, embedder: new StubEmbedder() });
  await memory.init();
  manager = new SessionManager(store, transcript, undefined, undefined, memory);
});

afterEach(async () => {
  try { await memory.close(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("SessionManager tenant-scoped handlers", () => {
  it("session.search derives a tenant-scoped workspace id and finds the caller's own episode", async () => {
    // Ingest an episode under this caller's tenant-scoped workspace id.
    const ws = workspaceIdFromPath(tmp, AUTH);
    memory.ingest({
      workspaceId: ws,
      sessionId: "sess-a",
      kind: "user_turn",
      summary: "investigate the flux capacitor",
      content: "notes about the flux capacitor calibration",
      filePaths: [],
      tokenEstimate: 10,
      createdAt: Date.now(),
      createdBy: AUTH.sub,
    });
    await memory.drain();

    const res = (await manager.handle(
      {
        type: "session.search",
        id: "req-search",
        query: "flux capacitor",
        scope: "workspace",
        workdir: tmp,
      },
      AUTH,
      CLIENT,
    )) as { type: string; sessions?: Array<{ sessionId: string }> };

    expect(res.type).toBe("session.search.result");
    // The caller sees its own episode's session under its own tenant scope.
    expect(res.sessions?.some((s) => s.sessionId === "sess-a")).toBe(true);
  });

  it("round-trips a session through export/import under the caller's tenant", async () => {
    const created = (await manager.handle(
      { type: "session.create", id: "req-create", name: "tenant-test", workdir: tmp },
      AUTH,
      CLIENT,
    )) as { type: string; data?: { id: string } };
    expect(created.type).toBe("response.ok");
    const sessionId = created.data!.id;

    const exported = (await manager.handle(
      { type: "session.export", id: "req-export", sessionId },
      AUTH,
      CLIENT,
    )) as { type: string; payload?: { kind: string; bundle?: unknown } };
    expect(exported.type).toBe("session.export.result");
    const bundle = exported.payload?.bundle;
    expect(bundle).toBeDefined();

    const imported = (await manager.handle(
      {
        type: "session.import",
        id: "req-import",
        source: { kind: "inline", bundle },
        targetWorkdir: tmp,
      } as never,
      AUTH,
      CLIENT,
    )) as { type: string; newSessionId?: string };
    // Assert the SUCCESS path explicitly — a regression that breaks the
    // tenant-bound workspaceIdFor and makes import always error must fail here.
    expect(imported.type).toBe("session.import.result");
    expect(imported.newSessionId).toBeDefined();
    expect(imported.newSessionId).not.toBe(sessionId); // import mints a new id
  });
});
