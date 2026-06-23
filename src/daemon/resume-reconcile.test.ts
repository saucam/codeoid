import { describe, test, expect } from "bun:test";
import { reconcileResumedMessage } from "./resume-reconcile";
import type { SessionMessage, ToolState } from "../protocol/types";

const SID = "test-session";
const AGENT = {
  sub: "spiffe://zeroid.dev/personal/dev/agent/test",
  name: "test",
  type: "agent" as const,
};

function msg(
  partial: Partial<SessionMessage> & Pick<SessionMessage, "role" | "messageId">,
): SessionMessage {
  return {
    type: "session.message",
    sessionId: SID,
    content: "",
    identity: AGENT,
    timestamp: "2026-06-23T09:17:14.000Z",
    ...partial,
  };
}

function toolMsg(name: string, toolId: string, state: ToolState): SessionMessage {
  return msg({ role: "tool_call", messageId: `m-${toolId}`, tool: { toolId, name, state } });
}

const NON_TERMINAL = ["streaming", "waiting_confirmation", "executing"];

describe("reconcileResumedMessage", () => {
  // Shortened stand-in for transcript 4e2614f7…, which ended at seq 2002
  // (09:17:15Z) with an `Edit` still `executing` and no terminator because
  // the daemon was killed mid-tool. On resume the session must come back with
  // NO tool left in a running phase.
  test("a transcript cut off mid-Edit resumes with no phantom running tool", () => {
    const transcript: SessionMessage[] = [
      msg({ role: "user", content: "update the ADR", messageId: "u1" }),
      toolMsg("Read", "t_read", { phase: "completed", success: true, output: "…" }),
      toolMsg("Edit", "t_edit_done", { phase: "completed", success: true }),
      // turn cut off here — daemon killed while this Edit was executing:
      toolMsg("Edit", "t_edit_inflight", { phase: "executing", elapsedMs: 840 }),
    ];

    const resumed = transcript.map(reconcileResumedMessage);

    const stuck = resumed.filter(
      (m) => m.role === "tool_call" && NON_TERMINAL.includes(m.tool!.state.phase),
    );
    expect(stuck).toHaveLength(0);

    const inflight = resumed.find((m) => m.tool?.toolId === "t_edit_inflight");
    expect(inflight?.tool?.state).toMatchObject({ phase: "cancelled", reason: "interrupted" });

    // Completed tools are left exactly as they were.
    expect(resumed.find((m) => m.tool?.toolId === "t_edit_done")?.tool?.state.phase).toBe(
      "completed",
    );
  });

  test("rewrites an in-flight `executing` tool call to cancelled/interrupted", () => {
    const out = reconcileResumedMessage(toolMsg("Edit", "t1", { phase: "executing" }));
    expect(out.tool?.state).toMatchObject({ phase: "cancelled", reason: "interrupted" });
  });

  test("rewrites a `streaming` (input never finished) tool call", () => {
    const out = reconcileResumedMessage(toolMsg("Bash", "t2", { phase: "streaming" }));
    expect(out.tool?.state).toMatchObject({ phase: "cancelled", reason: "interrupted" });
  });

  test("rewrites a `waiting_confirmation` tool call (pre-existing behavior, preserved)", () => {
    const out = reconcileResumedMessage(
      toolMsg("Write", "t3", {
        phase: "waiting_confirmation",
        input: {},
        description: "d",
        approvalId: "a1",
      }),
    );
    expect(out.tool?.state).toMatchObject({ phase: "cancelled", reason: "interrupted" });
  });

  test("leaves a terminal `completed` tool call untouched", () => {
    const done = toolMsg("Read", "t4", { phase: "completed", success: true, output: "ok" });
    expect(reconcileResumedMessage(done)).toBe(done);
  });

  test("leaves a terminal `cancelled` tool call untouched", () => {
    const cancelled = toolMsg("Read", "t5", { phase: "cancelled", reason: "denied" });
    expect(reconcileResumedMessage(cancelled)).toBe(cancelled);
  });

  test("leaves non-tool messages untouched", () => {
    const user = msg({ role: "user", content: "hi", messageId: "u1" });
    expect(reconcileResumedMessage(user)).toBe(user);
  });

  test("is idempotent over a re-resume (reconciled message reconciles to itself)", () => {
    const once = reconcileResumedMessage(toolMsg("Edit", "t6", { phase: "executing" }));
    expect(reconcileResumedMessage(once)).toBe(once);
  });

  test("preserves identity, toolId, name and input while only flipping state", () => {
    const orphan = toolMsg("Edit", "t_edit", { phase: "executing" });
    orphan.tool!.input = { file_path: "/x", old_string: "a", new_string: "b" };
    const out = reconcileResumedMessage(orphan);
    expect(out.messageId).toBe(orphan.messageId);
    expect(out.identity).toEqual(AGENT);
    expect(out.tool?.toolId).toBe("t_edit");
    expect(out.tool?.name).toBe("Edit");
    expect(out.tool?.input).toEqual({ file_path: "/x", old_string: "a", new_string: "b" });
  });
});
