import { describe, it, expect } from "vitest";
import { pendingApprovalsToNotify, evictToCap } from "./desktop-notifications";
import type { SessionInfo, SessionMessage } from "../protocol/types";

function sess(id: string, status: SessionInfo["status"]): SessionInfo {
  return {
    id,
    name: id,
    workdir: "/tmp",
    status,
    createdBy: "u",
    createdAt: "2026-05-04T08:00:00Z",
    attachedClients: 0,
  } as SessionInfo;
}

function waitingToolMsg(id: string, approvalId: string): SessionMessage {
  return {
    type: "session.message",
    sessionId: id,
    messageId: `${id}-m`,
    role: "tool_call",
    content: "cmd",
    identity: { sub: "x", name: "a", type: "agent" },
    timestamp: "2026-05-04T08:00:00Z",
    tool: {
      name: "Bash",
      toolId: "t",
      state: { phase: "waiting_confirmation", approvalId, description: "rm -rf", input: {} },
    },
  } as unknown as SessionMessage;
}

describe("pendingApprovalsToNotify (all sessions)", () => {
  it("picks up an approval on a BACKGROUND session, skips non-waiting ones", () => {
    const sessions = [
      sess("focused", "thinking"), // active, not waiting → ignored
      sess("bg", "waiting_approval"), // background approval → notify
      sess("idle", "idle"),
    ];
    const msgs: Record<string, SessionMessage[]> = {
      bg: [waitingToolMsg("bg", "ap-bg")],
    };
    const out = pendingApprovalsToNotify(sessions, (id) => msgs[id] ?? []);
    expect(out.map((o) => o.approvalId)).toEqual(["ap-bg"]);
    expect(out[0]!.sessionName).toBe("bg");
  });

  it("returns nothing when a waiting session has no confirming tool yet", () => {
    const out = pendingApprovalsToNotify([sess("s", "waiting_approval")], () => []);
    expect(out).toEqual([]);
  });
});

describe("evictToCap", () => {
  it("drops the oldest half once the cap is reached (insertion order)", () => {
    const set = new Set(["a", "b", "c", "d"]);
    evictToCap(set, 4); // size 4 >= cap 4 → drop oldest 2
    expect([...set]).toEqual(["c", "d"]);
  });
  it("is a no-op below the cap", () => {
    const set = new Set(["a", "b"]);
    evictToCap(set, 4);
    expect([...set]).toEqual(["a", "b"]);
  });
});
