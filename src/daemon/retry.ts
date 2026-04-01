/**
 * Persistent retry with exponential backoff and fallback model support.
 *
 * Production pattern from Claude Code: withRetry.ts
 *
 * Error categories:
 *   429 → Rate limit: retry with backoff (up to maxRetries)
 *   529 → Capacity: limited retries (max 3), then fallback model
 *   5xx → Server error: retry with backoff
 *   401/403 → Auth: no retry, re-auth
 *   Network → Connection: retry with keep-alive disabled
 */

export interface RetryConfig {
  /** Max retry attempts. Default: 10. */
  maxRetries: number;
  /** Initial delay in ms. Default: 500. */
  baseDelayMs: number;
  /** Max delay in ms. Default: 30_000. */
  maxDelayMs: number;
  /** Max capacity (529) retries before fallback. Default: 3. */
  maxCapacityRetries: number;
  /** Fallback model when primary hits capacity limit. */
  fallbackModel?: string;
  /**
   * Unattended mode — retries indefinitely with longer backoff.
   * For daemon sessions running without an attached client.
   */
  unattended: boolean;
  /** Max backoff for unattended mode. Default: 5 min. */
  unattendedMaxDelayMs: number;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 10,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxCapacityRetries: 3,
  unattended: false,
  unattendedMaxDelayMs: 5 * 60_000,
};

export type ErrorCategory =
  | "rate_limit"      // 429
  | "capacity"        // 529
  | "server_error"    // 5xx
  | "auth_error"      // 401/403
  | "connection"      // ECONNRESET, ECONNREFUSED, timeout
  | "unknown";

export interface RetryEvent {
  attempt: number;
  category: ErrorCategory;
  delayMs: number;
  error: Error;
  willRetry: boolean;
  usingFallback: boolean;
}

export function categorizeError(err: unknown): ErrorCategory {
  if (!(err instanceof Error)) return "unknown";

  const msg = err.message.toLowerCase();
  const status = (err as { status?: number }).status;

  if (status === 429) return "rate_limit";
  if (status === 529) return "capacity";
  if (status && status >= 500 && status < 600) return "server_error";
  if (status === 401 || status === 403) return "auth_error";
  if (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed") ||
    msg.includes("network")
  ) {
    return "connection";
  }

  return "unknown";
}

function shouldRetry(category: ErrorCategory, attempt: number, config: RetryConfig): boolean {
  switch (category) {
    case "auth_error":
      return false; // Never retry auth errors
    case "capacity":
      return attempt <= config.maxCapacityRetries;
    case "rate_limit":
    case "server_error":
    case "connection":
      return config.unattended || attempt <= config.maxRetries;
    case "unknown":
      return attempt <= Math.min(3, config.maxRetries);
  }
}

function jitteredDelay(baseDelay: number, maxDelay: number): number {
  // Add ±25% jitter to prevent thundering herd
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.min(baseDelay * jitter, maxDelay);
}

/**
 * Execute an async function with retry logic.
 *
 * @param fn - The function to retry. Receives `{ attempt, fallbackModel }`.
 * @param config - Retry configuration.
 * @param onRetry - Optional callback for retry events (logging, telemetry).
 * @param signal - AbortSignal to cancel retries.
 */
export async function withRetry<T>(
  fn: (ctx: { attempt: number; fallbackModel?: string }) => Promise<T>,
  config: Partial<RetryConfig> = {},
  onRetry?: (event: RetryEvent) => void,
  signal?: AbortSignal,
): Promise<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let delay = cfg.baseDelayMs;
  let capacityRetries = 0;
  let useFallback = false;

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) {
      throw new Error("Aborted");
    }

    try {
      return await fn({
        attempt,
        fallbackModel: useFallback ? cfg.fallbackModel : undefined,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const category = categorizeError(err);

      if (category === "capacity") {
        capacityRetries++;
        if (capacityRetries > cfg.maxCapacityRetries && cfg.fallbackModel) {
          useFallback = true;
        }
      }

      const maxDelay = cfg.unattended ? cfg.unattendedMaxDelayMs : cfg.maxDelayMs;
      const willRetry = shouldRetry(category, attempt, cfg);

      onRetry?.({
        attempt,
        category,
        delayMs: willRetry ? delay : 0,
        error,
        willRetry,
        usingFallback: useFallback,
      });

      if (!willRetry) {
        throw error;
      }

      await Bun.sleep(jitteredDelay(delay, maxDelay));
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}
