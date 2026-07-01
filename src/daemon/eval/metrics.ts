/**
 * Session-resolution eval harness — metrics.
 *
 * The conductor's linchpin capability (docs/conductor-session-resolution.md) is
 * only trustworthy against a labeled set. This module measures a resolver:
 * given a fuzzy natural-language reference, does it rank the correct session
 * first (precision@1), and how fast?
 *
 * Known-item retrieval: each case has exactly ONE correct session, so recall@k
 * equals hit@k. Precision@1 is the metric that matters — a wrong top-1 routes a
 * command to the wrong repo.
 */

/** One labeled example: a reference and the session it should resolve to. */
export interface EvalCase {
  reference: string;
  expectedSessionId: string;
}

/** A resolver returns session ids in rank order (best first). */
export type Resolver = (reference: string) => Promise<string[]> | string[];

export interface EvalReport {
  n: number;
  precisionAt1: number;
  mrr: number;
  recallAt5: number;
  recallAt10: number;
  p50Ms: number;
  p95Ms: number;
}

/** Rank of the expected id within a ranked list (0-based), or -1 if absent. */
function rankOf(expected: string, ranked: string[]): number {
  return ranked.indexOf(expected);
}

/** Fraction of cases whose top-1 result is the expected session. */
export function precisionAt1(cases: EvalCase[], ranked: string[][]): number {
  if (cases.length === 0) return 0;
  let hits = 0;
  for (let i = 0; i < cases.length; i++) {
    if (ranked[i]?.[0] === cases[i]!.expectedSessionId) hits++;
  }
  return hits / cases.length;
}

/** Mean reciprocal rank — 1/(rank+1) averaged over cases (0 if not found). */
export function mrr(cases: EvalCase[], ranked: string[][]): number {
  if (cases.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < cases.length; i++) {
    const r = rankOf(cases[i]!.expectedSessionId, ranked[i] ?? []);
    if (r >= 0) sum += 1 / (r + 1);
  }
  return sum / cases.length;
}

/** Fraction of cases whose expected session appears in the top-k (= hit@k). */
export function recallAtK(cases: EvalCase[], ranked: string[][], k: number): number {
  if (cases.length === 0) return 0;
  let hits = 0;
  for (let i = 0; i < cases.length; i++) {
    const r = rankOf(cases[i]!.expectedSessionId, ranked[i] ?? []);
    if (r >= 0 && r < k) hits++;
  }
  return hits / cases.length;
}

/** Nearest-rank percentile (p in [0,100]) of a numeric sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx]!;
}

/**
 * Run a resolver over every case, timing each call, and compute the report.
 * Resolvers may be sync or async.
 */
export async function runEval(resolver: Resolver, cases: EvalCase[]): Promise<EvalReport> {
  const ranked: string[][] = [];
  const latencies: number[] = [];

  for (const c of cases) {
    const t0 = performance.now();
    const result = await resolver(c.reference);
    latencies.push(performance.now() - t0);
    ranked.push(result);
  }

  return {
    n: cases.length,
    precisionAt1: precisionAt1(cases, ranked),
    mrr: mrr(cases, ranked),
    recallAt5: recallAtK(cases, ranked, 5),
    recallAt10: recallAtK(cases, ranked, 10),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
  };
}

/** One-line human-readable summary for logging a run. */
export function formatReport(r: EvalReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return (
    `n=${r.n}  P@1=${pct(r.precisionAt1)}  MRR=${r.mrr.toFixed(3)}  ` +
    `R@5=${pct(r.recallAt5)}  R@10=${pct(r.recallAt10)}  ` +
    `p50=${r.p50Ms.toFixed(0)}ms  p95=${r.p95Ms.toFixed(0)}ms`
  );
}
