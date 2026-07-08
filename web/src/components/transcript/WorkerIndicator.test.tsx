// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import WorkerIndicator from "./WorkerIndicator";
import {
  ingestSessionList,
  focusSession,
  _resetSessionsForTest,
} from "../../state/sessions";
import { applyMessage, _resetMessagesForTest } from "../../state/messages";
import type { SessionInfo, SessionStatus, SessionMessage } from "../../protocol/types";

function sess(status: SessionStatus): SessionInfo {
  return {
    id: "s",
    name: "s",
    workdir: "/tmp",
    status,
    createdBy: "u",
    createdAt: "2026-05-04T08:00:00Z",
    attachedClients: 0,
  };
}
const VERB_RE = /thinking|drafting|considering|researching|weighing/;

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
  _resetMessagesForTest();
});

describe("WorkerIndicator", () => {
  it("shows while the focused session is thinking", () => {
    ingestSessionList([sess("thinking")]);
    focusSession("s");
    const { container } = render(() => <WorkerIndicator />);
    expect(container.textContent ?? "").toMatch(VERB_RE);
  });

  it("is hidden when the focused session is idle", () => {
    ingestSessionList([sess("idle")]);
    focusSession("s");
    const { container } = render(() => <WorkerIndicator />);
    expect((container.textContent ?? "").trim()).toBe("");
  });

  it("clears a stranded 'thinking' once activity goes stale (defensive cap)", () => {
    vi.useFakeTimers();
    try {
      ingestSessionList([sess("thinking")]);
      focusSession("s");
      // Register live activity "now" so the staleness clock starts fresh.
      applyMessage({
        type: "session.message",
        sessionId: "s",
        messageId: "m1",
        role: "assistant",
        content: "working",
        identity: { sub: "x", name: "a", type: "agent" },
        timestamp: "2026-05-04T08:00:00Z",
      } as SessionMessage);
      const { container } = render(() => <WorkerIndicator />);
      expect(container.textContent ?? "").toMatch(VERB_RE); // visible while fresh
      // No further activity; advance past the 90s stale window (the 1.5s tick
      // drives re-evaluation; fake timers also advance Date.now()).
      vi.advanceTimersByTime(95_000);
      expect((container.textContent ?? "").trim()).toBe(""); // cleared
    } finally {
      vi.useRealTimers();
    }
  });
});
