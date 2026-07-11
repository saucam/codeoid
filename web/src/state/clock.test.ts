import { describe, it, expect, vi, afterEach } from "vitest";

describe("clock", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("bumps nowTick on the shared interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    // Fresh module instance so its interval registers against fake timers.
    vi.resetModules();
    const { nowTick, CLOCK_TICK_MS } = await import("./clock");

    expect(nowTick()).toBe(1_000_000);

    // Just short of a tick: no bump — renders reading nowTick() stay put.
    vi.advanceTimersByTime(CLOCK_TICK_MS - 1);
    expect(nowTick()).toBe(1_000_000);

    // Crossing the boundary re-reads the wall clock.
    vi.advanceTimersByTime(1);
    expect(nowTick()).toBe(1_000_000 + CLOCK_TICK_MS);

    // And keeps ticking — one interval, forever.
    vi.advanceTimersByTime(2 * CLOCK_TICK_MS);
    expect(nowTick()).toBe(1_000_000 + 3 * CLOCK_TICK_MS);
  });
});
