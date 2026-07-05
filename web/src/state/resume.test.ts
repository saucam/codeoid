import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetResumeForTest,
  clearResumeCursor,
  noteLiveSeq,
  noteReplayFrame,
  resumeFor,
} from "./resume";
import type { ScrollbackReplayMsg } from "../protocol/types";

function replayFrame(overrides: Partial<ScrollbackReplayMsg> = {}): ScrollbackReplayMsg {
  return {
    type: "scrollback.replay",
    sessionId: "s1",
    messages: [],
    mode: "snapshot",
    resumeKey: "key-a",
    maxSeq: 10,
    ...overrides,
  };
}

describe("resume cursors", () => {
  beforeEach(() => _resetResumeForTest());

  it("no cursor until a replay frame with resume meta arrives", () => {
    expect(resumeFor("s1")).toBeUndefined();
    // Legacy daemon frame (no resumeKey/maxSeq) establishes nothing.
    noteReplayFrame(replayFrame({ resumeKey: undefined, maxSeq: undefined }));
    expect(resumeFor("s1")).toBeUndefined();
  });

  it("replay frame establishes the cursor; same-key frames only ever raise it", () => {
    noteReplayFrame(replayFrame({ maxSeq: 10 }));
    expect(resumeFor("s1")).toEqual({ key: "key-a", sinceSeq: 10 });

    noteReplayFrame(replayFrame({ maxSeq: 25 }));
    expect(resumeFor("s1")!.sinceSeq).toBe(25);

    // A stale/duplicate frame must never LOWER the cursor (leading > lagging
    // is the dangerous direction; lowering is safe but wasteful — we keep max).
    noteReplayFrame(replayFrame({ maxSeq: 5 }));
    expect(resumeFor("s1")!.sinceSeq).toBe(25);
  });

  it("a NEW resumeKey (daemon restart) resets the cursor to the new domain", () => {
    noteReplayFrame(replayFrame({ resumeKey: "key-a", maxSeq: 100 }));
    noteReplayFrame(replayFrame({ resumeKey: "key-b", maxSeq: 3 }));
    // Old-domain seq 100 is meaningless under key-b — cursor must be 3, not 100.
    expect(resumeFor("s1")).toEqual({ key: "key-b", sinceSeq: 3 });
  });

  it("live seqs raise the cursor, never lower it, and are dropped without a key", () => {
    noteLiveSeq("s1", 42); // no cursor yet — nothing to anchor the domain
    expect(resumeFor("s1")).toBeUndefined();

    noteReplayFrame(replayFrame({ maxSeq: 10 }));
    noteLiveSeq("s1", 12);
    expect(resumeFor("s1")!.sinceSeq).toBe(12);
    noteLiveSeq("s1", 11);
    expect(resumeFor("s1")!.sinceSeq).toBe(12);
    noteLiveSeq("s1", undefined);
    expect(resumeFor("s1")!.sinceSeq).toBe(12);
  });

  it("cursors are per-session and cleared on destroy", () => {
    noteReplayFrame(replayFrame({ sessionId: "s1", maxSeq: 7 }));
    noteReplayFrame(replayFrame({ sessionId: "s2", resumeKey: "key-z", maxSeq: 3 }));
    expect(resumeFor("s1")!.sinceSeq).toBe(7);
    expect(resumeFor("s2")).toEqual({ key: "key-z", sinceSeq: 3 });

    clearResumeCursor("s1");
    expect(resumeFor("s1")).toBeUndefined();
    expect(resumeFor("s2")).toBeDefined();
  });
});
