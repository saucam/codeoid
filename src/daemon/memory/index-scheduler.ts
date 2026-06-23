/**
 * IndexScheduler — throttled builder for the workspace memory index.
 *
 * Hybrid trigger (production-grade):
 *   - HARD:   ≥ EPISODE_THRESHOLD new episodes since last build → rebuild now
 *   - TIMED:  ≥ TIME_THRESHOLD_MS elapsed AND ≥ 1 new episode  → rebuild now
 *   - FLOOR:  at most one rebuild per DEBOUNCE_MS regardless of triggers
 *
 * Why both triggers? During active work, episode counts climb fast — we want
 * reactive regen. During idle stretches, timer-based regen catches drift
 * without wasting cycles. The debounce floor caps prompt-cache invalidation
 * frequency — Anthropic's prefix cache is the single biggest cost knob on
 * long sessions, so we protect it.
 *
 * Generation runs synchronously when `get()` is called with a stale cache.
 * Turn latency impact is negligible (<10ms for the pure SQL path) so we don't
 * bother with a background thread.
 */

import type { SqliteEpisodeStore } from "./store.js";
import {
  buildWorkspaceIndex,
  type IndexOptions,
  type LabeledCluster,
} from "./index-builder.js";
import {
  clusterEpisodes,
  MIN_EPISODES_FOR_CLUSTERING,
  type Cluster,
} from "./cluster.js";
import { createLabeler, type Labeler } from "./cluster-labeler.js";

/** Rebuild once EPISODE_THRESHOLD new episodes have accumulated. */
const EPISODE_THRESHOLD = 5;
/** Rebuild after this long, even if only 1 new episode arrived. */
const TIME_THRESHOLD_MS = 60_000;
/** Minimum gap between successive rebuilds (protects prompt cache). */
const DEBOUNCE_MS = 15_000;
/** How often to re-cluster (more expensive, doesn't need to track each episode). */
const RECLUSTER_INTERVAL_MS = 5 * 60_000;
/** Pending-episode floor below which clustering skips the re-run. */
const RECLUSTER_EPISODE_THRESHOLD = 10;

export interface IndexSchedulerOptions {
  store: SqliteEpisodeStore;
  workspaceId: string;
  currentSessionId: string;
  workdir?: string;
  indexOptions?: IndexOptions;
  /** Overrides — tests can shrink thresholds. */
  episodeThreshold?: number;
  timeThresholdMs?: number;
  debounceMs?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
  /** Opt-in clustering. Defaults to the CODEOID_MEMORY_CLUSTERS env flag. */
  clustersEnabled?: boolean;
  /** Custom labeler (tests inject heuristic labelers). */
  labeler?: Labeler;
}

export class IndexScheduler {
  #opts: IndexSchedulerOptions;
  #episodeThreshold: number;
  #timeThresholdMs: number;
  #debounceMs: number;
  #now: () => number;

  #cached = "";
  #cachedAt = 0;
  #pendingEpisodes = 0;

  // ── Clustering state (opt-in) ────────────────────────────────────────
  #clustersEnabled: boolean;
  #labeler: Labeler;
  #labeledClusters: LabeledCluster[] = [];
  #lastClusteredAt = 0;
  #reclusterRunning = false;
  #episodesSinceLastCluster = 0;

  constructor(opts: IndexSchedulerOptions) {
    this.#opts = opts;
    this.#episodeThreshold = opts.episodeThreshold ?? EPISODE_THRESHOLD;
    this.#timeThresholdMs = opts.timeThresholdMs ?? TIME_THRESHOLD_MS;
    this.#debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.#now = opts.now ?? Date.now;
    this.#clustersEnabled =
      opts.clustersEnabled ?? process.env.CODEOID_MEMORY_CLUSTERS === "1";
    this.#labeler = opts.labeler ?? createLabeler();
  }

  /** Call after every episode.ingest — increments the pending counter. */
  onEpisode(): void {
    this.#pendingEpisodes += 1;
    this.#episodesSinceLastCluster += 1;
    // Kick an async re-cluster when enough new material has arrived.
    // Runs in the background — doesn't block the caller's turn.
    if (this.#clustersEnabled && this.#shouldRecluster()) {
      void this.#recluster();
    }
  }

  /**
   * Get the current index, rebuilding if triggers fired. Cheap when fresh
   * (returns cached string); spends <10ms when rebuilding. Safe to call on
   * the hot path of every turn.
   */
  get(): string {
    if (this.#shouldRebuild()) {
      this.#rebuild();
    }
    return this.#cached;
  }

  /** Force an immediate rebuild — useful on session start or after pins change. */
  forceRebuild(): string {
    this.#rebuild();
    return this.#cached;
  }

  /** Test-friendly accessor — returns whether the next get() will rebuild. */
  get isStale(): boolean {
    return this.#shouldRebuild();
  }

  #shouldRebuild(): boolean {
    const now = this.#now();
    const ageMs = now - this.#cachedAt;

    // Debounce: never rebuild faster than floor.
    if (this.#cachedAt > 0 && ageMs < this.#debounceMs) return false;

    // Cold start — build on first access.
    if (this.#cachedAt === 0) return true;

    // Hard trigger — enough new material to matter.
    if (this.#pendingEpisodes >= this.#episodeThreshold) return true;

    // Timed trigger — prevents drift during slow sessions.
    if (this.#pendingEpisodes >= 1 && ageMs >= this.#timeThresholdMs) return true;

    return false;
  }

  #rebuild(): void {
    // Cold-start the clusters if enabled and we haven't computed them yet.
    if (
      this.#clustersEnabled &&
      this.#lastClusteredAt === 0 &&
      !this.#reclusterRunning
    ) {
      void this.#recluster();
    }
    this.#cached = buildWorkspaceIndex(
      {
        store: this.#opts.store,
        workspaceId: this.#opts.workspaceId,
        workdir: this.#opts.workdir,
        currentSessionId: this.#opts.currentSessionId,
        clusters: this.#labeledClusters.length > 0 ? this.#labeledClusters : undefined,
      },
      this.#opts.indexOptions,
    );
    this.#cachedAt = this.#now();
    this.#pendingEpisodes = 0;
  }

  // ── Background clustering ────────────────────────────────────────────

  #shouldRecluster(): boolean {
    if (this.#reclusterRunning) return false;
    if (this.#episodesSinceLastCluster < RECLUSTER_EPISODE_THRESHOLD) return false;
    const age = this.#now() - this.#lastClusteredAt;
    return age >= RECLUSTER_INTERVAL_MS;
  }

  async #recluster(): Promise<void> {
    if (this.#reclusterRunning) return;
    this.#reclusterRunning = true;
    try {
      const episodes = this.#opts.store.listRecent(
        this.#opts.workspaceId,
        1000, // cluster over the most recent 1k episodes; older content has lower discovery value
      );
      if (episodes.length < MIN_EPISODES_FOR_CLUSTERING) {
        this.#labeledClusters = [];
        this.#lastClusteredAt = this.#now();
        this.#episodesSinceLastCluster = 0;
        return;
      }
      const clusters = clusterEpisodes(episodes, { k: 8 });
      // Label in parallel — CachedLabeler short-circuits on repeat signatures.
      const labeled = await Promise.all(
        clusters.map(async (c: Cluster) => ({
          cluster: c,
          label: (await this.#labeler.label(c)).label,
        })),
      );
      this.#labeledClusters = labeled;
      this.#lastClusteredAt = this.#now();
      this.#episodesSinceLastCluster = 0;
    } catch (err) {
      console.error(
        `[codeoid/memory] recluster failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.#reclusterRunning = false;
    }
  }
}
