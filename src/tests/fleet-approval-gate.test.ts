/**
 * The R3 hard approval gate (P4) — send-class fleet tools must NEVER
 * auto-approve, even in autonomous mode with an unlimited budget. This is
 * the safety invariant that keeps every dispatch behind the owner's explicit
 * confirmation; if it regresses, an autonomous conductor could direct the
 * fleet silently.
 *
 * Driven through a real Session + MockSessionProvider (which invokes
 * canUseTool exactly like the SDK's PreToolUse gate).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../daemon/session.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import type { AuthContext, DaemonMessage } from "../protocol/types.js";

const TEST_AUTH: AuthContext = {
  sub: "user:gate-test",
  scopes: [],
  delegationDepth: 0,
  accountId: "acc-gate",
  projectId: "proj-gate",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-gate-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  try { await transcriptStore.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function toolTurn(name: string, input: Record<string, unknown>): ProviderEvent[] {
  return [
    {
      type: "tool_start",
      toolId: "t1",
      sdkToolUseId: "sdk-t1",
      name,
      input,
      approvalId: "approval-1",
    } as ProviderEvent,
    {
      type: "turn_done",
      result: {
        providerId: "mock",
        model: "mock-model",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        durationMs: 1,
      },
    } as ProviderEvent,
  ];
}

function makeSession(provider: MockSessionProvider): Session {
  const id = randomUUID();
  store.createSession({
    id,
    name: "gate-test",
    workdir: tmp,
    status: "idle",
    createdBy: TEST_AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: TEST_AUTH.accountId,
    projectId: TEST_AUTH.projectId,
  });
  return new Session({
    name: "gate-test",
    workdir: tmp,
    auth: TEST_AUTH,
    store,
    transcriptStore,
    existingId: id,
    _testProvider: provider,
  });
}

function attachRecorder(session: Session): DaemonMessage[] {
  const received: DaemonMessage[] = [];
  session.attach({
    id: "client-1",
    auth: TEST_AUTH,
    send: (msg: DaemonMessage) => {
      received.push(msg);
    },
  });
  return received;
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("R3 hard approval gate", () => {
  test("fleet_send requires approval even in autonomous mode with unlimited budget", async () => {
    const provider = new MockSessionProvider("mock", [
      toolTurn("mcp__codeoid_fleet__fleet_send", { session: "authz-fix", message: "go" }),
    ]);
    const session = makeSession(provider);
    const received = attachRecorder(session);
    session.setMode("autonomous"); // no budget = unlimited auto-approve

    await session.send("dispatch it", TEST_AUTH);
    await until(() => session.status === "waiting_approval");

    // The turn must be genuinely PARKED on the approval — not just showing
    // the waiting UI while auto-approving underneath. If the hard gate were
    // gone, autonomous mode would auto-allow and the turn would reach idle
    // on its own right here.
    await new Promise((r) => setTimeout(r, 150));
    expect(session.status).toBe("waiting_approval");

    // The approval request reached the client with the FULL tool input.
    type ToolWireMsg = {
      type: string;
      role?: string;
      tool?: { state?: { phase?: string; approvalId?: string; input?: unknown } };
    };
    const waiting = (received as ToolWireMsg[])
      .filter((m) => m.type === "session.message" && m.role === "tool_call")
      .map((m) => m.tool?.state)
      .find((s) => s?.phase === "waiting_confirmation");
    expect(waiting).toBeDefined();
    expect(waiting?.approvalId).toBe("approval-1");
    expect(waiting?.input).toEqual({ session: "authz-fix", message: "go" });

    // Owner denies — the turn completes without executing the dispatch.
    session.approve("approval-1", false, TEST_AUTH);
    await until(() => session.status === "idle" || session.status === "error");
  });

  test("contrast: an ordinary tool DOES auto-approve in autonomous mode", async () => {
    const provider = new MockSessionProvider("mock", [
      toolTurn("Bash", { command: "echo hi" }),
    ]);
    const session = makeSession(provider);
    const received = attachRecorder(session);
    session.setMode("autonomous");

    await session.send("run it", TEST_AUTH);
    await until(() => session.status === "idle" || session.status === "error");

    // Never waited for approval, and the audit trail shows the auto-approve.
    const sawWaiting = received.some(
      (m) => m.type === "session.status_change" && m.status === "waiting_approval",
    );
    expect(sawWaiting).toBe(false);
  });
});
