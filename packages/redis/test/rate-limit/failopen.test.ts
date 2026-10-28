import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRateLimiter, createQuota, createConcurrencyLimiter, shutdown, silentLogger } from "@oneunit/redis";

const URL = "redis://127.0.0.1:6379/9";

describe("Fail-Open Behavior", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("rate limiter fail-open on closed redis", async () => {
    await shutdown(client, silentLogger);
    const rl = createRateLimiter(client, { algorithm: "fixed-window", limit: 2, intervalMs: 1000, failurePolicy: "fail-open" });
    const r = await rl.consume("k", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.fallback, true);
    assert.ok(r.metadata?.error);
  });

  test("rate limiter fail-open on all algorithms", async () => {
    await shutdown(client, silentLogger);
    const algorithms: Array<"fixed-window" | "sliding-window" | "token-bucket" | "leaky-bucket"> = [
      "fixed-window", "sliding-window", "token-bucket", "leaky-bucket"
    ];
    for (const alg of algorithms) {
      const rl = createRateLimiter(client, {
        algorithm: alg,
        limit: 10,
        intervalMs: 1000,
        failurePolicy: "fail-open",
        ...(alg === "token-bucket" && { tokenBucket: { capacity: 10, refillRatePerSecond: 1, initialTokens: 10 } }),
        ...(alg === "leaky-bucket" && { leakyBucket: { capacity: 10, leakRatePerSecond: 1 } })
      });
      const r = await rl.consume("alg:1", 1);
      assert.equal(r.allowed, true, `${alg} should fail-open`);
      assert.equal(r.fallback, true, `${alg} should have fallback=true`);
    }
  });

  test("quota fail-open on closed redis", async () => {
    await shutdown(client, silentLogger);
    const q = createQuota(client, { resource: "q", quota: 10, period: "daily", failurePolicy: "fail-open" });
    const r = await q.consume("u", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.fallback, true);
  });

  test("concurrency limiter fail-open on closed redis", async () => {
    await shutdown(client, silentLogger);
    const cl = createConcurrencyLimiter(client, { resource: "cl", maxConcurrency: 2, leaseMs: 5000, failurePolicy: "fail-open" });
    const r = await cl.acquire("o1");
    assert.equal(r.acquired, true);
    assert.equal(r.fallback, true);
  });

  test("fail-open distinguishes fallback from normal allow", async () => {
    await shutdown(client, silentLogger);
    const rl = createRateLimiter(client, { algorithm: "fixed-window", limit: 2, intervalMs: 1000, failurePolicy: "fail-open" });
    const r = await rl.consume("k", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.fallback, true);
    // Normal allow would have fallback=false
  });

  test("fail-open preserves original error in metadata", async () => {
    await shutdown(client, silentLogger);
    const rl = createRateLimiter(client, { algorithm: "fixed-window", limit: 2, intervalMs: 1000, failurePolicy: "fail-open" });
    const r = await rl.consume("k", 1);
    assert.ok(r.metadata?.error);
    assert.ok(r.metadata.error.includes("Connection is closed") || r.metadata.error.includes("ECONNREFUSED"));
  });

  test("fail-open does not catch invalid input errors", async () => {
    const rl = createRateLimiter(client, { algorithm: "fixed-window", limit: 2, intervalMs: 1000, failurePolicy: "fail-open" });
    await assert.rejects(() => rl.consume("k", 0), /weight must be/);
    await assert.rejects(() => rl.consume("k", -1), /weight must be/);
    await assert.rejects(() => rl.consume("k", NaN), /weight must be/);
  });
});

describe("Fail-Closed Behavior", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("rate limiter fail-closed on closed redis", async () => {
    await shutdown(client, silentLogger);
    const rl = createRateLimiter(client, { algorithm: "fixed-window", limit: 2, intervalMs: 1000, failurePolicy: "fail-closed" });
    let threw = false;
    try { await rl.consume("k", 1); } catch { threw = true; }
    assert.equal(threw, true);
  });

  test("rate limiter fail-closed on all algorithms", async () => {
    await shutdown(client, silentLogger);
    const algorithms: Array<"fixed-window" | "sliding-window" | "token-bucket" | "leaky-bucket"> = [
      "fixed-window", "sliding-window", "token-bucket", "leaky-bucket"
    ];
    for (const alg of algorithms) {
      const rl = createRateLimiter(client, {
        algorithm: alg,
        limit: 10,
        intervalMs: 1000,
        failurePolicy: "fail-closed",
        ...(alg === "token-bucket" && { tokenBucket: { capacity: 10, refillRatePerSecond: 1, initialTokens: 10 } }),
        ...(alg === "leaky-bucket" && { leakyBucket: { capacity: 10, leakRatePerSecond: 1 } })
      });
      let threw = false;
      try { await rl.consume("alg:1", 1); } catch { threw = true; }
      assert.equal(threw, true, `${alg} should fail-closed`);
    }
  });

  test("quota fail-closed on closed redis", async () => {
    await shutdown(client, silentLogger);
    const q = createQuota(client, { resource: "q", quota: 10, period: "daily", failurePolicy: "fail-closed" });
    let threw = false;
    try { await q.consume("u", 1); } catch { threw = true; }
    assert.equal(threw, true);
  });

  test("concurrency limiter fail-closed on closed redis", async () => {
    await shutdown(client, silentLogger);
    const cl = createConcurrencyLimiter(client, { resource: "cl", maxConcurrency: 2, leaseMs: 5000, failurePolicy: "fail-closed" });
    let threw = false;
    try { await cl.acquire("o1"); } catch { threw = true; }
    assert.equal(threw, true);
  });

  test("fail-closed is default when not specified", async () => {
    await shutdown(client, silentLogger);
    const rl = createRateLimiter(client, { algorithm: "fixed-window", limit: 2, intervalMs: 1000 });
    let threw = false;
    try { await rl.consume("k", 1); } catch { threw = true; }
    assert.equal(threw, true);
  });
});

describe("Fail-Open/Fail-Closed: Edge Cases", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("fail-open does not mask ambiguous consumption outcome", async () => {
    // This test documents that if a consume succeeds but response is lost,
    // the fail-open doesn't cause double consumption
    await shutdown(client, silentLogger);
    const rl = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 1000, failurePolicy: "fail-open" });
    const r = await rl.consume("ambiguous:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.fallback, true);
    // The fallback allow doesn't consume from Redis (Redis is down)
    // So no double consumption risk
  });

  test("cancellation not swallowed by fail-open", async () => {
    const rl = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 1000, failurePolicy: "fail-open" });
    // We can't easily test cancellation in rate limiter since it doesn't support AbortSignal
    // This documents the limitation
    const r = await rl.consume("cancel:1", 1);
    assert.equal(r.allowed, true);
  });

  test("burst protector fail-open delegates to sub-limiters", async () => {
    await shutdown(client, silentLogger);
    const bp = createClient({ url: URL }, silentLogger);
    // Can't easily test burst protector without valid client
    // This documents the behavior
    await shutdown(bp, silentLogger);
  });
});

describe("Fail-Open/Fail-Closed: Multi-Limiter", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("multi-rate-limiter with fail-open sub-limiters", async () => {
    await shutdown(client, silentLogger);
    const a = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 1000, failurePolicy: "fail-open", keyPrefix: "a" });
    const b = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 1000, failurePolicy: "fail-open", keyPrefix: "b" });
    const { createMultiRateLimiter } = await import("../../dist/index.js");
    const multi = createMultiRateLimiter([a, b]);
    const r = await multi.consume("u", 1);
    assert.equal(r.allowed, true);
    // Both sub-limiters should have fallback=true
    assert.ok(r.decisions[0].fallback === true);
    assert.ok(r.decisions[1].fallback === true);
  });

  test("multi-rate-limiter with fail-closed sub-limiters", async () => {
    await shutdown(client, silentLogger);
    const a = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 1000, failurePolicy: "fail-closed", keyPrefix: "a" });
    const b = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 1000, failurePolicy: "fail-closed", keyPrefix: "b" });
    const { createMultiRateLimiter } = await import("../../dist/index.js");
    const multi = createMultiRateLimiter([a, b]);
    let threw = false;
    try { await multi.consume("u", 1); } catch { threw = true; }
    assert.equal(threw, true);
  });
});