/**
 * Scrollback buffer — circular ring buffer that captures recent session output.
 *
 * When a client attaches (or reattaches from a different device), the buffer
 * is replayed so they see what happened while disconnected.
 *
 * Production pattern from Claude Code: session-manager.ts scrollback replay.
 */

import type { DaemonMessage } from "../protocol/types.js";

export interface ScrollbackConfig {
  /** Max entries to keep. Default: 5000. */
  maxEntries: number;
  /** Max total bytes. Default: 20MB. */
  maxBytes: number;
}

// Sized for a native (Ratatui/Rust) frontend doing immediate-mode rendering.
// The prior 500 / 1MB ceiling was shaped around Ink's React reconciliation
// budget; a zero-flicker TUI comfortably holds a 10x larger working set.
const DEFAULT_CONFIG: ScrollbackConfig = {
  maxEntries: 5000,
  maxBytes: 20 * 1024 * 1024, // 20MB
};

export class ScrollbackBuffer {
  #entries: DaemonMessage[] = [];
  #bytes = 0;
  #config: ScrollbackConfig;

  constructor(config: Partial<ScrollbackConfig> = {}) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Push a message into the buffer. Evicts oldest entries if limits are exceeded.
   */
  push(msg: DaemonMessage): void {
    const size = JSON.stringify(msg).length;
    this.#entries.push(msg);
    this.#bytes += size;

    // Evict from front until within limits
    while (
      this.#entries.length > this.#config.maxEntries ||
      this.#bytes > this.#config.maxBytes
    ) {
      const evicted = this.#entries.shift();
      if (evicted) {
        this.#bytes -= JSON.stringify(evicted).length;
      }
    }
  }

  /**
   * Read all buffered messages. Used on client attach to replay history.
   * Returns a snapshot — safe to iterate while new messages arrive.
   */
  read(): DaemonMessage[] {
    return [...this.#entries];
  }

  /**
   * Read messages after a given timestamp (for incremental catch-up).
   */
  readSince(timestamp: string): DaemonMessage[] {
    return this.#entries.filter(
      (msg) => "timestamp" in msg && (msg as { timestamp: string }).timestamp > timestamp,
    );
  }

  /**
   * Update a message in the buffer by messageId. Used to apply tool state
   * transitions so scrollback replay shows final states, not intermediate.
   */
  updateMessage(messageId: string, updater: (msg: DaemonMessage) => void): void {
    for (const entry of this.#entries) {
      if (entry.type === "session.message" && (entry as { messageId?: string }).messageId === messageId) {
        updater(entry);
        return;
      }
    }
  }

  /** Number of entries currently buffered. */
  get length(): number {
    return this.#entries.length;
  }

  /** Total bytes currently buffered. */
  get bytes(): number {
    return this.#bytes;
  }

  /** Clear the buffer. */
  clear(): void {
    this.#entries = [];
    this.#bytes = 0;
  }
}
