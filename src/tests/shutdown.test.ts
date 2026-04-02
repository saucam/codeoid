/**
 * Shutdown manager tests — validates cleanup registry, LIFO ordering,
 * error isolation, and idempotency.
 */

import { describe, test, expect } from "bun:test";
import { ShutdownManager } from "../daemon/shutdown.js";

describe("ShutdownManager", () => {
  test("runs cleanups in LIFO order", async () => {
    const order: string[] = [];
    const sm = new ShutdownManager({ gracePeriodMs: 5000, logger: { log: () => {}, error: () => {} } });

    sm.register("first", async () => { order.push("first"); });
    sm.register("second", async () => { order.push("second"); });
    sm.register("third", async () => { order.push("third"); });

    await sm.shutdown("test");

    expect(order).toEqual(["third", "second", "first"]);
  });

  test("one failure does not block others", async () => {
    const order: string[] = [];
    const sm = new ShutdownManager({ gracePeriodMs: 5000, logger: { log: () => {}, error: () => {} } });

    sm.register("a", async () => { order.push("a"); });
    sm.register("b", async () => { throw new Error("boom"); });
    sm.register("c", async () => { order.push("c"); });

    await sm.shutdown("test");

    // c runs first (LIFO), b throws, a still runs
    expect(order).toEqual(["c", "a"]);
  });

  test("shutdown is idempotent", async () => {
    let count = 0;
    const sm = new ShutdownManager({ gracePeriodMs: 5000, logger: { log: () => {}, error: () => {} } });
    sm.register("counter", async () => { count++; });

    await sm.shutdown("first");
    await sm.shutdown("second"); // Should be no-op

    expect(count).toBe(1);
  });

  test("isShuttingDown flag", async () => {
    const sm = new ShutdownManager({ gracePeriodMs: 5000, logger: { log: () => {}, error: () => {} } });
    expect(sm.isShuttingDown).toBe(false);

    await sm.shutdown("test");
    expect(sm.isShuttingDown).toBe(true);
  });

  test("empty cleanup list completes cleanly", async () => {
    const sm = new ShutdownManager({ gracePeriodMs: 5000, logger: { log: () => {}, error: () => {} } });
    await sm.shutdown("test"); // Should not throw
    expect(sm.isShuttingDown).toBe(true);
  });

  test("sync cleanup functions work", async () => {
    const order: string[] = [];
    const sm = new ShutdownManager({ gracePeriodMs: 5000, logger: { log: () => {}, error: () => {} } });

    sm.register("sync", () => { order.push("sync"); });
    sm.register("async", async () => { order.push("async"); });

    await sm.shutdown("test");
    expect(order).toEqual(["async", "sync"]);
  });
});
