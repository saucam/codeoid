/**
 * Session client-tracking invariants.
 *
 * Tests the routing properties that underpin session output delivery and
 * prevent the "wrong session streaming" bug (fixed in TelegramFrontend
 * #handleAttach): when a client switches sessions, the old session must stop
 * delivering messages to that client.
 *
 * We use real Session objects because the constructor runs without spawning an
 * SDK subprocess (that only happens on send()). Both Store and TranscriptStore
 * operate on temporary files cleaned up in afterEach.
 *
 * What we verify:
 *   1. attach() registers the client (attachedClientCount reflects it)
 *   2. detach() removes the client
 *   3. Reattaching the same clientId replaces the Map entry — no duplicates
 *   4. attach() replays scrollback to the new client if any messages exist
 *   5. Without an explicit detach, attaching to a new session leaves both
 *      sessions registering the client simultaneously (the old bug shape)
 *   6. The fix: detach-then-attach routes to only the new session
 *   7. Sweeping a clientId across all sessions (disconnectClient pattern)
 *      leaves every session empty
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type AttachedClient } from "../daemon/session.js";
import type { DaemonMessage, AuthContext } from "../protocol/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_AUTH: AuthContext = {
  sub: "user:test",
  scopes: [],
  delegationDepth: 0,
  accountId: "acc",
  projectId: "proj",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-client-track-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(() => {
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/**
 * Create a minimal Session. Pre-registers the session in the store and passes
 * existingId so the constructor skips the async saveMeta call — without this,
 * saveMeta fires as a fire-and-forget promise that races with afterEach's
 * rmSync and produces spurious ENOENT errors between tests.
 */
function makeSession(name = "test"): Session {
  const id = randomUUID();
  store.createSession({
    id,
    name,
    workdir: tmp,
    status: "idle",
    createdBy: TEST_AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: TEST_AUTH.accountId!,
    projectId: TEST_AUTH.projectId!,
  });
  return new Session({ name, workdir: tmp, auth: TEST_AUTH, store, transcriptStore, existingId: id });
}

/**
 * Build a stub AttachedClient. The `received` array accumulates every
 * DaemonMessage the client's send() is called with.
 */
function makeClient(id: string): { client: AttachedClient; received: DaemonMessage[] } {
  const received: DaemonMessage[] = [];
  const client: AttachedClient = {
    id,
    auth: TEST_AUTH,
    send: (msg) => received.push(msg),
  };
  return { client, received };
}

/** Build a minimal session.message for restoreScrollback. */
function makeMsg(sessionId: string, content: string): DaemonMessage {
  return {
    type: "session.message",
    sessionId,
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    content,
    identity: { sub: "agent:test", name: "Claude", type: "agent" },
    timestamp: new Date().toISOString(),
  };
}

// ── attach / detach basics ────────────────────────────────────────────────────

describe("Session.attach", () => {
  it("registers the client — attachedClientCount reflects it", () => {
    const session = makeSession();
    const { client } = makeClient("c1");

    expect(session.attachedClientCount).toBe(0);
    session.attach(client);
    expect(session.attachedClientCount).toBe(1);
  });

  it("two distinct clients both register", () => {
    const session = makeSession();
    session.attach(makeClient("c1").client);
    session.attach(makeClient("c2").client);
    expect(session.attachedClientCount).toBe(2);
  });

  it("re-attaching the same clientId replaces the entry — count stays 1", () => {
    const session = makeSession();
    const { client: first } = makeClient("c1");
    const { client: second } = makeClient("c1"); // same id, different send fn

    session.attach(first);
    session.attach(second);
    // Map.set with the same key replaces; no duplicate entry.
    expect(session.attachedClientCount).toBe(1);
  });
});

describe("Session.detach", () => {
  it("removes the client — attachedClientCount drops to 0", () => {
    const session = makeSession();
    const { client } = makeClient("c1");
    session.attach(client);
    session.detach("c1");
    expect(session.attachedClientCount).toBe(0);
  });

  it("detach is a no-op for an unknown clientId", () => {
    const session = makeSession();
    session.detach("never-attached");
    expect(session.attachedClientCount).toBe(0);
  });

  it("detaches only the targeted client — others remain", () => {
    const session = makeSession();
    session.attach(makeClient("c1").client);
    session.attach(makeClient("c2").client);
    session.detach("c1");
    expect(session.attachedClientCount).toBe(1);
  });
});

// ── scrollback replay on attach ───────────────────────────────────────────────

describe("scrollback replay", () => {
  it("sends scrollback.replay to the new client when prior messages exist", () => {
    const session = makeSession();
    session.restoreScrollback([makeMsg(session.id, "hello")]);

    const { client, received } = makeClient("c1");
    session.attach(client);

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("scrollback.replay");
  });

  it("sends no replay when scrollback is empty", () => {
    const session = makeSession();
    const { client, received } = makeClient("c1");
    session.attach(client);
    expect(received).toHaveLength(0);
  });

  it("re-attach with the same clientId but a new send fn replays to the new fn", () => {
    const session = makeSession();
    session.restoreScrollback([makeMsg(session.id, "data")]);

    const { client: first, received: rcvFirst } = makeClient("shared-id");
    const { client: second, received: rcvSecond } = makeClient("shared-id");

    // First attach — first.send receives the replay.
    session.attach(first);
    expect(rcvFirst).toHaveLength(1);

    // Re-attach with the same id — second.send now owns the slot.
    session.attach(second);
    // The re-attach replays again (scrollback is still present).
    expect(rcvSecond).toHaveLength(1);
    // rcvFirst received the first replay only (not the second re-attach replay).
    expect(rcvFirst).toHaveLength(1);
  });
});

// ── session-switch routing — core of the bug ─────────────────────────────────

describe("session switch routing", () => {
  it("REGRESSION: without detach, both sessions hold the same client", () => {
    // This documents the old behaviour (pre-fix). If #handleAttach attached to
    // a new session without disconnecting from the old one, the old session
    // retained its client entry and kept delivering messages.
    const sessionA = makeSession("session-a");
    const sessionB = makeSession("session-b");
    const { client } = makeClient("tg:user-1");

    sessionA.attach(client);
    // Simulate the old (buggy) code path: attach to B without detaching from A.
    sessionB.attach(client);

    // Both sessions have the client — old session keeps delivering (the bug).
    expect(sessionA.attachedClientCount).toBe(1);
    expect(sessionB.attachedClientCount).toBe(1);
  });

  it("FIX: detach-then-attach clears old session, routes to new session only", () => {
    const sessionA = makeSession("session-a");
    const sessionB = makeSession("session-b");
    const { client } = makeClient("tg:user-1");

    sessionA.attach(client);
    expect(sessionA.attachedClientCount).toBe(1);

    // The fix: detach from A before attaching to B.
    sessionA.detach(client.id);
    sessionB.attach(client);

    expect(sessionA.attachedClientCount).toBe(0); // no leak
    expect(sessionB.attachedClientCount).toBe(1);
  });

  it("scrollback replay after switch goes to the new client send fn only", () => {
    const sessionA = makeSession("session-a");
    const sessionB = makeSession("session-b");
    sessionB.restoreScrollback([makeMsg(sessionB.id, "session B content")]);

    const { client: first, received: rcvA } = makeClient("tg:user-1");
    const { client: second, received: rcvB } = makeClient("tg:user-1"); // same id

    sessionA.attach(first); // session A has no scrollback → nothing received
    sessionA.detach("tg:user-1");
    sessionB.attach(second); // session B replays to second.send

    expect(rcvA).toHaveLength(0);
    expect(rcvB).toHaveLength(1);
    expect(rcvB[0]?.type).toBe("scrollback.replay");
  });

  it("sweeping detach across all sessions (disconnectClient pattern) empties every session", () => {
    // SessionManager.disconnectClient iterates all sessions and calls detach.
    // Mirror that here to confirm the invariant holds across N sessions.
    const CLIENT_ID = "tg:user-1";
    const sessions = [makeSession("s1"), makeSession("s2"), makeSession("s3")];
    const { client } = makeClient(CLIENT_ID);

    // Simulate a user who accumulated attachments across multiple sessions.
    for (const s of sessions) s.attach(client);
    for (const s of sessions) expect(s.attachedClientCount).toBe(1);

    // disconnectClient sweeps every session.
    for (const s of sessions) s.detach(CLIENT_ID);

    for (const s of sessions) expect(s.attachedClientCount).toBe(0);
  });

  it("detaching from one session does not affect other sessions", () => {
    const sessionA = makeSession("session-a");
    const sessionB = makeSession("session-b");
    const clientA = makeClient("c-a").client;
    const clientB = makeClient("c-b").client;

    sessionA.attach(clientA);
    sessionB.attach(clientB);

    sessionA.detach("c-a");

    expect(sessionA.attachedClientCount).toBe(0);
    expect(sessionB.attachedClientCount).toBe(1); // unaffected
  });
});
