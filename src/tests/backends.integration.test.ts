/**
 * Cross-backend session integration — opt-in, against REAL backends.
 *
 * Proves the two things a meta-harness must never get wrong, with the actual
 * agent binaries/SDKs (not fakes), through the real SessionManager verbs:
 *
 *   FRESH   — a brand-new session on each backend takes a turn and replies.
 *   RESUME  — a conversation STARTED on backend S, then forked onto a
 *             DIFFERENT backend T, carries its history: T answers a question
 *             about a fact only established during S's turn. This is codeoid's
 *             headline promise ("branch claude, continue on codex") and it
 *             exercises the exact seedFromHistory path fork/switch use.
 *
 * Gated: skipped unless CODEOID_INTEGRATION=1. The backends exercised come
 * from CODEOID_INTEGRATION_BACKENDS (comma list, default "claude,codex") and
 * MUST be installed + authenticated on the runner. Example:
 *
 *   CODEOID_INTEGRATION=1 CODEOID_INTEGRATION_BACKENDS=claude,codex,pi \
 *     bun test src/tests/backends.integration.test.ts
 *
 * Verified locally against claude (Agent SDK) + codex (@openai/codex@0.144.1):
 * fresh turns reply, and claude↔codex resume carries the fact both ways.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SessionManager } from "../daemon/session-manager.js";
import { createDefaultProviderRegistry } from "../daemon/providers/registry.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage } from "../protocol/types.js";

const RUN = process.env.CODEOID_INTEGRATION === "1";
const BACKENDS = (process.env.CODEOID_INTEGRATION_BACKENDS ?? "claude,codex")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const AUTH: AuthContext = {
  sub: "user:it",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-it",
  projectId: "proj-it",
};

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;
let available: string[] = [];

beforeAll(() => {
  if (!RUN) {
    // eslint-disable-next-line no-console
    console.log("[backends integration] SKIPPED — set CODEOID_INTEGRATION=1 (+ authed backends) to run.");
    return;
  }
  tmp = mkdtempSync(join(tmpdir(), "codeoid-backends-it-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  // Enable the binary backends; claude is always registered, gemini/openai
  // gate on their keys inside createDefaultProviderRegistry.
  const registry = createDefaultProviderRegistry({
    providers: { codex: { enabled: true }, pi: { enabled: true } },
  } as never);
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    providers: registry,
  } as never);
  available = BACKENDS.filter((id) => registry.has(id));
  const missing = BACKENDS.filter((id) => !registry.has(id));
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[backends integration] requested but NOT available (skipping those): ${missing.join(", ")}`);
  }
});

afterAll(async () => {
  if (!RUN) return;
  // No arbitrary settle delay: every turn was awaited to idle via
  // sendAndSettle, and flush() drains queued transcript writes.
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

// ── Harness ────────────────────────────────────────────────────────────────

function makeClient(): { id: string; auth: AuthContext; received: DaemonMessage[]; send: (m: DaemonMessage) => void } {
  const received: DaemonMessage[] = [];
  return { id: randomUUID(), auth: AUTH, received, send: (m) => received.push(m) };
}

type Client = ReturnType<typeof makeClient>;

async function createOn(c: Client, providerId: string): Promise<string> {
  const resp = await manager.handle(
    { type: "session.create", id: randomUUID(), name: providerId, workdir: tmp, providerId } as never,
    AUTH,
    c as never,
  );
  expect((resp as { type: string }).type).toBe("response.ok");
  return (resp as { data: { id: string } }).data.id;
}

/** Send a turn and wait for the session to return to idle (or error). */
async function sendAndSettle(c: Client, sessionId: string, text: string): Promise<void> {
  await manager.handle({ type: "session.attach", id: randomUUID(), sessionId } as never, AUTH, c as never);
  const start = c.received.length;
  await manager.handle({ type: "session.send", id: randomUUID(), sessionId, text } as never, AUTH, c as never);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const settled = c.received
      .slice(start)
      .some((m) => m.type === "session.status_change" && ((m as { status: string }).status === "idle" || (m as { status: string }).status === "error"));
    if (settled) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`[${sessionId}] never settled after send`);
}

function partText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? ""))).join("");
  return "";
}

/** All assistant text broadcast for `sessionId` after index `since`. */
function assistantText(c: Client, sessionId: string, since: number): string {
  return c.received
    .slice(since)
    .filter((m) => m.type === "session.message" && (m as { sessionId: string }).sessionId === sessionId && (m as { role?: string }).role === "assistant")
    .map((m) => partText((m as { content: unknown }).content))
    .join("\n");
}

function assertNoError(c: Client, sessionId: string, since: number): void {
  const errs = c.received
    .slice(since)
    .filter(
      (m) =>
        m.type === "session.status_change" &&
        (m as { sessionId: string }).sessionId === sessionId &&
        (m as { status: string }).status === "error",
    );
  expect(errs.length, `backend errored during turn: ${JSON.stringify(errs)}`).toBe(0);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("backends integration (real)", () => {
  (RUN ? it : it.skip)(
    "at least one requested backend is available",
    () => {
      expect(available.length).toBeGreaterThan(0);
    },
  );

  // FRESH: every enabled backend takes a brand-new turn and replies.
  for (const backend of BACKENDS) {
    (RUN ? it : it.skip)(
      `FRESH: ${backend} — a new session takes a turn and replies`,
      async () => {
        if (!available.includes(backend)) return; // requested but unavailable
        const c = makeClient();
        const sid = await createOn(c, backend);
        const since = c.received.length;
        await sendAndSettle(c, sid, "Reply with exactly the word: ok");
        assertNoError(c, sid, since);
        expect(assistantText(c, sid, since).toLowerCase()).toContain("ok");
      },
      150_000,
    );
  }

  // RESUME: fork a conversation from S onto a DIFFERENT backend T; T must
  // answer using the fact only established during S's turn.
  for (const source of BACKENDS) {
    for (const target of BACKENDS) {
      if (source === target) continue;
      (RUN ? it : it.skip)(
        `RESUME: ${source} → ${target} — forked backend recalls the fact`,
        async () => {
          if (!available.includes(source) || !available.includes(target)) return;
          const c = makeClient();
          const sid = await createOn(c, source);
          await sendAndSettle(c, sid, "My favorite number is 42. Reply with just: noted");

          const fork = await manager.handle(
            { type: "session.fork", id: randomUUID(), sessionId: sid, providerId: target } as never,
            AUTH,
            c as never,
          );
          expect((fork as { type: string }).type).toBe("response.ok");
          const forkData = (fork as { data: { id: string; providerId?: string } }).data;
          expect(forkData.providerId).toBe(target);

          const since = c.received.length;
          await sendAndSettle(c, forkData.id, "What is my favorite number? Reply with ONLY the number.");
          assertNoError(c, forkData.id, since);
          expect(assistantText(c, forkData.id, since)).toContain("42");
        },
        200_000,
      );
    }
  }
});
