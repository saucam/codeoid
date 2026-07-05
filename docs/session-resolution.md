# Session Resolution — how codeoid finds the right session

> How the shipped capability works. For the research/design rationale behind it
> see [conductor-session-resolution.md](./conductor-session-resolution.md); for the
> eval methodology + numbers see
> [../src/daemon/eval/BASELINE.md](../src/daemon/eval/BASELINE.md).

You say — in natural language — *"continue the auth token-refresh fix"* or *"the
session where I was comparing the two caching strategies"*, and codeoid resolves it
to the **right session among all your workspaces**, in under 100 ms. This is the
linchpin of the conductor (talk to one agent, it runs your fleet): you don't
remember which repo or which of a dozen sessions it was — you describe it, and it's
found.

## The problem

codeoid already indexes every session's episodes with hybrid retrieval — dense
embeddings (semantic) + FTS5 BM25 (keyword/identifier) + recency + path overlap —
but **scoped to one workspace** (`recall(workspaceId, …)`). That's right for
in-session memory ("what did I try earlier *here*"), but the conductor needs the
opposite: find a session *without* knowing its workspace.

The naive fix — run the per-workspace search everywhere and merge the results —
scores only **35% precision@1**. The reason is subtle and instructive: BM25 scores
are normalized **batch-relative, per workspace**. A workspace with few episodes
produces inflated normalized scores, so it dominates the merged ranking regardless
of semantic relevance. **Scores from different workspaces aren't comparable.**

## The pipeline (as built)

Resolution runs as **two stages** — the classic bi-encoder-recall → cross-encoder-
rerank shape:

**Stage 1 — global fusion (`engine.recallGlobal`).** Embed the query once, then
gather candidates across *all* workspaces:
- **Dense**: cosine of the query vector against every workspace's embedding matrix.
- **Lexical**: FTS5 BM25 across all workspaces (`store.ftsSearchGlobal`).

Union them into **one candidate set** and rank that single batch with the hybrid
ranker (vector + BM25 + recency + path). Because it's one batch, **BM25
normalization is global** — scores are finally comparable across workspaces.
Episodes are grouped into sessions and scored (`searchSessions` with no
`workspaceId`).

**Stage 2 — cross-encoder rerank.** Take the top ~8 candidate sessions and rerank
them with a cross-encoder that reads the `(query, session-evidence)` pair *jointly*
and scores relevance for *this* query (`Reranker` → `searchSessions({ rerank })`).

## Why two stages

Stage 1 alone gets the right session into the **top-5 ~92% of the time** — but only
to **~38% precision@1**. A bi-encoder compresses each session into one
query-agnostic vector, and broad-match session scoring lets big, verbose sessions
fill the #1 slot. So the right answer is *there*, just not first.

That's the tell that **this is a ranking problem, not a recall problem** — and the
cross-encoder is the fix. Reading query and evidence together, it discriminates the
near-ties the first stage can't, pulling the right session to #1. It runs on only
~8 candidates, so it's cheap.

## Results (measured on a real corpus)

16 sessions / 11 workspaces / ~12k episodes, 37 hand-labeled fuzzy references, via
the re-runnable harness in `src/daemon/eval/`:

| Cross-workspace resolution | P@1 | R@5 | p95 latency |
|---|---|---|---|
| Naive per-workspace merge | 35.1% | 81% | 4939 ms |
| + global fusion (stage 1) | 37.8% | 92% | 47 ms |
| **+ cross-encoder rerank (stage 2)** | **86.5%** | **97%** | **88 ms** |

86.5% precision@1 is essentially the same-workspace ceiling (97.3% when you already
know the repo). Global fusion also made it **~200× faster** (one search + one query
embed, vs eleven per-workspace searches). Everything runs **locally** — no cloud,
no API.

## Models (both local, both swappable)

- **Embedder**: `Xenova/bge-small-en-v1.5` (384-d, ~50 MB WASM). Behind an `Embedder`
  interface; BGE-M3 (dense + sparse in one pass) is the planned upgrade.
- **Reranker**: `Xenova/ms-marco-MiniLM-L-6-v2` cross-encoder (~22 MB WASM, English,
  fast). Behind a `Reranker` interface; `bge-reranker-v2-m3` (multilingual) drops in
  as a config swap.

Both run via `@xenova/transformers` (pure WASM) — no native deps, no network at
query time after the one-time model download.

## Code map

| Piece | Where |
|---|---|
| Global recall + rerank orchestration | `src/daemon/memory/engine.ts` — `recallGlobal`, `searchSessions` |
| Cross-workspace store primitives | `src/daemon/memory/store.ts` — `ftsSearchGlobal`, `listWorkspaceIds`, `episodesByIds` |
| Hybrid ranker (vector+BM25+recency+path) | `src/daemon/memory/ranker.ts` |
| Reranker interface + cross-encoder | `src/daemon/memory/reranker.ts`, `reranker-transformersjs.ts` |
| Eval harness (precision@1 / MRR / recall@k) | `src/daemon/eval/{metrics,baseline}.ts`, `fixtures/` |

## Reproduce / measure

```sh
MEMORY_DB=~/.codeoid/memory.db bun run src/daemon/eval/baseline.ts
```

Prints within-workspace, naive-merge, global-fusion, and global+rerank regimes side
by side against the labeled fixture.

## Design principles

- **Evaluation-driven.** Every change is measured against a labeled fixture; the
  precision@1 number is the gate. (The rerank was chosen *because* the eval showed
  R@5 was already high — recall wasn't the problem.)
- **Degrade, don't die.** No embedder → FTS-only recall. No reranker → fusion-only
  ranking. The daemon keeps working; only quality drops.
- **Local-first.** All models run on-device; nothing about your sessions leaves the
  machine to resolve a reference.

## Limitations & what's next

- The measured corpus is small (16 sessions) — re-run the harness as usage grows.
- MiniLM is English-only; swap to `bge-reranker-v2-m3` + BGE-M3 for multilingual.
- Cross-workspace search is single-tenant today (all *your* workspaces); the
  conductor's identity will scope it per tenant.
- Next retrieval upgrade: per-session **cards** (compact self-maintained digests) +
  bi-temporal state, so ranking and rerank operate on clean session summaries rather
  than raw episode text.
