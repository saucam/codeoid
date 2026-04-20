/**
 * AsyncQueue — a bounded unbounded async iterator for producer/consumer
 * patterns. Producer calls `push(v)` from anywhere; consumer drives a
 * `for await (const v of queue)` loop that blocks between pushes.
 *
 * Used by Session to feed SDKUserMessage values into a long-lived
 * `query({ prompt: AsyncIterable })` — so user sends become mid-turn
 * pushes into an already-running Claude Code subprocess.
 *
 * Invariants:
 *   - Never buffers more than `maxBuffered` pending values; further pushes
 *     throw synchronously. Protects against runaway user input.
 *   - `close()` terminates the iterator cleanly after draining.
 *   - Post-close pushes are rejected synchronously.
 *   - Single consumer only — concurrent `for await` is not supported.
 *
 * Not a general-purpose library — no cancellation propagation, no priority
 * reorder, no multiple consumers. If we need those, reach for rxjs or
 * stream/consumers. For now this is 40 lines of purpose-built plumbing.
 */

export interface AsyncQueueOptions {
  /** Max pending values before push throws. Default 1024. */
  maxBuffered?: number;
}

export class AsyncQueueClosedError extends Error {
  constructor() {
    super("AsyncQueue is closed");
    this.name = "AsyncQueueClosedError";
  }
}

export class AsyncQueueOverflowError extends Error {
  constructor(max: number) {
    super(`AsyncQueue overflow — max buffered = ${max}`);
    this.name = "AsyncQueueOverflowError";
  }
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #buffer: T[] = [];
  readonly #maxBuffered: number;
  #closed = false;
  /** Set when a consumer is awaiting the next value. Exactly one or zero. */
  #waker: ((v: IteratorResult<T>) => void) | null = null;

  constructor(opts: AsyncQueueOptions = {}) {
    this.#maxBuffered = opts.maxBuffered ?? 1024;
  }

  /** Synchronously enqueue a value. Wakes any waiting consumer. */
  push(value: T): void {
    if (this.#closed) throw new AsyncQueueClosedError();
    if (this.#waker) {
      const w = this.#waker;
      this.#waker = null;
      w({ value, done: false });
      return;
    }
    if (this.#buffer.length >= this.#maxBuffered) {
      throw new AsyncQueueOverflowError(this.#maxBuffered);
    }
    this.#buffer.push(value);
  }

  /** Peek at current buffer depth (for telemetry/UIs). */
  get size(): number {
    return this.#buffer.length;
  }

  /** True after close() has been called. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Close the queue. Any buffered values are still delivered to the
   * consumer; the iterator ends after the last one.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#waker) {
      const w = this.#waker;
      this.#waker = null;
      w({ value: undefined, done: true });
    }
  }

  // ── AsyncIterable ─────────────────────────────────────────────────────

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.#buffer.length > 0) {
          const value = this.#buffer.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.#closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        if (this.#waker) {
          return Promise.reject(
            new Error("AsyncQueue does not support concurrent consumers"),
          );
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.#waker = resolve;
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
