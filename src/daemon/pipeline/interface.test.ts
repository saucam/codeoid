import { describe, expect, test } from "bun:test";
import { ACTIVE_STATUSES, isTerminal, type PipelineStatus, TERMINAL_STATUSES } from "./interface";

const ALL_STATUSES: PipelineStatus[] = [
  "draft",
  "running",
  "halted",
  "merged",
  "done",
  "failed",
  "abandoned",
];

describe("status partitions", () => {
  test("ACTIVE and TERMINAL partition every status (complete + disjoint)", () => {
    expect([...ACTIVE_STATUSES, ...TERMINAL_STATUSES].sort()).toEqual([...ALL_STATUSES].sort());
    for (const s of ACTIVE_STATUSES) expect(TERMINAL_STATUSES.includes(s)).toBe(false);
  });

  test("isTerminal agrees with TERMINAL_STATUSES for every status", () => {
    for (const s of ALL_STATUSES) expect(isTerminal(s)).toBe(TERMINAL_STATUSES.includes(s));
  });
});
