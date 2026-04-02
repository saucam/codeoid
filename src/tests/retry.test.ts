/**
 * Retry logic tests — validates error categorization, backoff behavior,
 * capacity limits, fallback model, and abort handling.
 */

import { describe, test, expect } from "bun:test";
import { categorizeError, withRetry, type RetryEvent } from "../daemon/retry.js";

describe("categorizeError", () => {
  test("429 → rate_limit", () => {
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    expect(categorizeError(err)).toBe("rate_limit");
  });

  test("529 → capacity", () => {
    const err = Object.assign(new Error("Overloaded"), { status: 529 });
    expect(categorizeError(err)).toBe("capacity");
  });

  test("500 → server_error", () => {
    const err = Object.assign(new Error("Internal"), { status: 500 });
    expect(categorizeError(err)).toBe("server_error");
  });

  test("502 → server_error", () => {
    const err = Object.assign(new Error("Bad Gateway"), { status: 502 });
    expect(categorizeError(err)).toBe("server_error");
  });

  test("401 → auth_error", () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    expect(categorizeError(err)).toBe("auth_error");
  });

  test("403 → auth_error", () => {
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    expect(categorizeError(err)).toBe("auth_error");
  });

  test("ECONNRESET → connection", () => {
    expect(categorizeError(new Error("ECONNRESET"))).toBe("connection");
  });

  test("ECONNREFUSED → connection", () => {
    expect(categorizeError(new Error("ECONNREFUSED"))).toBe("connection");
  });

  test("fetch failed → connection", () => {
    expect(categorizeError(new Error("fetch failed"))).toBe("connection");
  });

  test("unknown error → unknown", () => {
    expect(categorizeError(new Error("something weird"))).toBe("unknown");
  });

  test("non-Error → unknown", () => {
    expect(categorizeError("string error")).toBe("unknown");
    expect(categorizeError(42)).toBe("unknown");
    expect(categorizeError(null)).toBe("unknown");
  });
});

describe("withRetry", () => {
  test("returns result on first success", async () => {
    const result = await withRetry(async () => "ok", { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
  });

  test("retries on failure then succeeds", async () => {
    let attempt = 0;
    const result = await withRetry(
      async () => {
        attempt++;
        if (attempt < 3) throw Object.assign(new Error("fail"), { status: 500 });
        return "ok";
      },
      { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 10 },
    );
    expect(result).toBe("ok");
    expect(attempt).toBe(3);
  });

  test("throws after maxRetries exceeded", async () => {
    let attempt = 0;
    await expect(
      withRetry(
        async () => { attempt++; throw Object.assign(new Error("fail"), { status: 500 }); },
        { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 },
      ),
    ).rejects.toThrow("fail");
    expect(attempt).toBe(4); // initial + 3 retries
  });

  test("does not retry auth errors", async () => {
    let attempt = 0;
    await expect(
      withRetry(
        async () => { attempt++; throw Object.assign(new Error("unauthorized"), { status: 401 }); },
        { maxRetries: 10, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("unauthorized");
    expect(attempt).toBe(1); // No retries
  });

  test("capacity errors limited to maxCapacityRetries", async () => {
    let attempt = 0;
    await expect(
      withRetry(
        async () => { attempt++; throw Object.assign(new Error("overloaded"), { status: 529 }); },
        { maxRetries: 10, maxCapacityRetries: 2, baseDelayMs: 1, maxDelayMs: 5 },
      ),
    ).rejects.toThrow("overloaded");
    expect(attempt).toBe(3); // initial + 2 capacity retries
  });

  test("calls onRetry callback", async () => {
    const events: RetryEvent[] = [];
    let attempt = 0;

    await withRetry(
      async () => {
        attempt++;
        if (attempt < 3) throw Object.assign(new Error("fail"), { status: 500 });
        return "ok";
      },
      { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5 },
      (event) => events.push(event),
    );

    expect(events).toHaveLength(2);
    expect(events[0].attempt).toBe(1);
    expect(events[0].category).toBe("server_error");
    expect(events[0].willRetry).toBe(true);
    expect(events[1].attempt).toBe(2);
  });

  test("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      withRetry(
        async () => "should not run",
        { maxRetries: 3, baseDelayMs: 1 },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("Aborted");
  });

  test("fallback model reported via onRetry after capacity limit", async () => {
    const events: RetryEvent[] = [];

    await expect(
      withRetry(
        async () => {
          throw Object.assign(new Error("overloaded"), { status: 529 });
        },
        {
          maxRetries: 10,
          maxCapacityRetries: 3,
          baseDelayMs: 1,
          maxDelayMs: 5,
          fallbackModel: "claude-haiku",
        },
        (event) => events.push(event),
      ),
    ).rejects.toThrow();

    // First 3 retries: not using fallback
    expect(events[0].usingFallback).toBe(false);
    expect(events[1].usingFallback).toBe(false);
    expect(events[2].usingFallback).toBe(false);
    // 4th capacity error exceeds limit → fallback activated in event
    expect(events[3].usingFallback).toBe(true);
    // And it should stop retrying (capacity limit hit)
    expect(events[3].willRetry).toBe(false);
  });
});
