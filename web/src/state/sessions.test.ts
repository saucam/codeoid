import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetSessionsForTest,
  focusedSession,
  focusedSessionId,
  focusNext,
  focusPrev,
  focusSession,
  getSession,
  ingestSessionList,
  mergeSession,
  removeSession,
  sessionList,
  setSessionStatus,
} from "./sessions";
import type { SessionInfo } from "../protocol/types";

function s(id: string, createdAt: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    name: id,
    workdir: "/tmp",
    status: "idle",
    createdBy: "you",
    createdAt,
    attachedClients: 0,
    ...overrides,
  };
}

describe("sessions store", () => {
  beforeEach(() => _resetSessionsForTest());

  it("ingests a list and sorts newest-first", () => {
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z"),
      s("b", "2026-05-04T08:00:00Z"),
      s("c", "2026-05-02T08:00:00Z"),
    ]);
    expect(sessionList().map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("auto-focuses the most recent on first ingest", () => {
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z"),
      s("b", "2026-05-04T08:00:00Z"),
    ]);
    expect(focusedSessionId()).toBe("b");
    expect(focusedSession()?.id).toBe("b");
  });

  it("preserves explicit focus across ingest if focused id still exists", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z")]);
    focusSession("a");
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z"),
      s("b", "2026-05-04T08:00:00Z"),
    ]);
    expect(focusedSessionId()).toBe("a");
  });

  it("re-focuses on the most recent if focused id disappears", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z")]);
    focusSession("a");
    ingestSessionList([s("b", "2026-05-04T08:00:00Z")]);
    expect(focusedSessionId()).toBe("b");
  });

  it("merges partial updates without dropping fields", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z", { name: "alpha" })]);
    mergeSession({ id: "a", model: "claude-opus-4-7" });
    expect(getSession("a")?.name).toBe("alpha");
    expect(getSession("a")?.model).toBe("claude-opus-4-7");
  });

  it("setSessionStatus is a noop for unknown sessions", () => {
    setSessionStatus("ghost", "thinking");
    expect(getSession("ghost")).toBeUndefined();
  });

  it("setSessionStatus updates only the status field", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z")]);
    setSessionStatus("a", "tool_running");
    expect(getSession("a")?.status).toBe("tool_running");
    expect(getSession("a")?.workdir).toBe("/tmp");
  });

  it("removeSession refocuses the next remaining session", () => {
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z"),
      s("b", "2026-05-04T08:00:00Z"),
    ]);
    focusSession("b");
    removeSession("b");
    expect(getSession("b")).toBeUndefined();
    expect(focusedSessionId()).toBe("a");
  });

  it("focusNext / focusPrev wrap around the sorted list", () => {
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z"),
      s("b", "2026-05-02T08:00:00Z"),
      s("c", "2026-05-03T08:00:00Z"),
    ]);
    // sorted newest-first → c, b, a
    focusSession("c");
    focusNext();
    expect(focusedSessionId()).toBe("b");
    focusNext();
    expect(focusedSessionId()).toBe("a");
    focusNext();
    expect(focusedSessionId()).toBe("c");
    focusPrev();
    expect(focusedSessionId()).toBe("a");
  });
});
