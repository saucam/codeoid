import { describe, test, expect } from "bun:test";
import {
  precisionAt1,
  mrr,
  recallAtK,
  percentile,
  runEval,
  type EvalCase,
} from "./metrics";

const cases: EvalCase[] = [
  { reference: "the authz latest_only fix", expectedSessionId: "A" },
  { reference: "the durga extraction eval", expectedSessionId: "B" },
  { reference: "studio receipt badge", expectedSessionId: "C" },
];

// A: correct top-1. B: correct at rank 3. C: not found.
const ranked: string[][] = [
  ["A", "X", "Y"],
  ["X", "Y", "B"],
  ["X", "Y", "Z"],
];

describe("eval metrics", () => {
  test("precision@1 counts only top-1 hits", () => {
    expect(precisionAt1(cases, ranked)).toBeCloseTo(1 / 3, 5);
  });

  test("MRR averages reciprocal ranks (1 + 1/3 + 0)/3", () => {
    expect(mrr(cases, ranked)).toBeCloseTo((1 + 1 / 3 + 0) / 3, 5);
  });

  test("recall@k = hit@k for known-item", () => {
    expect(recallAtK(cases, ranked, 1)).toBeCloseTo(1 / 3, 5); // only A in top-1
    expect(recallAtK(cases, ranked, 5)).toBeCloseTo(2 / 3, 5); // A and B, not C
  });

  test("percentile is nearest-rank", () => {
    const xs = [10, 20, 30, 40, 100];
    expect(percentile(xs, 50)).toBe(30);
    expect(percentile(xs, 100)).toBe(100);
    expect(percentile([], 50)).toBe(0);
  });

  test("runEval wires a resolver into a full report", async () => {
    const byRef = new Map<string, string[]>([
      [cases[0]!.reference, ranked[0]!],
      [cases[1]!.reference, ranked[1]!],
      [cases[2]!.reference, ranked[2]!],
    ]);
    const report = await runEval((ref) => byRef.get(ref) ?? [], cases);
    expect(report.n).toBe(3);
    expect(report.precisionAt1).toBeCloseTo(1 / 3, 5);
    expect(report.recallAt5).toBeCloseTo(2 / 3, 5);
    expect(report.p95Ms).toBeGreaterThanOrEqual(0);
  });
});
