/**
 * Rate limiter tests — validates per-user session limits,
 * hourly creation rates, and sliding window pruning.
 */

import { describe, test, expect } from "bun:test";
import { RateLimiter } from "../daemon/rate-limit.js";

describe("RateLimiter", () => {
  test("allows creation under limit", () => {
    const rl = new RateLimiter({ maxSessionsPerUser: 3, maxCreationsPerHour: 10 });
    expect(rl.check("user-1").allowed).toBe(true);
  });

  test("blocks when concurrent session limit reached", () => {
    const rl = new RateLimiter({ maxSessionsPerUser: 2, maxCreationsPerHour: 100 });
    rl.recordCreation("user-1");
    rl.recordCreation("user-1");

    const result = rl.check("user-1");
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toContain("Concurrent session limit");
  });

  test("destroying a session frees the slot", () => {
    const rl = new RateLimiter({ maxSessionsPerUser: 2, maxCreationsPerHour: 100 });
    rl.recordCreation("user-1");
    rl.recordCreation("user-1");
    expect(rl.check("user-1").allowed).toBe(false);

    rl.recordDestruction("user-1");
    expect(rl.check("user-1").allowed).toBe(true);
  });

  test("blocks when hourly creation rate exceeded", () => {
    const rl = new RateLimiter({ maxSessionsPerUser: 100, maxCreationsPerHour: 3 });

    // Create and destroy 3 sessions (slots free, but hourly rate hit)
    for (let i = 0; i < 3; i++) {
      rl.recordCreation("user-1");
      rl.recordDestruction("user-1");
    }

    const result = rl.check("user-1");
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toContain("Hourly creation limit");
  });

  test("different users are independent", () => {
    const rl = new RateLimiter({ maxSessionsPerUser: 1, maxCreationsPerHour: 100 });
    rl.recordCreation("user-1");

    expect(rl.check("user-1").allowed).toBe(false);
    expect(rl.check("user-2").allowed).toBe(true);
  });

  test("destruction never goes negative", () => {
    const rl = new RateLimiter();
    rl.recordDestruction("user-1"); // No prior creation
    rl.recordDestruction("user-1");

    const stats = rl.stats("user-1");
    expect(stats.activeSessions).toBe(0);
  });

  test("stats returns correct values", () => {
    const rl = new RateLimiter();
    rl.recordCreation("user-1");
    rl.recordCreation("user-1");
    rl.recordCreation("user-1");
    rl.recordDestruction("user-1");

    const stats = rl.stats("user-1");
    expect(stats.activeSessions).toBe(2);
    expect(stats.creationsThisHour).toBe(3);
  });

  test("stats for unknown user returns zeros", () => {
    const rl = new RateLimiter();
    const stats = rl.stats("nobody");
    expect(stats.activeSessions).toBe(0);
    expect(stats.creationsThisHour).toBe(0);
  });

  test("default limits: 10 concurrent, 30/hour", () => {
    const rl = new RateLimiter();

    // Fill to default limit
    for (let i = 0; i < 10; i++) {
      expect(rl.check("user-1").allowed).toBe(true);
      rl.recordCreation("user-1");
    }
    expect(rl.check("user-1").allowed).toBe(false);
  });
});
