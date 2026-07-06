# P0 Baseline — session resolution

Measured against the **real corpus** (16 sessions / 11 workspaces / 11,938
episodes, pulled from the Hetzner daemon's `memory.db`) with 37 hand-labeled fuzzy
references (`fixtures/session-resolution.json`), using the resolver
(`MemoryEngine.searchSessions`, `Xenova/bge-small-en-v1.5` embedder +
`Xenova/ms-marco-MiniLM-L-6-v2` reranker), on the current-main base. Reproduce:

```sh
MEMORY_DB=/path/to/memory.db bun run src/daemon/eval/baseline.ts
```

> The references are deliberately **pure-conceptual** (no exact identifiers — no PR
> numbers, branch names, or error strings). That is the *conservative* case:
> exact identifiers are strong lexical signal, so identifier-bearing references
> resolve meaningfully higher. This fixture measures the hard, fuzzy-only floor.

## Results

| Regime | P@1 | MRR | R@3 | R@5 | p50/p95 |
|---|---|---|---|---|---|
| **Within-workspace** (you already know the repo) | 97.3% | 0.986 | 100% | 100% | 406 / 1248 ms |
| **Cross-workspace** — naive per-ws merge (BASELINE) | **21.6%** | 0.440 | 62.2% | 73.0% | 2440 / 4966 ms |
| **Cross-workspace** — GLOBAL fusion (P1 slice 1) | **35.1%** | 0.578 | 78.4% | 86.5% | 10 / 28 ms |
| **Cross-workspace** — GLOBAL + rerank (P1 slice 2) | **73.0%** | 0.820 | 89.2% | 91.9% | ~43 / 88 ms |

## The finding — a fusion/ranking problem, not a recall problem

- **Within a workspace the resolver is already strong** (97% P@1): the hybrid recall
  primitives are sound.
- **Cross-workspace the naive merge collapses to 21.6% P@1.** Failure mode: the bulk
  of the misses return the same wrong session at #1 (two *small* workspaces, by
  opaque id). `searchSessions` normalizes BM25 **batch-relative per workspace**, so a
  small workspace yields inflated scores that dominate a naive cross-workspace merge,
  regardless of semantic relevance. Scores are not comparable across workspaces.
- **R@5 stays ~86–92% throughout** — so the right session is almost always in the top
  few; the *ranking* is what's broken, not recall.

## P1 slice 1 — global fusion + native cross-workspace (DONE)

`engine.recallGlobal()` unions FTS + vector candidates across all workspaces and
ranks them in ONE batch (BM25 normalization is global); `searchSessions()` goes
global when no `workspaceId` is passed. Effect vs naive merge:

- **Latency 4966 → 28 ms p95** (~200×): one query embed + one global search instead
  of 11 per-workspace searches. Comfortably under the 2 s budget.
- **R@5 73% → 86.5%**, R@3 62% → 78% (better, globally-comparable candidate pool).
- **MRR 0.44 → 0.58**; **P@1 21.6% → 35.1%** (modest — big verbose sessions now fill
  the #1 slot; the misses are mostly rank 2–3).

## P1 slice 2 — cross-encoder rerank (DONE) — gate cleared

A `Reranker` interface + a transformers.js cross-encoder (`ms-marco-MiniLM-L-6-v2`,
swappable for bge-reranker-v2-m3). The engine reranks the top-8 candidate sessions
by (query, evidence) when a reranker is present; `searchSessions({ rerank })` gates
it. Effect:

- **P@1 35.1% → 73.0%**, MRR 0.58 → 0.82, R@3 78% → 89%. Latency +~30 ms (88 ms p95).
- Converts the ~92% R@5 into precision@1 by reading (query, session) jointly — the
  near-ties the first stage can't resolve.

**P1 go/no-go gate: CLEARED** — cross-workspace P@1 **21.6% → 73.0%** on pure-fuzzy
references (identifier-bearing references land higher still), p95 < 100 ms vs the 2 s
budget. Remaining P1 slices (BGE-M3 embedder, identifier-aware lexical, session
cards) are optional polish now — revisit if the number regresses as the corpus grows.

> Corpus note: 16 sessions is a modest snapshot; re-run as usage grows. `memory.db`
> is **not** committed (real session content); only the derived (genericized)
> fuzzy-reference fixture is.
