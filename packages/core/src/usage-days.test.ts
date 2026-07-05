import { describe, it, expect } from "bun:test";
import { padDays, utcDayKey } from "./usage-days.js";

describe("utcDayKey", () => {
  it("derives the day in UTC, not local time", () => {
    // 2026-03-10T23:30Z — still the 10th in UTC regardless of host TZ.
    expect(utcDayKey(Date.UTC(2026, 2, 10, 23, 30))).toBe("2026-03-10");
    // 2026-03-11T00:30Z — the 11th in UTC even where local time is the 10th.
    expect(utcDayKey(Date.UTC(2026, 2, 11, 0, 30))).toBe("2026-03-11");
  });
});

describe("padDays", () => {
  it("emits a dense window of UTC day keys ending at the day containing nowMs", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0); // 2026-06-15T12:00Z
    const out = padDays([], 3, now);
    expect(out.map((b) => b.day)).toEqual(["2026-06-13", "2026-06-14", "2026-06-15"]);
    expect(out.every((b) => b.costUsd === 0)).toBe(true);
  });

  it("fills known buckets and zeroes the gaps", () => {
    const now = Date.UTC(2026, 5, 15, 0, 5);
    const out = padDays(
      [
        { day: "2026-06-13", costUsd: 1.5 },
        { day: "2026-06-15", costUsd: 0.25 },
      ],
      3,
      now,
    );
    expect(out).toEqual([
      { day: "2026-06-13", costUsd: 1.5 },
      { day: "2026-06-14", costUsd: 0 },
      { day: "2026-06-15", costUsd: 0.25 },
    ]);
  });

  it("crosses month boundaries and never skips or duplicates a day (UTC has no DST)", () => {
    // Window spanning a US DST transition (2026-03-08) — UTC stepping must
    // still produce strictly consecutive unique days.
    const now = Date.UTC(2026, 2, 10, 1, 0);
    const out = padDays([], 7, now);
    expect(out.map((b) => b.day)).toEqual([
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
    expect(new Set(out.map((b) => b.day)).size).toBe(7);
  });
});
