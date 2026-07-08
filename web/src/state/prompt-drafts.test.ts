// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDraft, setDraft, clearDraft, _resetDraftsForTest } from "./prompt-drafts";

const KEY = "codeoid.draftsByID";

describe("prompt drafts (debounced persistence)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    _resetDraftsForTest();
  });
  afterEach(() => vi.useRealTimers());

  it("updates in-memory immediately but debounces the localStorage write", () => {
    setDraft("s1", "hello");
    expect(getDraft("s1")).toBe("hello"); // in-memory reads are synchronous
    expect(localStorage.getItem(KEY)).toBeNull(); // not persisted yet (debounced)
    vi.advanceTimersByTime(400);
    expect(localStorage.getItem(KEY)).toContain("hello"); // trailing write landed
  });

  it("coalesces rapid edits into a single localStorage write", () => {
    const setSpy = vi.spyOn(Storage.prototype, "setItem");
    setDraft("s1", "a");
    setDraft("s1", "ab");
    setDraft("s1", "abc");
    expect(setSpy).not.toHaveBeenCalled(); // still pending
    vi.advanceTimersByTime(400);
    expect(setSpy).toHaveBeenCalledTimes(1); // one write for three keystrokes
    expect(getDraft("s1")).toBe("abc");
    setSpy.mockRestore();
  });

  it("clearDraft removes the entry", () => {
    setDraft("s1", "x");
    clearDraft("s1");
    expect(getDraft("s1")).toBe("");
  });
});
