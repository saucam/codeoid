# P0 Baseline — session resolution

Measured against the **real corpus** (16 sessions / 11 workspaces / 11,938
episodes, pulled from the Hetzner daemon's `memory.db`) with 37 hand-labeled fuzzy
references (`fixtures/session-resolution.json`), using the CURRENT resolver
(`MemoryEngine.searchSessions`, `Xenova/bge-small-en-v1.5` hybrid), on the
**current-main base** (feat/conductor rebased onto main). Reproduce:

```sh
MEMORY_DB=/path/to/memory.db bun run src/daemon/eval/baseline.ts
```

## Results

| Regime | P@1 | MRR | R@3 | R@5 | p50/p95 |
|---|---|---|---|---|---|
| **Within-workspace** (you already know the repo) | 89.2% | 0.937 | 100% | 100% | 431 / 1502 ms |
| **Cross-workspace** (conductor's real need — naive per-ws merge) | **35.1%** | 0.540 | 75.7% | 81.1% | 2140 / 4224 ms |
| **Cross-workspace — GLOBAL fusion (P1 slice 1)** | **37.8%** | 0.608 | 81.1% | **91.9%** | **10 / 24 ms** |

> Base matters: on the pre-rebase base this cross-workspace number was **21.6%**;
> rebasing onto current main lifted it to **35.1%**, because main's #94
> ("append to the vector cache on embed instead of clearing it") improves vector
> coverage. Always baseline on the current base — hence the rebase-first discipline.

## The finding — a fusion/ranking problem, not a recall problem

- **Within a workspace the resolver is already strong** (89% P@1, 100% R@3): the
  hybrid recall primitives are sound.
- **Cross-workspace it drops to 35.1% P@1** — but **R@5 is 81%**, so the right
  session is usually in the top 5; the *ranking* is what's broken.
- **Failure mode:** the bulk of the misses return the SAME wrong session at #1
  (`c7557f9f` oracle, `591fc609` hermes — both *small* workspaces). `searchSessions`
  normalizes BM25 **batch-relative per workspace**, so a small workspace yields
  inflated scores that dominate a naive cross-workspace merge, regardless of
  semantic relevance. Scores are not comparable across workspaces.

## What P1 must fix (this baseline is the target)

1. **Global / theoretical-min-max normalized convex fusion** (P1 Stage 2) — not
   batch-relative-per-workspace — so scores compare across the whole corpus. This
   alone should recover much of the 81% R@5 into P@1.
2. **Cross-encoder rerank of the top-k** (P1 Stage 4) — the biggest precision@1
   lever; turns "right answer in top 5" into "right answer at #1".
3. **Native cross-workspace mode** (P1 1d) — one global search, embed the query
   once, instead of 11 per-workspace searches — which also fixes the 2–4.2 s
   latency (naive merge) back under the sub-2 s budget.

**Target:** lift cross-workspace P@1 from **35.1%** toward the within-workspace
**89%** (and p95 < 2 s). That is the P1 go/no-go gate.

## P1 progress — slice 1: global fusion + native cross-workspace (DONE)

`engine.recallGlobal()` unions FTS + vector candidates across all workspaces and
ranks them in ONE batch (so BM25 min-max normalization is global);
`searchSessions()` goes global when no `workspaceId` is passed. Effect vs the
naive-merge baseline:

- **Latency 4224 → 24 ms p95** (~200×): one query embed + one global search instead
  of 11 per-workspace searches. Comfortably under the 2 s budget.
- **R@5 81% → 92%, R@3 76% → 81%** (better candidate pool).
- **MRR 0.54 → 0.61**; **P@1 35.1% → 37.8%** (modest — see below).

**Why P@1 only nudged:** global normalization fixed *small-workspace* domination,
but the session-level `aggregateScore` (topScore + log(matchCount)·bonus) now favors
*big/verbose* sessions — the misses are almost all **rank 2–3** (right session in the
top few, not #1). That is exactly what **slice 2 (cross-encoder rerank of the top-k
session cards)** targets: R@3 is 81%, so reranking the top 3–5 should convert most
rank-2/3 into rank-1 and push P@1 toward the 89% ceiling.

> Corpus note: 16 sessions is a modest snapshot; re-run as usage grows. The
> `memory.db` itself is **not** committed (it holds real session content) — only
> the derived fuzzy-reference fixture is.
