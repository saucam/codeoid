/**
 * AsyncQueue tests — single consumer producer/consumer with bounded buffer.
 * Covers: happy path, buffered pre-push, waiting consumer unblock, close
 * semantics, overflow, concurrent-consumer rejection.
 */

import { describe, it, expect } from "bun:test";
import {
  AsyncQueue,
  AsyncQueueClosedError,
  AsyncQueueOverflowError,
} from "../daemon/async-queue.js";

describe("AsyncQueue — happy path", () => {
  it("buffers values pushed before consume, then iterates in order", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();

    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([1, 2, 3]);
  });

  it("wakes a waiting consumer when push arrives", async () => {
    const q = new AsyncQueue<string>();
    // Start consuming BEFORE pushing.
    const consumerDone = (async () => {
      const out: string[] = [];
      for await (const v of q) out.push(v);
      return out;
    })();

    // Give consumer a tick to start awaiting.
    await new Promise((r) => setTimeout(r, 0));
    q.push("a");
    q.push("b");
    q.close();
    expect(await consumerDone).toEqual(["a", "b"]);
  });

  it("close with empty buffer terminates immediately", async () => {
    const q = new AsyncQueue<number>();
    q.close();
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([]);
  });

  it("size tracks buffer depth", () => {
    const q = new AsyncQueue<number>();
    expect(q.size).toBe(0);
    q.push(1);
    q.push(2);
    expect(q.size).toBe(2);
  });
});

describe("AsyncQueue — failure modes", () => {
  it("push after close throws", () => {
    const q = new AsyncQueue<number>();
    q.close();
    expect(() => q.push(1)).toThrow(AsyncQueueClosedError);
  });

  it("overflow throws synchronously", () => {
    const q = new AsyncQueue<number>({ maxBuffered: 3 });
    q.push(1);
    q.push(2);
    q.push(3);
    expect(() => q.push(4)).toThrow(AsyncQueueOverflowError);
  });

  it("concurrent consumers are rejected", async () => {
    const q = new AsyncQueue<number>();
    // First consumer awaits.
    const p1 = q[Symbol.asyncIterator]().next();
    // Second attempt while first is pending should reject.
    await expect(q[Symbol.asyncIterator]().next()).rejects.toThrow(
      /concurrent consumers/,
    );
    // Clean up first consumer.
    q.close();
    await p1;
  });
});

describe("AsyncQueue — producer interleaved with consumer", () => {
  it("consumer drains pushes as they arrive out-of-step", async () => {
    const q = new AsyncQueue<number>();
    const received: number[] = [];

    const consumer = (async () => {
      for await (const v of q) {
        received.push(v);
        // Tiny delay so producer can push in-between iterations.
        await new Promise((r) => setTimeout(r, 1));
      }
    })();

    q.push(1);
    await new Promise((r) => setTimeout(r, 3));
    q.push(2);
    await new Promise((r) => setTimeout(r, 3));
    q.push(3);
    await new Promise((r) => setTimeout(r, 3));
    q.close();
    await consumer;

    expect(received).toEqual([1, 2, 3]);
  });

  it("return() from for-await (break) closes the queue", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);

    for await (const v of q) {
      if (v === 2) break; // triggers iterator.return()
    }
    expect(q.closed).toBe(true);
    expect(() => q.push(4)).toThrow();
  });
});
