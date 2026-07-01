# Session Resolution — SOTA Architecture

> Companion to [conductor-design.md](./conductor-design.md) §6. This is the deep
> design for the conductor's linchpin capability: resolve a fuzzy natural-language
> reference — "the session where I was fixing the authz `latest_only` bug",
> "studio#870", "the durga extraction eval" — to the RIGHT AI-coding session among
> hundreds, across every workspace on the machine.
>
> Backed by a 9-agent research fan-out (retrieval methods; local models —
> embedders / rerankers / LFM2 / MTEB+CPU-latency; OSS prior art — mem0,
> Letta/MemGPT, Zep/Graphiti, Cognee, LlamaIndex, Haystack, txtai, OpenClaw/
> SwarmClaw, Claude ecosystem). Model picks are **final** (CPU latencies are
> calibrated estimates — verify on the box). Sources at the bottom.

---

## 0. Baseline — what codeoid already has

Reading the source ([engine.ts](../src/daemon/memory/engine.ts),
[store.ts](../src/daemon/memory/store.ts),
[embedder.ts](../src/daemon/memory/embedder.ts)): codeoid already ships a credible
session resolver — `engine.ts:searchSessions()` runs hybrid recall, groups episode
hits by session, and scores `topEpisodeScore + log(matchCount)·bonus + recency +
nameMatch`. **This is an upgrade of an existing primitive, not greenfield** — and
notably codeoid's memory store is already ~80% of the convergent SOTA stack below
(SQLite + FTS5 + same-row embeddings + weighted hybrid). The gaps are specific:

| Layer | As-built | SOTA gap |
| --- | --- | --- |
| Embedder | `Xenova/bge-small-en-v1.5` (384-d, English-only, 512-tok, WASM) | no sparse leg → misses identifiers; weak + monolingual |
| Vector | brute-force cosine, in-memory, **per-workspace** | fine at scale; needs cross-workspace + eventually ANN |
| Sparse | FTS5 + `bm25()`, **default tokenizer** | splits `studio#870` → `studio`+`870`; no id handling |
| Fusion | ad-hoc weighted linear | normalize + tune (convex); RRF as cold-start |
| Rerank | **none** | the single biggest precision@1 lever, missing |
| Cards | `sessionSummaries()` = first user_turn line | no rich, self-maintained, embedded digest |
| Scope | `workspaceId`-bound everywhere | cross-workspace is the §6 gap |

---

## 1. The retrieval pipeline (fuzzy reference → the one right session)

Six stages. Precision@1 ("pick the ONE right session") is the metric — a wrong
route runs a command in the wrong repo. **Hybrid is mandatory, not optional**: on
exact-identifier queries BM25 gets ~70% recall vs dense ~5%; on paraphrases the
reverse. The discriminating signal here is *exact tokens* (paths, branch/repo/fn
names), so the lexical leg is load-bearing.

**Stage 0 — Query typing (regex, no LLM).** Classify `has_identifier` (matches
`\w+#\d+`, `path/like/this`, dotted/snake symbols, branch patterns) vs
`pure_semantic`. Sets the fusion weight. ~10 lines, zero latency.

**Stage 1 — Candidate generation (two channels, always both).**
- *Dense*: embed query → top 50–100 over session cards + episodes.
- *Lexical*: FTS5/BM25 with **field boosting** (ticket/branch/path fields ≫ body)
  and a **code/trigram analyzer** so `studio#870`, `feat/agent-action-timeline`,
  `torch.nn.x` tokenize as whole matchable units. (Today `store.ftsSearch` uses
  the default tokenizer — this is the fix.)

**Stage 2 — Fusion.** **RRF (k=60) as the day-1 cold-start default** (rank-only,
no score calibration needed); **move to a convex combination of theoretical-min-max
normalized scores once ~40 labeled query→session pairs exist** (an afternoon's
work). Tuned convex then beats RRF *and* preserves score margins (how much #1 beats
#2), which RRF discards. Set **α by query type** from Stage 0 (static 2-value table:
≈0.3 favor-lexical for identifier queries, ≈0.7 favor-dense for semantic). *This is
exactly what the two closest prior-art twins already do* — SwarmClaw ships
`relevance = sem·0.50 + lex·0.35 + fts·0.15`, txtai a `[w, 1-w]` convex fusion — so
convex-once-tuned is the field-validated choice.

**Stage 3 — Exact-identifier override (deterministic, pre-rerank).** If Stage 0
found an identifier AND a candidate matches it literally, pin it to the top. Exact
ids are a **correctness guarantee, not a soft weight**. Cheaply reinforced by an
**entity boost** (mem0's pattern): extract repo/branch/file/symbol tokens
deterministically and additively boost sessions that share them.

**Stage 4 — Cross-encoder rerank of top-k (~20–50) session cards.** The single
biggest precision@1 lever (documented +5–15 NDCG@10, precision@1 → ~1.0), and
codeoid has none. Rerank the **cards**, not raw episodes. **bge-reranker-v2-m3**
(ONNX-int8) does ~50 short pairs in ~0.5–1s on a 12-core CPU — inside the sub-2s
budget. Keep the candidate set ≤50.

**Stage 5 — Additive priors as tie-breakers (never co-equal rankers).** Recency
(forgetting-curve / ~30-day half-life decay, from SwarmClaw), log usage-frequency /
reinforcement (bump on access), currently-active-session boost, pinned boost.
Applied *after* semantic scoring; optionally an MMR diversity pass (λ≈0.7) if
returning a list.

> `searchSessions()` already implements Stages 1–2 + crude priors at episode
> granularity. The SOTA delta = **card** granularity + identifier handling
> (0 / boosted-lexical / 3 + entity boost) + a real **rerank** (4) + **cross-workspace**.

---

## 2. The session-card data model (convergent: mem0 + Letta + Zep + Cognee)

Multiple independent memory frameworks point at the same design. **Steal the data
model + self-editing loop; do NOT adopt any runtime** (all assume they own the loop
+ a heavy store, competing with codeoid's daemon).

**(a) Card = an addressable, self-maintained digest** *(Letta memory-block;
SwarmClaw `session_archive` row)*. One per session:
`{ session_id/slug, repo, branch, task-in-NL, current-state, last-action,
open-threads, entities }` with a hard size *limit* forcing digest-not-transcript.
Both the conductor and the session agent attach to it; edits are live — codeoid's
"daemon owns state, clients render." Embed only the *fuzzy* fields (task, goal,
branch — Cognee's `index_fields` idea); keep ids/paths/timestamps as filterable
columns, out of the embedded text.

**(b) State as bi-temporal facts, never mutable fields** *(Zep/Graphiti)*. Record
state changes ("WIP" → "merged") as facts with four timestamps
(`valid_at, invalid_at, created_at, expired_at`). On a change: set the old fact's
`invalid_at = new.valid_at`, stamp `expired_at`, insert the new — **never
UPDATE-in-place, never DELETE**. Free time-travel ("what was this session's status
last Tuesday?") + lossless audit + correct "was WIP, now merged" so "continue the X
fix" resolves to the *right iteration*. Plain SQLite: `facts(subject, predicate,
object, valid_at, invalid_at, created_at, expired_at, embedding)`. The four-timestamp
discipline is the pattern — **not Neo4j** (mem0 *removed* its graph after their own
benchmark showed it slower/costlier with no accuracy win; Graphiti's embedded
backend is vaporware).

**(c) Keep cards canonical via write-time reconciliation** *(mem0 paper)*. On an
update, fetch top-s similar existing cards → LLM decides **ADD/UPDATE/invalidate** →
one evolving record per thread, not 40 near-dups. That same "here are the 10 closest
threads — which one?" prompt shape *is* reference resolution, reusable at query time.
**Avoid mem0 v3's ADD-only default** — a trap for long-lived mutating threads.

**(d) Deterministic entity resolution before any LLM** *(Zep MinHash/LSH; mem0
spaCy)*. Merge/boost on repo/branch/file/symbol tokens with a deterministic fast
path; reserve the LLM for genuine ambiguity. Cheap and fast on a laptop.

**(e) Extract at checkpoints, not per turn** *(Zep cost lesson)*. LLM-per-turn
extraction (4+ calls/episode) would dominate a many-session daemon. Regenerate a
card on session start / status-change / merge via `IndexScheduler`; use cheap rules
for structured signals.

---

## 3. Model choices (FINAL)

| Role | Model | Size | CPU latency (12-core, ONNX-int8/GGUF-Q4) | Why |
| --- | --- | --- | --- | --- |
| **Embedder** | **BGE-M3** | 568M | query embed ~tens of ms; corpus embedded once, offline | **Only model emitting dense + learned-sparse + ColBERT in one pass** → semantics *and* the identifier-matching sparse leg from one model, no second index. MIT, 8192 ctx. Team already runs it. |
| Embedder (dense-only alt) | Qwen3-Embedding-0.6B | 0.6B | similar | Tops MTEB-multilingual small tier (64.33 vs BGE-M3 59.56) — but **dense-only**, so you'd bolt on BM25 for identifiers. Switch only if a dense eval on *your* data shows a real win. |
| **Reranker** | **bge-reranker-v2-m3** (ONNX-int8) | 568M | ~50 short pairs ≈ **0.5–1.0s** (~8 ms/pair) | Encoder cross-encoder → far cheaper on CPU than decoder rerankers; same family/tokenizer as BGE-M3; Apache-2.0; mature CPU tooling (FastEmbed). |
| Reranker (tiny fast fallback) | Ettin-150M (MIT) or ms-marco-MiniLM-L6-v2 (22M) | 150M / 22M | ~0.3–0.5s / ~0.15–0.4s for 50 pairs | Ettin-150M ≈ mxbai-large accuracy at a fraction of the cost; MiniLM is the English-only floor. |
| **Card extractor (small LM)** | **LFM2-350M-Extract** (or LFM2.5-350M) | 350M | ~313 tok/s decode — **offline at ingest, off the hot path** | Purpose-built transcript→JSON extractor (Liquid ships it; beats Gemma-3-4B 11× at extraction, first-party). Pair with **GBNF/JSON grammar** for guaranteed-valid output; field semantics in the prompt (your durga finding). |

**Upgrade the embedder** from `bge-small-en-v1.5` (33M, English-only, dense-only,
512-tok): you specifically need the **sparse/lexical leg for identifiers** (the
single biggest quality lever), longer context, and better semantics. The 568M vs
33M size gap is irrelevant — thousands of docs embedded once offline; only the
query embeds at request time (tens of ms).

**The LFM2-230M question, answered:** it belongs in exactly **one** slot — **offline
structured card extraction/summarization** — where its speed is free and grammar
constraints backstop its limits. Per subtask: (a) query rewrite — viable ~230–350M
but *skip by default*, rewriting terse references adds little; (b) HyDE — **skip**
(hallucinates identifiers on exact-match corpora, adds latency); (c) **listwise
reranking — NOT viable at 230–350M**, the whole literature is 7B+ and even 7B emits
malformed rankings — **use the cross-encoder**; (d) card extraction — **its genuine
strength**. Net: prefer **LFM2.5-350M / LFM2-350M-Extract** over 230M (negligibly
slower on 12 cores, meaningfully better instruction-following). Don't let Liquid's
"on-device RAG" framing tempt you into using it as a reranker — that's the trap.

---

## 4. Deliberately skipped (keep it lean)

Overkill at single-user, hundreds-to-thousands-of-docs, one-machine scale:
**SPLADE/learned-sparse** (BGE-M3's sparse output already covers it),
**ColBERT/PLAID late-interaction** (built for millions of passages; a top-k
cross-encoder wins here), **HyDE** (hurts on identifier corpora; keep only as a
narrow low-confidence fallback), **multi-query/RAG-fusion/decomposition** (session
refs are single-intent), **LLM-per-query fusion & listwise LLM reranking**
(latency-fatal: 50-doc GPT-4 rerank ≈ 1 min/H100), and **any external memory
runtime or graph DB** (steal the patterns onto codeoid's SQLite + memory engine).

---

## 5. Convergent synthesis — the 6 patterns + 3 pitfalls

Endorsed independently across the frameworks:

1. **SQLite as the single spine** — content + metadata + FTS5(BM25) + vectors
   (sqlite-vec). txtai, SwarmClaw, and every Claude-session tool converge here.
   Codeoid already has this (minus sqlite-vec — it uses in-memory brute-force).
2. **Hybrid retrieval + fusion + light rerank** — BM25 for exact tokens, dense for
   paraphrase; RRF cold-start → tuned convex; cross-encoder only on top-k.
3. **Index a compacted "gist" + metadata, not raw transcripts** — repo/cwd, branch,
   first+last prompt, one-line gist, entities, status, timestamps.
4. **Deterministic entity extraction + entity boost, LLM only as fallback** — mem0
   spaCy entities, Zep MinHash/LSH. Cheap, fast, high-signal.
5. **Temporal thread state first-class, invalidate-don't-delete** — Zep's bi-temporal
   edges; resolve to the *right iteration* + answer "what was I doing last week."
6. **Incremental byte-offset watcher over the source files** — tail growing logs from
   last-read offset; re-index only new bytes (the `claude-code-sessions` pattern).

**Pitfalls to avoid:** (1) **graph DB as the default store** — mem0 removed it after
its own benchmark; borrow the temporal-edge *pattern*, not Neo4j/Kùzu. (2)
**Agent-self-managed / LLM-in-the-loop memory as the primary resolver** (Letta-style)
— non-deterministic and latency-variable; resolution must be a deterministic ranked
index, LLM only disambiguates the top few. (3) **Files-as-memory-only** (base
OpenClaw, Cline Memory Bank, Cursor rules) — no ranking, doesn't scale to many
sessions; fine as a human-readable per-session status doc, not the retrieval layer.

---

## 6. Prior-art verdicts

| System | STEAL | AVOID |
| --- | --- | --- |
| **SwarmClaw** *(closest twin)* | single-table hybrid recall (FTS5 + BLOB embeddings + `sem·0.5+lex·0.35+fts·0.15`); session-archive-as-memory row; reinforcement+decay+pinned salience; per-session single-run lock + preempt/steer + restart-recoverable runs | brute-force cosine as it scales (add ANN); its resume = static `backend→id` map with **no NL→session matcher** (our hard problem is unsolved there — no shortcut) |
| **txtai** *(stack twin)* | the whole storage design: SQLite content+metadata + **BM25-in-SQLite** + ANN, `similar()`-then-SQL-filter, weighted hybrid fusion, 9.0 rerank pipeline | — (build directly on it if Python; else replicate with FTS5 + sqlite-vec) |
| **Claude ecosystem** | parse `~/.claude/projects/**.jsonl` incrementally → per-session metadata+gist → SQLite FTS5 + sqlite-vec → hybrid RRF (`claude-code-sessions` is purpose-built prior art for our exact input) | — |
| **mem0** | entity-boosted hybrid scoring (spaCy entities + damped additive boost); paper's reconciliation loop; SQLite change-log | v3 ADD-only/overwrite-on-update (loses thread history); LLM-only index |
| **Zep / Graphiti** | bi-temporal 4-timestamp invalidate-don't-delete; deterministic MinHash/LSH entity resolution before LLM; node-distance rerank | 4-LLM-calls/episode in hot path; server graph-DB dependency |
| **Letta / MemGPT** | tiered core(always-loaded digest)/archival(vector)/recall(history) split; sleep-time compaction | running Letta as engine; self-managed memory as the *resolver*; FIFO-summarization as index |
| **Cognee** | ECL framing (Extract→Cognify→Load); typed nodes + `index_fields` (embed only fuzzy fields) | full ontology + 3-DB stack; its weak temporal model |
| **LlamaIndex / Haystack** | the retrieve→fuse(RRF)→rerank + metadata-pre-filter *pattern*; filter grammar (`{field,op,value}` + AND/OR/NOT) | adopting the framework as a dependency (too heavy for one machine) |

**"claude tag" resolution:** not a memory/retrieval system. It's either Anthropic's
Slack "tag Claude into a thread" product, or a `claude plugin tag` git-tag
subcommand — plus some open feature-requests to *label* Claude Code sessions. Only
that last strand is relevant, and only as inspiration for **manual session tags as
one routing signal**.

---

## 7. Grafting onto codeoid (concrete)

1. **Cards table + facts table** in the memory SQLite (alongside `episodes`). Cards
   embedded on write (fuzzy fields only); facts bi-temporal.
2. **Embedder swap** `bge-small-en` → **BGE-M3**; persist dense **and** sparse
   vectors (BGE-M3 emits both). This alone fixes the identifier-recall gap.
3. **sqlite-vec + tokenizer fix**: move brute-force cosine to sqlite-vec as it
   grows; rebuild `episodes_fts` (+ new `cards_fts`) with a code/trigram analyzer +
   boosted identifier columns.
4. **Fusion**: RRF now; swap to TMM-normalized convex + Stage-0 α table + Stage-3
   exact-override + entity boost once ~40 labels exist (generate them from your own
   usage).
5. **Rerank stage**: add **bge-reranker-v2-m3** (ONNX-int8) over top-k cards.
6. **Card maintenance**: **LFM2-350M-Extract** (grammar-constrained) on
   `IndexScheduler` checkpoints + mem0-style reconciliation on write; salience
   decay + reinforcement on access (SwarmClaw).
7. **Cross-workspace mode**: add an `ALL` scope to `recall` / `loadVectorMatrix` /
   `ftsSearch` (today all `workspaceId`-bound).
8. **`fleet_find` MCP tool** (conductor-design §5) calls this pipeline; returns
   ranked cards with evidence snippets (`SessionSearchHit` already carries snippets).

---

## 8. Bonus — index Claude sessions started *outside* codeoid

Your original ask includes controlling *all* Claude sessions, not just codeoid's.
Claude Code persists every session as JSONL at
`~/.claude/projects/<hashed-cwd>/<session-id>.jsonl` (session id, cwd, git branch,
one line per message). So the conductor can run a **byte-offset watcher** over that
directory (the `claude-code-sessions` pattern) and index those sessions into the
same cards table — giving it visibility into raw `claude` sessions the user ran
without codeoid. Same pipeline, second source. (Codeoid's own sessions already have
richer episode data via the memory engine.)

---

## 9. Sources (top, by track)

**Retrieval methods:** Bruch et al. "Analysis of Fusion Functions for Hybrid
Retrieval" (ACM TOIS, convex>RRF once tuned); tianpan.co 2026 hybrid-search-in-prod
(BM25 wins on identifiers, α≈0.3 technical); DAT (arXiv 2503.23013, per-query α);
cross-encoder rerank lifts (bigdataboutique); Re3 (arXiv 2509.01306, recency as
prior).
**Models:** BGE-M3 (arXiv 2402.03216, dense+sparse+ColBERT one pass);
bge-reranker-v2-m3 + Ettin reranker cards (CPU pairs/sec); Qwen3-Embedding report
(arXiv 2506.05176, MTEB table); LFM2 report (arXiv 2511.23404) + LFM2.5-230M/350M +
LFM2-*-Extract cards; RankZephyr/RankLLM (listwise needs 7B+); GOLFer (arXiv
2506.04762, small-LM query expansion); Intel/HF CPU embedding latency.
**Prior art:** SwarmClaw `memory-db.ts`; txtai (neuml/txtai); Graphiti (arXiv
2501.13956) + getzep/graphiti; mem0 (arXiv 2504.19413) + v3 migration notes; Letta
(MemGPT arXiv 2310.08560); Cognee (topoteretes/cognee); LlamaIndex
`fusion_retriever.py`; Haystack `document_joiner.py`; Anthropic Claude Code memory
+ JSONL session storage; `claude-code-sessions` (FTS5 + sqlite-vec + RRF + JSONL
byte-offset watcher).
