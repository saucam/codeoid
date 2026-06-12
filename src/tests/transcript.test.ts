/**
 * Transcript store tests — validates JSONL persistence, append,
 * load, metadata, and cleanup.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptStore } from "../daemon/transcript.js";
import { SYSTEM_IDENTITY, type SessionMessage } from "../protocol/types.js";

let tmpDir: string;
let store: TranscriptStore;

function makeMsg(content: string, sessionId = "sess-1"): SessionMessage {
  return {
    type: "session.message",
    sessionId,
    messageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role: "assistant",
    content,
    identity: SYSTEM_IDENTITY,
    timestamp: new Date().toISOString(),
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "codeoid-test-"));
  store = new TranscriptStore(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("TranscriptStore", () => {
  test("append and load transcript", async () => {
    const msg = makeMsg("hello world");
    await store.append("sess-1", msg, 0);

    const entries = await store.loadTranscript("sess-1");
    expect(entries).toHaveLength(1);
    expect(entries[0].seq).toBe(0);
    expect(entries[0].message.type).toBe("session.message");
    expect((entries[0].message as SessionMessage).content).toBe("hello world");
  });

  test("append multiple messages preserves order", async () => {
    await store.append("sess-1", makeMsg("first"), 0);
    await store.append("sess-1", makeMsg("second"), 1);
    await store.append("sess-1", makeMsg("third"), 2);

    const entries = await store.loadTranscript("sess-1");
    expect(entries).toHaveLength(3);
    expect(entries[0].seq).toBe(0);
    expect(entries[1].seq).toBe(1);
    expect(entries[2].seq).toBe(2);
    expect((entries[0].message as SessionMessage).content).toBe("first");
    expect((entries[2].message as SessionMessage).content).toBe("third");
  });

  test("load nonexistent transcript returns empty", async () => {
    const entries = await store.loadTranscript("nonexistent");
    expect(entries).toHaveLength(0);
  });

  test("skips non-persisted message types", async () => {
    // status_change should be persisted
    await store.append("sess-1", {
      type: "session.status_change",
      sessionId: "sess-1",
      status: "thinking",
      timestamp: new Date().toISOString(),
    }, 0);

    // auth.ok should NOT be persisted
    await store.append("sess-1", {
      type: "auth.ok",
      identity: SYSTEM_IDENTITY,
      scopes: [],
    } as any, 1);

    const entries = await store.loadTranscript("sess-1");
    expect(entries).toHaveLength(1);
  });

  test("save and load metadata", async () => {
    await store.saveMeta({
      sessionId: "sess-1",
      sessionName: "oracle",
      workdir: "/tmp/oracle",
      createdBy: "spiffe://test",
      createdAt: "2026-01-01T00:00:00Z",
      lastStatus: "idle",
      lastActivityAt: "2026-01-01T00:01:00Z",
      accountId: "personal",
      projectId: "dev",
    });

    const metas = await store.loadAllMeta();
    expect(metas).toHaveLength(1);
    expect(metas[0].sessionId).toBe("sess-1");
    expect(metas[0].sessionName).toBe("oracle");
    expect(metas[0].workdir).toBe("/tmp/oracle");
    expect(metas[0].lastStatus).toBe("idle");
  });

  test("loadAllMeta loads multiple sessions", async () => {
    await store.saveMeta({
      sessionId: "s1", sessionName: "oracle", workdir: "/tmp/1",
      createdBy: "u1", createdAt: "t1", lastStatus: "idle", lastActivityAt: "t1",
      accountId: "a", projectId: "p",
    });
    await store.saveMeta({
      sessionId: "s2", sessionName: "shield", workdir: "/tmp/2",
      createdBy: "u1", createdAt: "t2", lastStatus: "thinking", lastActivityAt: "t2",
      accountId: "a", projectId: "p",
    });

    const metas = await store.loadAllMeta();
    expect(metas).toHaveLength(2);
    const names = metas.map((m) => m.sessionName).sort();
    expect(names).toEqual(["oracle", "shield"]);
  });

  test("delete removes transcript and metadata", async () => {
    await store.append("sess-1", makeMsg("data"), 0);
    await store.saveMeta({
      sessionId: "sess-1", sessionName: "test", workdir: "/tmp",
      createdBy: "u", createdAt: "t", lastStatus: "idle", lastActivityAt: "t",
      accountId: "a", projectId: "p",
    });

    await store.delete("sess-1");

    const entries = await store.loadTranscript("sess-1");
    expect(entries).toHaveLength(0);

    const metas = await store.loadAllMeta();
    expect(metas).toHaveLength(0);
  });

  test("handles corrupted JSONL lines gracefully", async () => {
    // Write valid + invalid lines manually — each with a unique messageId
    const path = store.transcriptPath("sess-1");
    const msg1 = makeMsg("valid");
    const msg2 = makeMsg("also valid");
    const line1 = JSON.stringify({ seq: 0, timestamp: "t", message: msg1 });
    const line2 = JSON.stringify({ seq: 1, timestamp: "t", message: msg2 });
    await Bun.write(path, line1 + "\nnot json\n" + line2 + "\n");

    const entries = await store.loadTranscript("sess-1");
    expect(entries).toHaveLength(2); // Skips the corrupted line
  });

  test("transcript path is deterministic", () => {
    const path = store.transcriptPath("sess-123");
    expect(path).toContain("sess-123.jsonl");
  });

  test("meta path is deterministic", () => {
    const path = store.metaPath("sess-123");
    expect(path).toContain("sess-123.meta.json");
  });

  test("separate sessions have separate transcripts", async () => {
    await store.append("s1", makeMsg("session one", "s1"), 0);
    await store.append("s2", makeMsg("session two", "s2"), 0);

    const e1 = await store.loadTranscript("s1");
    const e2 = await store.loadTranscript("s2");
    expect(e1).toHaveLength(1);
    expect(e2).toHaveLength(1);
    expect((e1[0].message as SessionMessage).content).toBe("session one");
    expect((e2[0].message as SessionMessage).content).toBe("session two");
  });
});
