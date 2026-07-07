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

  it("mergeSession upserts a session it hasn't seen yet (info_update from another client)", () => {
    // Regression: produce() never runs on an undefined leaf, so the old
    // "materialises lazily" path silently dropped info_update for an unknown id.
    mergeSession(s("remote-1", "2026-05-02T08:00:00Z", { name: "remote" }));
    expect(getSession("remote-1")?.name).toBe("remote");
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

  it("ingestSessionList merges per-id: unchanged sessions keep their store object identity", () => {
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { name: "alpha" }),
      s("b", "2026-05-02T08:00:00Z"),
    ]);
    const before = getSession("a");
    // Fresh payload objects, same field values for "a", changed status for "b".
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { name: "alpha" }),
      s("b", "2026-05-02T08:00:00Z", { status: "thinking" }),
    ]);
    expect(getSession("a")).toBe(before!);
    expect(getSession("a")?.name).toBe("alpha");
    expect(getSession("b")?.status).toBe("thinking");
  });

  it("ingestSessionList updates changed fields, adds new sessions, deletes missing ones", () => {
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { name: "old-name" }),
      s("gone", "2026-05-02T08:00:00Z"),
    ]);
    const before = getSession("a");
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { name: "new-name" }),
      s("fresh", "2026-05-03T08:00:00Z"),
    ]);
    // Updated in place — identity preserved even when a field changed.
    expect(getSession("a")).toBe(before!);
    expect(getSession("a")?.name).toBe("new-name");
    expect(getSession("gone")).toBeUndefined();
    expect(getSession("fresh")?.id).toBe("fresh");
    expect(sessionList().map((x) => x.id)).toEqual(["fresh", "a"]);
  });

  it("ingestSessionList drops fields the daemon no longer sends", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z", { model: "claude-opus-4-7" })]);
    expect(getSession("a")?.model).toBe("claude-opus-4-7");
    ingestSessionList([s("a", "2026-05-01T08:00:00Z")]);
    expect(getSession("a")?.model).toBeUndefined();
  });

  it("ingestSessionList ignores prototype-polluting keys in network payloads", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z")]);
    // JSON.parse yields "__proto__" as a plain own property (unlike an
    // object literal); the merge loop must not assign it through.
    const evil = JSON.parse(
      '{"id":"a","name":"renamed","workdir":"/tmp","status":"idle","createdBy":"you","createdAt":"2026-05-01T08:00:00Z","attachedClients":0,"__proto__":{"polluted":true}}',
    ) as SessionInfo;
    ingestSessionList([evil]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(getSession("a")!)).toBe(Object.prototype);
    expect(getSession("a")?.name).toBe("renamed"); // legitimate fields still merge
  });

  it("ingestSessionList keeps object-field identity when deep-equal", () => {
    // Every list refresh delivers fresh array/object references; when the
    // contents are unchanged the merge must not reassign the field (which
    // would notify its subscribers on every poll for nothing).
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { pinnedFiles: ["x.ts", "y.ts"] }),
    ]);
    const before = getSession("a")?.pinnedFiles;
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { pinnedFiles: ["x.ts", "y.ts"] }),
    ]);
    expect(getSession("a")?.pinnedFiles).toBe(before); // same reference
    // A real change still lands.
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { pinnedFiles: ["x.ts"] }),
    ]);
    expect(getSession("a")?.pinnedFiles).toEqual(["x.ts"]);
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
