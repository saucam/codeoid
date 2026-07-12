/**
 * session.fork — branch a conversation into a new independent session,
 * optionally onto a different backend. Two layers:
 *
 *   Part A (primitive): Session.primeFromFork / canonicalHistory directly —
 *     the child gets a COPY of the parent's canonical history (not shared),
 *     the warm provider is seeded, and the transcript replays into scrollback.
 *
 *   Part B (wiring): SessionManager.handle("session.fork") end-to-end — new
 *     id + "(fork)" name, history carried, the "fork onto a different
 *     provider in one call" path, parent untouched, and fail-closed rules
 *     (unknown provider, foreign tenant, conductor).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type AttachedClient } from "../daemon/session.js";
import { SessionManager } from "../daemon/session-manager.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { mockResult } from "../daemon/providers/mock/index.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import type { CanonicalTurn } from "../daemon/providers/canonical.js";
import type { AuthContext, DaemonMessage } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";

const AUTH: AuthContext = {
  sub: "user:fork",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-fork",
  projectId: "proj-fork",
};
const OTHER: AuthContext = { ...AUTH, sub: "user:other", accountId: "acc-other" };

let tmp: string;
let store: Store;
let transcript: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-fork-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  await new Promise<void>((r) => setTimeout(r, 50));
  try {
    await transcript.flush();
  } catch {}
  try {
    store.close();
  } catch {}
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

// ── Part A: the primitive ───────────────────────────────────────────────────

describe("Session.primeFromFork", () => {
  it("copies canonical history, seeds the warm provider, replays scrollback", async () => {
    const id = randomUUID();
    store.createSession({
      id,
      name: "fork",
      workdir: tmp,
      status: "idle",
      createdBy: AUTH.sub,
      createdAt: new Date().toISOString(),
      attachedClients: 0,
      accountId: AUTH.accountId!,
      projectId: AUTH.projectId!,
    });
    const provider = new MockSessionProvider("mock-session", []);
    const session = new Session({
      name: "fork",
      workdir: tmp,
      auth: AUTH,
      store,
      transcriptStore: transcript,
      existingId: id,
      _testProvider: provider,
    });

    const history: CanonicalTurn[] = [
      { role: "user", content: "parent q" },
      { role: "assistant", content: "parent a", providerId: "claude", model: "opus" },
    ];
    const transcriptRows: DaemonMessage[] = [
      {
        type: "session.message",
        sessionId: "parent",
        message: {
          messageId: "m1",
          role: "user",
          content: "parent q",
          identity: { sub: AUTH.sub, name: "u", type: "human" },
          timestamp: new Date().toISOString(),
        },
      } as unknown as DaemonMessage,
    ];

    await session.primeFromFork(history, transcriptRows);

    // Canonical history copied — and it's a COPY (mutating ours doesn't leak).
    expect(session.canonicalHistory).toEqual(history);
    history[0] = { role: "user", content: "MUTATED" };
    expect(session.canonicalHistory[0]).toEqual({ role: "user", content: "parent q" });

    // Warm provider was seeded with the forked history.
    expect(provider.seededHistory).toHaveLength(2);
    expect(provider.seededHistory?.[0]).toEqual({ role: "user", content: "parent q" });

    // A fork's fresh backend must run its first turn as a create, NOT a
    // resume — scrollback replay must NOT flip hasQueried.
    expect(provider.hasQueried).toBe(false);
  });
});

// ── Part B: the manager handler ─────────────────────────────────────────────

/** 2-backend registry; created instances captured for inspection. */
function makeRegistry() {
  const created: Record<string, MockSessionProvider[]> = { "mock-a": [], "mock-b": [] };
  const registry = new ProviderRegistry("mock-a");
  for (const id of ["mock-a", "mock-b"] as const) {
    registry.register({
      id,
      displayName: id,
      create: () => {
        // One scripted turn so a send produces an assistant turn in history.
        const p = new MockSessionProvider(id, [
          [
            { type: "text_done", content: `${id} reply` },
            { type: "turn_done", result: mockResult({ providerId: id }) },
          ],
        ]);
        created[id]!.push(p);
        return p;
      },
    });
  }
  return { registry, created };
}

function makeManager(registry: ProviderRegistry): SessionManager {
  return new SessionManager(store, transcript, undefined, undefined, undefined, {
    providers: registry,
  });
}

function client(auth: AuthContext): AttachedClient & { received: DaemonMessage[] } {
  const received: DaemonMessage[] = [];
  return { id: randomUUID(), auth, received, send: (m) => received.push(m) };
}

async function createSession(
  manager: SessionManager,
  c: AttachedClient,
  providerId?: string,
): Promise<string> {
  const resp = await manager.handle(
    { type: "session.create", id: "c1", name: "parent", workdir: tmp, ...(providerId ? { providerId } : {}) },
    AUTH,
    c,
  );
  expect(resp.type).toBe("response.ok");
  return (resp as { data: { id: string } }).data.id;
}

/** Send a turn and wait for the session to return to idle. */
async function sendAndSettle(
  manager: SessionManager,
  c: AttachedClient & { received: DaemonMessage[] },
  sessionId: string,
  text: string,
): Promise<void> {
  // Attach so the session's status broadcasts reach this client.
  await manager.handle({ type: "session.attach", id: "a1", sessionId }, AUTH, c);
  await manager.handle({ type: "session.send", id: "s1", sessionId, text }, AUTH, c);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (
      c.received.some(
        (m) => m.type === "session.status_change" && (m.status === "idle" || m.status === "error"),
      )
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("session never settled after send");
}

describe("SessionManager session.fork", () => {
  it("F1: forks with history carried, a new id, and the (fork) name", async () => {
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createSession(manager, c);
    await sendAndSettle(manager, c, parentId, "hello parent");

    const resp = await manager.handle(
      { type: "session.fork", id: "f1", sessionId: parentId },
      AUTH,
      c,
    );
    expect(resp.type).toBe("response.ok");
    const fork = (resp as { data: { id: string; name: string; providerId?: string } }).data;
    expect(fork.id).not.toBe(parentId);
    expect(fork.name).toBe("parent (fork)");
    expect(fork.providerId).toBe("mock-a"); // inherits parent's backend

    // Lineage: the fork knows its parent + the branch point (1 user turn
    // "hello parent" was carried over).
    const forkInfo = fork as unknown as {
      forkedFrom?: { sessionId: string; name: string; atTurn: number };
    };
    expect(forkInfo.forkedFrom).toEqual({
      sessionId: parentId,
      name: "parent",
      atTurn: 1,
    });

    // The fork's history matches the parent's [user, assistant] turn.
    const info = await manager.handle({ type: "session.list", id: "l1" }, AUTH, c);
    const ids = (info as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    expect(ids).toContain(parentId);
    expect(ids).toContain(fork.id);

    // The replayed scrollback is persisted to the fork's OWN transcript and
    // restamped with the fork's id (survives restart; no foreign session id).
    await transcript.flush();
    const rows = await transcript.loadTranscript(fork.id, {});
    const msgs = rows.map((r) => r.message).filter((m) => m.type === "session.message");
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect((m as { sessionId: string }).sessionId).toBe(fork.id);
    expect(msgs.some((m) => (m as { role: string }).role === "user")).toBe(true);
  });

  it("F1b: fork lineage is persisted in the transcript meta (survives restart)", async () => {
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createSession(manager, c);
    await sendAndSettle(manager, c, parentId, "one");

    const resp = await manager.handle(
      { type: "session.fork", id: "f1b", sessionId: parentId },
      AUTH,
      c,
    );
    const fork = (resp as { data: { id: string; forkedFrom?: { atTurn: number } } }).data;
    await transcript.flush();

    // The fork's meta on disk carries the lineage — this is what a restart
    // reads back to repopulate SessionInfo.forkedFrom. It must round-trip
    // exactly what the live SessionInfo reported.
    const metas = await transcript.loadAllMeta();
    const meta = metas.find((m) => m.sessionId === fork.id);
    expect(meta?.forkedFrom).toBeDefined();
    expect(meta?.forkedFrom?.sessionId).toBe(parentId);
    expect(meta?.forkedFrom?.name).toBe("parent");
    expect(meta?.forkedFrom?.atTurn).toBe(fork.forkedFrom?.atTurn);
    expect(meta?.forkedFrom?.atTurn).toBeGreaterThanOrEqual(1);
  });

  it("F2: forks onto a DIFFERENT backend in one call, parent untouched", async () => {
    const { registry, created } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createSession(manager, c, "mock-a");
    await sendAndSettle(manager, c, parentId, "hello");

    const resp = await manager.handle(
      { type: "session.fork", id: "f2", sessionId: parentId, providerId: "mock-b" },
      AUTH,
      c,
    );
    expect(resp.type).toBe("response.ok");
    const fork = (resp as { data: { id: string; providerId?: string } }).data;
    expect(fork.providerId).toBe("mock-b");

    // The mock-b provider (built for the fork) was seeded with the parent's
    // conversation — this is "branch claude, continue on codex" in miniature.
    const forkProvider = created["mock-b"]![0]!;
    expect(forkProvider.seededHistory?.length).toBeGreaterThanOrEqual(2);
    expect(forkProvider.seededHistory?.[0]).toMatchObject({ role: "user", content: "hello" });

    // Parent stays on mock-a, unchanged.
    const list = await manager.handle({ type: "session.list", id: "l2" }, AUTH, c);
    const sessions = (list as { sessions: Array<{ id: string; providerId?: string }> }).sessions;
    expect(sessions.find((s) => s.id === parentId)?.providerId).toBe("mock-a");
  });

  it("F3: unknown provider is rejected fail-closed", async () => {
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createSession(manager, c);

    const resp = await manager.handle(
      { type: "session.fork", id: "f3", sessionId: parentId, providerId: "backend-from-the-future" },
      AUTH,
      c,
    );
    expect(resp).toMatchObject({ type: "response.error", code: "invalid_request" });
    if (resp.type === "response.error") expect(resp.error).toContain("backend-from-the-future");
  });

  it("F4: forking another tenant's session is not_found (no cross-tenant leak)", async () => {
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const parentId = await createSession(manager, client(AUTH));

    const resp = await manager.handle(
      { type: "session.fork", id: "f4", sessionId: parentId },
      OTHER,
      client(OTHER),
    );
    expect(resp).toMatchObject({ type: "response.error", code: "not_found" });
  });

  it("F5: forking an unknown session is not_found", async () => {
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const resp = await manager.handle(
      { type: "session.fork", id: "f5", sessionId: randomUUID() },
      AUTH,
      client(AUTH),
    );
    expect(resp).toMatchObject({ type: "response.error", code: "not_found" });
  });
});
