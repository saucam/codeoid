// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

vi.mock("../../state/connection", () => ({ send: vi.fn(), newRequestId: () => "r" }));

import ApprovalBar from "./ApprovalBar";
import { send } from "../../state/connection";
import {
  ingestSessionList,
  focusSession,
  _resetSessionsForTest,
} from "../../state/sessions";
import { applyMessage, _resetMessagesForTest } from "../../state/messages";
import type { SessionInfo, SessionMessage } from "../../protocol/types";

function pendingSession(): SessionInfo {
  return {
    id: "s",
    name: "s",
    workdir: "/tmp",
    status: "waiting_approval",
    createdBy: "u",
    createdAt: "2026-05-04T08:00:00Z",
    attachedClients: 0,
  } as SessionInfo;
}

function pendingToolMsg(): SessionMessage {
  return {
    type: "session.message",
    sessionId: "s",
    messageId: "m1",
    role: "tool_call",
    content: "run a command",
    identity: { sub: "x", name: "a", type: "agent" },
    timestamp: "2026-05-04T08:00:00Z",
    tool: {
      name: "Bash",
      toolId: "t1",
      state: {
        phase: "waiting_confirmation",
        approvalId: "ap-1",
        description: "rm -rf build",
        input: { command: "rm -rf build" },
      },
    },
  } as unknown as SessionMessage;
}

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
  _resetMessagesForTest();
  vi.mocked(send).mockClear();
});

describe("ApprovalBar keyboard shortcuts", () => {
  function setup() {
    ingestSessionList([pendingSession()]);
    focusSession("s");
    applyMessage(pendingToolMsg());
    return render(() => <ApprovalBar />);
  }

  it("Alt+Y approves the pending tool", () => {
    const { container } = setup();
    expect(container.textContent).toContain("Bash"); // bar is showing
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", altKey: true, bubbles: true }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.approve", approvalId: "ap-1", approved: true }),
    );
  });

  it("Alt+D denies the pending tool", () => {
    setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", altKey: true, bubbles: true }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.approve", approvalId: "ap-1", approved: false }),
    );
  });

  it("ignores the shortcut without the Alt modifier", () => {
    setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true }));
    expect(send).not.toHaveBeenCalled();
  });
});
