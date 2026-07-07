/**
 * Conductor session lifecycle (P3) — driven through SessionManager.handle so
 * the singleton, role/provider persistence, tenancy, and resume paths are
 * exercised end-to-end. No SDK subprocess runs: a Session only spawns its
 * provider's backend on the first turn, and these tests never send one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SessionManager } from "../daemon/session-manager.js";
import type { AgentIdentityManager } from "../daemon/agent-identity.js";
import type { CodeoidConfig } from "../config.js";
import type { AuthContext, SessionInfo } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";

/**
 * Identity manager stub whose async methods actually YIELD (await a
 * microtask), so two concurrent conductor creates interleave at the await
 * point — the exact window the TOCTOU re-check must close. Counts how many
 * times a conductor was registered.
 */
function yieldingIdentityStub(): { mgr: AgentIdentityManager; registers: () => number } {
  let registers = 0;
  const stub = {
    get conductorUri() {
      return "wimse://test/conductor";
    },
    async registerConductor(sub: string) {
      await Promise.resolve(); // force a yield so concurrent creates interleave
      registers++;
      return { identityId: "cond-id", wimseUri: "wimse://test/conductor", ownerSub: sub };
    },
    async mintConductorToken() {
      await Promise.resolve();
      return "delegated-token";
    },
    async resumeConductor() {
      return null;
    },
  };
  return { mgr: stub as unknown as AgentIdentityManager, registers: () => registers };
}

function auth(tenant: string): AuthContext {
  return {
    sub: `user:${tenant}`,
    scopes: [...ALL_SCOPES] as AuthContext["scopes"],
    delegationDepth: 0,
    accountId: `acc-${tenant}`,
    projectId: `proj-${tenant}`,
  };
}

const AUTH_A = auth("a");
const client = (a: AuthContext) => ({ id: `client-${a.accountId}`, auth: a, send: () => {} });

/** Minimal config with a conductor block — only the fields the manager reads. */
function mkConfig(conductor?: Partial<CodeoidConfig["conductor"]>): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: "/tmp/codeoid.db",
    transcriptDir: "/tmp/transcripts",
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    conductor: { enabled: true, name: "conductor", provider: "claude", ...conductor },
  };
}

let tmp: string;
let store: Store;
let transcript: TranscriptStore;

function newManager(config?: CodeoidConfig, identity?: AgentIdentityManager): SessionManager {
  return new SessionManager(store, transcript, identity, undefined, undefined, { config });
}

async function createConductor(mgr: SessionManager, a = AUTH_A): Promise<SessionInfo> {
  const resp = await mgr.handle(
    { type: "session.create", id: "req", name: "ignored", workdir: ".", role: "conductor" },
    a,
    client(a),
  );
  expect(resp.type).toBe("response.ok");
  return (resp as { data: SessionInfo }).data;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-conductor-sess-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  try { await transcript.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("conductor session", () => {
  test("creating role:conductor yields a conductor session on the default provider", async () => {
    const info = await createConductor(newManager(mkConfig()));
    expect(info.role).toBe("conductor");
    expect(info.providerId).toBe("claude");
    // Daemon picks name/workdir — the request's name ("ignored") is dropped.
    expect(info.name).toBe("conductor");
  });

  test("a second conductor request returns the SAME session (idempotent singleton)", async () => {
    const mgr = newManager(mkConfig());
    const first = await createConductor(mgr);
    const second = await createConductor(mgr);
    expect(second.id).toBe(first.id);
  });

  test("the conductor is discoverable via session.list with its role", async () => {
    const mgr = newManager(mkConfig());
    const created = await createConductor(mgr);
    const list = await mgr.handle({ type: "session.list", id: "req" }, AUTH_A, client(AUTH_A));
    expect(list.type).toBe("session.list.result");
    const found = (list as { sessions: SessionInfo[] }).sessions.find((s) => s.id === created.id);
    expect(found?.role).toBe("conductor");
  });

  test("config.conductor.provider selects the backend (provider-agnostic)", async () => {
    const info = await createConductor(newManager(mkConfig({ provider: "gemini" })));
    expect(info.providerId).toBe("gemini");
    expect(info.role).toBe("conductor");
  });

  test("a disabled conductor is refused", async () => {
    const resp = await newManager(mkConfig({ enabled: false })).handle(
      { type: "session.create", id: "req", name: "x", workdir: ".", role: "conductor" },
      AUTH_A,
      client(AUTH_A),
    );
    expect(resp.type).toBe("response.error");
    expect((resp as { error: string }).error).toContain("disabled");
  });

  test("each tenant gets its own conductor", async () => {
    const mgr = newManager(mkConfig());
    const a = await createConductor(mgr, auth("a"));
    const b = await createConductor(mgr, auth("b"));
    expect(a.id).not.toBe(b.id);
    // Tenant A's list must not see tenant B's conductor.
    const listA = await mgr.handle({ type: "session.list", id: "req" }, auth("a"), client(auth("a")));
    const ids = (listA as { sessions: SessionInfo[] }).sessions.map((s) => s.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  test("an unknown role fails closed — never a silent downgrade to a normal session", async () => {
    const mgr = newManager(mkConfig());
    const resp = await mgr.handle(
      // A future/unimplemented role — the frame parses, the daemon refuses.
      { type: "session.create", id: "req", name: "x", workdir: tmp, role: "leaf" },
      AUTH_A,
      client(AUTH_A),
    );
    expect(resp.type).toBe("response.error");
    expect((resp as { error: string }).error).toContain("Unsupported session role");
    // No session was created.
    const list = await mgr.handle({ type: "session.list", id: "req" }, AUTH_A, client(AUTH_A));
    expect((list as { sessions: SessionInfo[] }).sessions).toHaveLength(0);
  });

  test("a normal session.create is unaffected — no role, default provider", async () => {
    const resp = await newManager(mkConfig()).handle(
      { type: "session.create", id: "req", name: "normal", workdir: tmp },
      AUTH_A,
      client(AUTH_A),
    );
    expect(resp.type).toBe("response.ok");
    const info = (resp as { data: SessionInfo }).data;
    expect(info.role).toBeUndefined();
    expect(info.name).toBe("normal");
  });

  test("the conductor's display name is reserved from normal session creation", async () => {
    // A normal session named "conductor" would shadow the singleton in
    // session.list — refuse it and point at the role.
    const resp = await newManager(mkConfig()).handle(
      { type: "session.create", id: "req", name: "conductor", workdir: tmp },
      AUTH_A,
      client(AUTH_A),
    );
    expect(resp.type).toBe("response.error");
    expect((resp as { error: string }).error).toContain("reserved");
  });

  test("concurrent conductor creates converge on ONE session (no TOCTOU dup)", async () => {
    // The yielding identity stub forces an await between the first singleton
    // check and Session construction — the exact race window. Both creates
    // pass the first check; only the re-check must let one through.
    const { mgr: identity, registers } = yieldingIdentityStub();
    const mgr = newManager(mkConfig(), identity);
    const [a, b] = await Promise.all([
      createConductor(mgr),
      createConductor(mgr),
    ]);
    expect(a.id).toBe(b.id);
    const list = await mgr.handle({ type: "session.list", id: "req" }, AUTH_A, client(AUTH_A));
    const conductors = (list as { sessions: SessionInfo[] }).sessions.filter(
      (s) => s.role === "conductor",
    );
    expect(conductors).toHaveLength(1);
    // The loser re-checks and returns the winner WITHOUT constructing a second
    // Session — but both may have registered identity before the re-check
    // (best-effort, idempotent on the ZeroID side), so we only assert the
    // session singleton, which is the invariant attach relies on.
    expect(registers()).toBeGreaterThanOrEqual(1);
  });

  test("the conductor self-persists: resume rebuilds it with role + provider", async () => {
    const created = await createConductor(newManager(mkConfig({ provider: "gemini" })));
    await transcript.flush();

    // Fresh manager over the same store/transcript = daemon restart.
    const mgr2 = newManager(mkConfig({ provider: "gemini" }));
    const resumed = await mgr2.resumeSessions();
    expect(resumed).toBeGreaterThanOrEqual(1);

    const list = await mgr2.handle({ type: "session.list", id: "req" }, AUTH_A, client(AUTH_A));
    const found = (list as { sessions: SessionInfo[] }).sessions.find((s) => s.id === created.id);
    expect(found?.role).toBe("conductor");
    expect(found?.providerId).toBe("gemini");

    // And it stays a singleton across the restart — no duplicate minted.
    const again = await createConductor(mgr2);
    expect(again.id).toBe(created.id);
  });
});
