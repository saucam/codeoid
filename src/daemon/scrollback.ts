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

/**
 * Internal wrapper that records the byte size that was actually accounted
 * into `#bytes` for this entry. Streamed messages are held by reference and
 * grow in place between push and finalize; eviction must subtract exactly
 * what was added, never the current (grown) serialized size — otherwise the
 * counter drifts negative and the byte cap stops evicting.
 */
interface Entry {
  msg: DaemonMessage;
  size: number;
}

function messageIdOf(msg: DaemonMessage): string | undefined {
  return msg.type === "session.message"
    ? (msg as { messageId?: string }).messageId
    : undefined;
}

/**
 * Serialized size in real UTF-8 bytes. `String.length` counts UTF-16 code
 * units, undercounting non-ASCII payloads against the byte cap.
 */
function serializedSizeOf(msg: DaemonMessage): number {
  return Buffer.byteLength(JSON.stringify(msg), "utf8");
}

export class ScrollbackBuffer {
  #entries: Entry[] = [];
  #byId = new Map<string, Entry>();
  #bytes = 0;
  #config: ScrollbackConfig;

  constructor(config: Partial<ScrollbackConfig> = {}) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Push a message into the buffer. Evicts oldest entries if limits are exceeded.
   *
   * Upserts by messageId: pushing a message whose messageId is already
   * buffered re-accounts the existing entry in place (keeping its position)
   * instead of appending a second entry. Duplicate entries for one messageId
   * corrupt scrollback.replay — clients render the message twice and
   * virtualizers keyed on messageId collide (the #50 bug class).
   *
   * `sizeHint` lets callers that already know the message's serialized size
   * (resume replays it straight off a transcript line) skip the
   * JSON.stringify here — restoring thousands of messages otherwise
   * re-serializes every one of them purely for byte accounting.
   */
  push(msg: DaemonMessage, sizeHint?: number): void {
    const messageId = messageIdOf(msg);
    if (messageId !== undefined) {
      const existing = this.#byId.get(messageId);
      if (existing) {
        const size = sizeHint ?? serializedSizeOf(msg);
        this.#bytes += size - existing.size;
        existing.msg = msg;
        existing.size = size;
        this.#evict();
        return;
      }
    }
    const entry: Entry = { msg, size: sizeHint ?? serializedSizeOf(msg) };
    this.#entries.push(entry);
    if (messageId !== undefined) this.#byId.set(messageId, entry);
    this.#bytes += entry.size;
    this.#evict();
  }

  /** Evict oldest entries until within both limits. */
  #evict(): void {
    while (
      this.#entries.length > this.#config.maxEntries ||
      this.#bytes > this.#config.maxBytes
    ) {
      const evicted = this.#entries.shift();
      if (!evicted) break;
      this.#bytes -= evicted.size;
      const id = messageIdOf(evicted.msg);
      if (id !== undefined && this.#byId.get(id) === evicted) {
        this.#byId.delete(id);
      }
    }
  }

  /**
   * Read all buffered messages. Used on client attach to replay history.
   * Returns a snapshot — safe to iterate while new messages arrive.
   */
  read(): DaemonMessage[] {
    return this.#entries.map((e) => e.msg);
  }

  /**
   * Partition buffered messages into ordered chunks (oldest→newest), each
   * holding at most ~`maxBytes` of serialized message payload. Used to replay
   * a large scrollback across multiple WS frames so no single frame exceeds
   * the server's outbound backpressure limit (#84) and no one-shot stringify
   * of the whole buffer stalls the event loop.
   *
   * Uses the byte sizes already accounted per entry — no re-serialization. A
   * single message larger than `maxBytes` occupies its own chunk (never split);
   * such a chunk can exceed `maxBytes`, which is unavoidable without dropping
   * the message. Returns [] for an empty buffer.
   */
  readChunked(maxBytes: number): DaemonMessage[][] {
    const chunks: DaemonMessage[][] = [];
    let current: DaemonMessage[] = [];
    let currentBytes = 0;
    for (const entry of this.#entries) {
      // Start a new chunk when adding this entry would overflow the budget,
      // but never emit an empty chunk (a lone oversized message stays put).
      if (current.length > 0 && currentBytes + entry.size > maxBytes) {
        chunks.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(entry.msg);
      currentBytes += entry.size;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  /**
   * Read messages after a given timestamp (for incremental catch-up).
   */
  readSince(timestamp: string): DaemonMessage[] {
    return this.#entries
      .map((e) => e.msg)
      .filter(
        (msg) => "timestamp" in msg && (msg as { timestamp: string }).timestamp > timestamp,
      );
  }

  /**
   * Update a message in the buffer by messageId. Used to apply tool state
   * transitions so scrollback replay shows final states, not intermediate.
   */
  updateMessage(messageId: string, updater: (msg: DaemonMessage) => void): void {
    const entry = this.#byId.get(messageId);
    if (!entry) return;
    updater(entry.msg);
    const after = serializedSizeOf(entry.msg);
    this.#bytes += after - entry.size;
    entry.size = after;
    this.#evict();
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
    this.#byId.clear();
    this.#bytes = 0;
  }
}
