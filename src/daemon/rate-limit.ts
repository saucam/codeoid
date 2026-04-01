/**
 * Per-user rate limiting.
 *
 * Production pattern from Claude Code: UserHourlyRateLimiter
 *
 * Tracks session creation per ZeroID subject over a sliding window.
 * Prevents runaway session creation (DoS, misconfigured bots, etc.).
 */

export interface RateLimitConfig {
  /** Max sessions per user (alive at the same time). Default: 10. */
  maxSessionsPerUser: number;
  /** Max session creations per user per hour. Default: 30. */
  maxCreationsPerHour: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxSessionsPerUser: 10,
  maxCreationsPerHour: 30,
};

interface CreationRecord {
  timestamps: number[];
}

export class RateLimiter {
  #config: RateLimitConfig;
  #creations = new Map<string, CreationRecord>();
  #activeSessions = new Map<string, number>(); // subject → active count

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a user can create a new session.
   * Returns { allowed: true } or { allowed: false, reason: string }.
   */
  check(sub: string): { allowed: true } | { allowed: false; reason: string } {
    // Check concurrent session limit
    const active = this.#activeSessions.get(sub) ?? 0;
    if (active >= this.#config.maxSessionsPerUser) {
      return {
        allowed: false,
        reason: `Concurrent session limit (${this.#config.maxSessionsPerUser}) reached`,
      };
    }

    // Check hourly creation rate
    const record = this.#creations.get(sub);
    if (record) {
      const oneHourAgo = Date.now() - 3_600_000;
      // Prune old timestamps
      record.timestamps = record.timestamps.filter((t) => t > oneHourAgo);

      if (record.timestamps.length >= this.#config.maxCreationsPerHour) {
        return {
          allowed: false,
          reason: `Hourly creation limit (${this.#config.maxCreationsPerHour}/hr) reached`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record a session creation for a user.
   */
  recordCreation(sub: string): void {
    // Track creation timestamp
    let record = this.#creations.get(sub);
    if (!record) {
      record = { timestamps: [] };
      this.#creations.set(sub, record);
    }
    record.timestamps.push(Date.now());

    // Increment active count
    this.#activeSessions.set(sub, (this.#activeSessions.get(sub) ?? 0) + 1);
  }

  /**
   * Record a session destruction for a user.
   */
  recordDestruction(sub: string): void {
    const active = this.#activeSessions.get(sub) ?? 0;
    if (active > 0) {
      this.#activeSessions.set(sub, active - 1);
    }
  }

  /**
   * Get current stats for a user (for debugging/UI).
   */
  stats(sub: string): { activeSessions: number; creationsThisHour: number } {
    const active = this.#activeSessions.get(sub) ?? 0;
    const record = this.#creations.get(sub);
    const oneHourAgo = Date.now() - 3_600_000;
    const creationsThisHour = record
      ? record.timestamps.filter((t) => t > oneHourAgo).length
      : 0;
    return { activeSessions: active, creationsThisHour };
  }
}
