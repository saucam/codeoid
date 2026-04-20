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
import type { Episode, RecallHit, RecallQuery } from "./types.js";

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

  constructor(opts: MemoryEngineOptions) {
    this.#store = opts.store;
    this.#embedder = opts.embedder;
    this.#weights = opts.weights ?? DEFAULT_WEIGHTS;
    this.#ftsK = opts.ftsCandidateK ?? 24;
    this.#vectorK = opts.vectorCandidateK ?? 24;
  }

  async init(): Promise<void> {
    await this.#embedder.init();
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

    // Embed the query (blocking — the user's waiting).
    const queryVector = q.query.trim()
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

  async close(): Promise<void> {
    await this.#embedder.close();
    this.#store.close();
  }

  // ── Background embedding worker ───────────────────────────────────────

  async #pumpEmbedQueue(): Promise<void> {
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
