/**
 * MemoryEngine — facade over store + embedder + ranker.
 *
 * Provides the two operations callers actually care about:
 *   - ingest(episode) — embed and persist
 *   - recall(query) — hybrid semantic+keyword retrieval
 *
 * Ingestion is fire-and-forget: the caller awaits the enqueue but embedding
 * happens on a background worker queue. Recall waits for the queue to drain
 * only if the ranker indicates low vector coverage (most recent episodes
 * missing embeddings); otherwise it serves immediately.
 */

import type { Embedder } from "./embedder.js";
import { normalize } from "./embedder.js";
import type { SqliteEpisodeStore } from "./store.js";
import { DEFAULT_WEIGHTS, rank, type RankerWeights } from "./ranker.js";
import type {
  Episode,
  EpisodeKind,
  RecallHit,
  RecallQuery,
} from "./types.js";

/**
 * One session in the results list returned by searchSessions() — contains
 * the session metadata, the aggregate rank score, and up to N "evidence
 * snippets" (the top matching episodes within the session) so frontends
 * can render previews without another round-trip.
 */
export interface SessionSearchHit {
  sessionId: string;
  matchCount: number;
  firstMatchAt: number;
  lastMatchAt: number;
  aggregateScore: number;
  topScore: number;
  snippets: Array<{
    episodeId: string;
    kind: EpisodeKind;
    toolName?: string;
    summary: string;
    excerpt: string;
    createdAt: number;
    score: number;
    filePaths: string[];
  }>;
}

export interface MemoryEngineOptions {
  store: SqliteEpisodeStore;
  embedder: Embedder;
  weights?: RankerWeights;
  /** Top-K FTS hits to consider during recall. Default 24. */
  ftsCandidateK?: number;
  /** Top-K vector neighbors to consider during recall. Default 24. */
  vectorCandidateK?: number;
}

export class MemoryEngine {
  #store: SqliteEpisodeStore;
  #embedder: Embedder;
  #weights: RankerWeights;
  #ftsK: number;
  #vectorK: number;

  /** FIFO queue of episode IDs awaiting embedding. */
  #embedQueue: string[] = [];
  #embedRunning = false;
  /** False until the embedder model loads. When the model fails to init
   * (offline, download hiccup) the engine stays alive in FTS-only mode —
   * keyword recall, episode persistence and usage tracking all keep working;
   * only the vector signal is disabled. */
  #embedderReady = false;

  constructor(opts: MemoryEngineOptions) {
    this.#store = opts.store;
    this.#embedder = opts.embedder;
    this.#weights = opts.weights ?? DEFAULT_WEIGHTS;
    this.#ftsK = opts.ftsCandidateK ?? 24;
    this.#vectorK = opts.vectorCandidateK ?? 24;
  }

  async init(): Promise<void> {
    // Degrade, don't die: an embedder init failure must NOT take down the
    // whole engine (which would also disable FTS recall + usage persistence).
    // Run FTS-only and let recall's vector branch no-op on a null queryVector.
    try {
      await this.#embedder.init();
      this.#embedderReady = true;
    } catch (err) {
      this.#embedderReady = false;
      console.error(
        `[codeoid/memory] embedder init failed — running in FTS-only mode (no semantic recall): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Expose the underlying store so callers that need raw aggregate queries
   *  (index builder, admin UIs) don't have to wire a second handle. */
  get store(): SqliteEpisodeStore {
    return this.#store;
  }

  /** Persist an episode and schedule it for embedding. */
  ingest(episode: Omit<Episode, "id">): Episode {
    const saved = this.#store.insert(episode);
    this.#embedQueue.push(saved.id);
    // Kick the worker non-blockingly.
    void this.#pumpEmbedQueue();
    return saved;
  }

  /** Flush pending embeddings. Call before a recall query if you need freshness. */
  async drain(): Promise<void> {
    if (!this.#embedRunning && this.#embedQueue.length > 0) {
      void this.#pumpEmbedQueue();
    }
    // Poll until idle. Small loop — embed batches complete quickly.
    while (this.#embedRunning || this.#embedQueue.length > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Hybrid retrieval. */
  async recall(q: RecallQuery): Promise<RecallHit[]> {
    const limit = q.limit ?? 8;
    const now = Date.now();

    // Embed the query (blocking — the user's waiting). Skipped in FTS-only
    // mode; the vector branch below then no-ops and recall falls back to
    // keyword + recency + path signals.
    const queryVector =
      this.#embedderReady && q.query.trim()
        ? normalize((await this.#embedder.embed([q.query]))[0]!)
        : null;

    // FTS candidates.
    const ftsRows = this.#store.ftsSearch(q.workspaceId, q.query, this.#ftsK);
    const ftsHits = new Map<string, number>(ftsRows.map((r) => [r.id, r.bm25]));

    // Vector candidates: brute-force cosine over all embedded episodes in workspace.
    const vectorIds: string[] = [];
    if (queryVector) {
      const { ids, vectors } = this.#store.loadVectorMatrix(q.workspaceId);
      const scored: Array<{ id: string; score: number }> = [];
      for (let i = 0; i < vectors.length; i++) {
        let sum = 0;
        const v = vectors[i]!;
        if (v.length !== queryVector.length) continue;
        for (let j = 0; j < v.length; j++) sum += v[j]! * queryVector[j]!;
        scored.push({ id: ids[i]!, score: sum });
      }
      scored.sort((a, b) => b.score - a.score);
      for (const s of scored.slice(0, this.#vectorK)) vectorIds.push(s.id);
    }

    // Union candidates.
    const candidateIds = [...new Set([...ftsHits.keys(), ...vectorIds])];
    if (candidateIds.length === 0) return [];

    const episodes = this.#store.filter(candidateIds, q);
    const hits = rank(episodes, {
      queryVector,
      ftsHits,
      queryFilePaths: q.filePaths ?? [],
      now,
      weights: this.#weights,
    });

    return hits.slice(0, limit);
  }

  /** Fetch a single episode by id (for recall_turn-style lookup). */
  getEpisode(id: string): Episode | null {
    return this.#store.getEpisode(id);
  }

  /** List recent episodes (for the warm-tier index / timeline UI). */
  timeline(workspaceId: string, limit = 40): Episode[] {
    return this.#store.listRecent(workspaceId, limit);
  }

  /**
   * Cross-session search — the human-facing counterpart to Claude's
   * `recall()` tool. Reuses the hybrid ranker, then re-aggregates episode
   * hits by session so the caller gets back a ranked list of SESSIONS
   * with evidence snippets, not a flat list of episodes.
   *
   * Rank per session = topEpisodeScore + log(matchCount + 1) × multi_bonus
   * The log bonus rewards sessions that match broadly (many episodes) over
   * sessions that happen to contain a single high-score hit.
   */
  async searchSessions(opts: {
    query: string;
    workspaceId: string;
    limit?: number;
    /** Episode-hit candidates to consider before grouping. */
    candidatePoolSize?: number;
    /** Max evidence snippets returned per session. */
    snippetsPerSession?: number;
    /**
     * Optional session metadata lookup — `sessionId → sessionName`. When
     * provided, sessions whose NAME contains the query terms get a rank
     * boost. Purely additive; absence just means no name boost.
     */
    sessionNames?: Map<string, string>;
  }): Promise<SessionSearchHit[]> {
    const limit = opts.limit ?? 10;
    const pool = opts.candidatePoolSize ?? Math.max(40, limit * 5);
    const snippetsPerSession = opts.snippetsPerSession ?? 3;

    const hits = await this.recall({
      query: opts.query,
      workspaceId: opts.workspaceId,
      limit: pool,
    });
    if (hits.length === 0) return [];

    // Group by session id.
    const bySession = new Map<string, { episodes: typeof hits; topScore: number }>();
    for (const h of hits) {
      const sid = h.episode.sessionId;
      const bucket = bySession.get(sid) ?? { episodes: [], topScore: 0 };
      bucket.episodes.push(h);
      if (h.score > bucket.topScore) bucket.topScore = h.score;
      bySession.set(sid, bucket);
    }

    const now = Date.now();
    const MULTI_BONUS = 0.15;
    const NAME_MATCH_BONUS = 0.3;

    // Normalize query terms for session-name matching (case-insensitive,
    // strip punctuation, require 2+ char length so single chars don't
    // match random session names).
    const nameTerms = opts.query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9_.-]/g, ""))
      .filter((t) => t.length >= 2);

    // Score per session + trim snippets.
    const scored: SessionSearchHit[] = [];
    for (const [sessionId, { episodes, topScore }] of bySession) {
      episodes.sort((a, b) => b.score - a.score);
      const matchCount = episodes.length;
      const lastMatchAt = Math.max(...episodes.map((e) => e.episode.createdAt));
      const firstMatchAt = Math.min(...episodes.map((e) => e.episode.createdAt));

      // Mild recency boost — most-recent session moves up by a few % when
      // scores are close. Keeps long-tail sessions reachable but prefers
      // active ones on ambiguous queries.
      const ageHours = Math.max(0, (now - lastMatchAt) / 3_600_000);
      const recencyBoost = 1 / (1 + ageHours / 48); // 0.5 at 48h, ~0.02 at a week

      // Session-name boost — user named the session deliberately, so a
      // name hit is strong signal. Additive on top of content scoring.
      let nameBoost = 0;
      const name = opts.sessionNames?.get(sessionId)?.toLowerCase();
      if (name && nameTerms.length > 0) {
        const hit = nameTerms.some((t) => name.includes(t));
        if (hit) nameBoost = NAME_MATCH_BONUS;
      }

      const aggregateScore =
        topScore +
        Math.log(matchCount + 1) * MULTI_BONUS +
        recencyBoost * 0.1 +
        nameBoost;

      scored.push({
        sessionId,
        matchCount,
        firstMatchAt,
        lastMatchAt,
        aggregateScore,
        topScore,
        snippets: episodes.slice(0, snippetsPerSession).map((h) => ({
          episodeId: h.episode.id,
          kind: h.episode.kind,
          toolName: h.episode.toolName,
          summary: h.episode.summary,
          excerpt: excerpt(h.episode.content, opts.query, 240),
          createdAt: h.episode.createdAt,
          score: h.score,
          filePaths: h.episode.filePaths,
        })),
      });
    }

    scored.sort((a, b) => b.aggregateScore - a.aggregateScore);
    return scored.slice(0, limit);
  }

  async close(): Promise<void> {
    await this.#embedder.close();
    this.#store.close();
  }

  // ── Background embedding worker ───────────────────────────────────────

  async #pumpEmbedQueue(): Promise<void> {
    // In FTS-only mode there's no embedder — leave episodes unembedded
    // (still persisted + FTS-indexed) rather than throwing per batch.
    if (!this.#embedderReady) return;
    if (this.#embedRunning) return;
    this.#embedRunning = true;
    try {
      while (this.#embedQueue.length > 0) {
        // Drain up to 8 at a time to amortize model-call overhead.
        const batchIds = this.#embedQueue.splice(0, 8);
        const episodes = batchIds
          .map((id) => this.#store.getEpisode(id))
          .filter((e): e is Episode => e !== null && !e.embedding);
        if (episodes.length === 0) continue;

        const texts = episodes.map((e) => embedText(e));
        try {
          const vectors = await this.#embedder.embed(texts);
          for (let i = 0; i < episodes.length; i++) {
            const v = vectors[i];
            if (v) {
              normalize(v);
              this.#store.setEmbedding(episodes[i]!.id, v, this.#embedder.modelName);
            }
          }
        } catch (err) {
          // Put them back at the front; caller can retry later.
          console.error(
            `[codeoid/memory] embedding batch failed, requeued: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.#embedQueue.unshift(...batchIds);
          break;
        }
      }
    } finally {
      this.#embedRunning = false;
    }
  }
}

/** Build the input string the embedder sees — summary gets weight by being first. */
function embedText(ep: Episode): string {
  // Cap at ~6000 chars to stay inside model context (BGE is 512 tokens).
  const body = ep.content.length > 6000 ? ep.content.slice(0, 6000) : ep.content;
  return `${ep.summary}\n\n${body}`;
}

/**
 * Extract a readable excerpt from an episode's content, centered on the
 * first case-insensitive occurrence of any query term. Falls back to a
 * leading head excerpt when the query has nothing literal to anchor on
 * (semantic-only match).
 */
function excerpt(content: string, query: string, maxLen: number): string {
  if (!content) return "";
  if (content.length <= maxLen) return content;

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9_./-]/g, ""))
    .filter((t) => t.length >= 3);

  const lower = content.toLowerCase();
  let best = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }

  if (best === -1) {
    // No literal match — head excerpt.
    return content.slice(0, maxLen - 1).trimEnd() + "…";
  }

  const halfWindow = Math.floor(maxLen / 2);
  const start = Math.max(0, best - halfWindow);
  const end = Math.min(content.length, start + maxLen);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return prefix + content.slice(start, end).trim() + suffix;
}
