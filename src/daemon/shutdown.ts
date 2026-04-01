/**
 * Graceful shutdown with cleanup registry.
 *
 * Production pattern from Claude Code: gracefulShutdown.ts + cleanupRegistry.ts
 *
 * Cleanup functions are registered by components (store, sessions, frontends)
 * and run in reverse order on SIGTERM/SIGINT. A grace period (default 30s)
 * ensures in-flight work can finish before forced exit.
 */

type CleanupFn = () => Promise<void> | void;

interface ShutdownConfig {
  /** Grace period before forced exit. Default: 30_000ms. */
  gracePeriodMs: number;
  /** Custom logger. Default: console. */
  logger: Pick<Console, "log" | "error">;
}

const DEFAULT_CONFIG: ShutdownConfig = {
  gracePeriodMs: 30_000,
  logger: console,
};

export class ShutdownManager {
  #cleanups: Array<{ name: string; fn: CleanupFn }> = [];
  #config: ShutdownConfig;
  #shuttingDown = false;
  #installed = false;

  constructor(config: Partial<ShutdownConfig> = {}) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a cleanup function. Runs in LIFO order on shutdown.
   * @param name - Label for logging (e.g. "store", "websocket", "telegram")
   * @param fn - Async cleanup function
   */
  register(name: string, fn: CleanupFn): void {
    this.#cleanups.push({ name, fn });
  }

  /**
   * Install signal handlers (SIGTERM, SIGINT, SIGHUP).
   * Idempotent — safe to call multiple times.
   */
  install(): void {
    if (this.#installed) return;
    this.#installed = true;

    const handler = (signal: string) => {
      this.#config.logger.log(`[codeoid] received ${signal}, shutting down...`);
      this.shutdown(signal).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };

    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
    process.on("SIGHUP", () => handler("SIGHUP"));

    // Catch uncaught errors — log and shutdown
    process.on("uncaughtException", (err) => {
      this.#config.logger.error("[codeoid] uncaught exception:", err);
      this.shutdown("uncaughtException").then(
        () => process.exit(1),
        () => process.exit(1),
      );
    });

    process.on("unhandledRejection", (err) => {
      this.#config.logger.error("[codeoid] unhandled rejection:", err);
      // Don't shutdown on unhandled rejections — just log.
      // The specific component should handle its own errors.
    });
  }

  /**
   * Run all cleanup functions in reverse registration order.
   * Enforces grace period — force exits if cleanups take too long.
   */
  async shutdown(signal: string): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;

    // Start grace period timer
    const forceTimer = setTimeout(() => {
      this.#config.logger.error(
        `[codeoid] grace period (${this.#config.gracePeriodMs}ms) exceeded, forcing exit`,
      );
      process.exit(1);
    }, this.#config.gracePeriodMs);

    // Prevent timer from keeping process alive
    if (typeof forceTimer === "object" && "unref" in forceTimer) {
      forceTimer.unref();
    }

    // Run cleanups in reverse order (LIFO)
    const reversed = [...this.#cleanups].reverse();
    for (const { name, fn } of reversed) {
      try {
        await fn();
        this.#config.logger.log(`[codeoid] cleanup done: ${name}`);
      } catch (err) {
        // Don't let one failure prevent others
        this.#config.logger.error(`[codeoid] cleanup failed: ${name}`, err);
      }
    }

    clearTimeout(forceTimer);
    this.#config.logger.log(`[codeoid] shutdown complete (${signal})`);
  }

  /** Whether shutdown is in progress. */
  get isShuttingDown(): boolean {
    return this.#shuttingDown;
  }
}
