import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createClient, createBurstProtector, createRateLimiter, createQuota, createConcurrencyLimiter, shutdown, silentLogger } from "../../dist/index.js";

const URL = "redis://127.0.0.1:6379/9";

describe("Burst Protection", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("short burst within allowed capacity", async () => {
    const bp = createBurstProtector(client, { 
      sustainedLimit: 10, 
      sustainedIntervalMs: 10000, 
      burstCapacity: 5, 
      burstIntervalMs: 1000 
    });
    
    const r1 = await bp.consume("user:1", 1);
    const r2 = await bp.consume("user:1", 1);
    const r3 = await bp.consume("user:1", 1);
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, true);
    assert.equal(r3.allowed, true);
  });

  test("burst exceeding capacity denied", async () => {
    const bp = createBurstProtector(client, { 
      sustainedLimit: 10, 
      sustainedIntervalMs: 10000, 
      burstCapacity: 3, 
      burstIntervalMs: 1000 
    });
    
    await bp.consume("burst:1", 1);
    await bp.consume("burst:1", 1);
    await bp.consume("burst:1", 1);
    const r4 = await bp.consume("burst:1", 1);
    assert.equal(r4.allowed, false);
    assert.equal(r4.reason, "burst_limit");
  });

  test("sustained limit enforced", async () => {
    const bp = createBurstProtector(client, { 
      sustainedLimit: 2, 
      sustainedIntervalMs: 10000, 
      burstCapacity: 10, 
      burstIntervalMs: 1000 
    });
    
    await bp.consume("sustained:1", 1);
    await bp.consume("sustained:1", 1);
    const r3 = await bp.consume("sustained:1", 1);
    assert.equal(r3.allowed, false);
    assert.equal(r3.reason, "sustained_limit");
  });

  test("sustained checked before burst", async () => {
    const bp = createBurstProtector(client, { 
      sustainedLimit: 1, 
      sustainedIntervalMs: 10000, 
      burstCapacity: 10, 
      burstIntervalMs: 1000 
    });
    
    await bp.consume("order:1", 1); // uses sustained
    const r = await bp.consume("order:1", 1); // sustained exhausted, burst not checked
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "sustained_limit");
  });

  test("burst refill allows more after wait", async () => {
    const bp = createBurstProtector(client, { 
      sustainedLimit: 100, 
      sustainedIntervalMs: 60000, 
      burstCapacity: 2, 
      burstIntervalMs: 500,
      burstRefillRatePerSecond: 4 // 4 per second = 1 per 250ms
    });
    
    await bp.consume("refill:1", 1);
    await bp.consume("refill:1", 1);
    const r1 = await bp.consume("refill:1", 1);
    assert.equal(r1.allowed, false);
    assert.equal(r1.reason, "burst_limit");
    
    await new Promise(resolve => setTimeout(resolve, 300));
    const r2 = await bp.consume("refill:1", 1);
    assert.equal(r2.allowed, true, "Burst should have refilled");
  });

  test("concurrency limit enforced", async () => {
    const bp = createBurstProtector(client, { 
      sustainedLimit: 100, 
      sustainedIntervalMs: 60000, 
      burstCapacity: 10, 
      burstIntervalMs: 1000,
      concurrencyLimit: 2,
      concurrencyLeaseMs: 5000
    });
    
    const r1 = await bp.consume("conc:1", 1, true);
    const r2 = await bp.consume("conc:1", 1, true);
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, true);
    assert.ok(r1.concurrencyToken);
    assert.ok(r2.concurrencyToken);
    
    const r3 = await bp.consume("conc:1", 1, true);
    assert.equal(r3.allowed, false);
    assert.equal(r3.reason, "concurrency_limit");
  });

  test("concurrency token released after use", async () => {
    const bp = createBurstProtector(client, { 
      sustainedLimit: 100, 
      sustainedIntervalMs: 60000, 
      burstCapacity: 10, 
      burstIntervalMs: 1000,
      concurrencyLimit: 1,
      concurrencyLeaseMs: 5000
    });
    
    const r1 = await bp.consume("release:1", 1, true);
    assert.equal(r1.allowed, true);
    const token = r1.concurrencyToken!;
    
    const r2 = await bp.consume("release:1", 1, true);
    assert.equal(r2.allowed, false);
    
    await bp.releaseConcurrency(token);
    const r3 = await bp.consume("release:1", 1, true);
    assert.equal(r3.allowed, true);
  });

  test("weighted burst consumption", async () => {
    const bp = createBurstProtector(client, { 
      sustainedLimit: 10, 
      sustainedIntervalMs: 60000, 
      burstCapacity: 5, 
      burstIntervalMs: 1000 
    });
    
    const r1 = await bp.consume("weighted:1", 3);
    assert.equal(r1.allowed, true);
    assert.equal(r1.concurrencyToken, undefined); // acquireConcurrency=false by default
    
    const r2 = await bp.consume("weighted:1", 3);
    assert.equal(r2.allowed, false);
    assert.equal(r2.reason, "burst_limit");
  });

  test("no double concurrency token on denial", async () => {
    const bp = createBurstProtector(client, { 
      sustainedLimit: 10, 
      sustainedIntervalMs: 10000, 
      burstCapacity: 1, 
      burstIntervalMs: 1000,
      concurrencyLimit: 1,
      concurrencyLeaseMs: 5000
    });
    
    const r1 = await bp.consume("nodouble:1", 1, true);
    assert.equal(r1.allowed, true);
    const token = r1.concurrencyToken!;
    
    const r2 = await bp.consume("nodouble:1", 1, true);
    assert.equal(r2.allowed, false);
    assert.equal(r2.reason, "burst_limit");
    
    // Token from r1 should still be valid, r2 didn't acquire concurrency
    await bp.releaseConcurrency(token);
  });

  test("multiple users independent burst limits", async () => {
    const bp = createBurstProtector(client, { 
      sustainedLimit: 2, 
      sustainedIntervalMs: 10000, 
      burstCapacity: 2, 
      burstIntervalMs: 1000 
    });
    
    await bp.consume("user:1", 2);
    const r = await bp.consume("user:2", 1);
    assert.equal(r.allowed, true);
  });

  test("fail-open on redis failure - sub-limiters handle it", async () => {
    const bp = createBurstProtector(client, { 
      sustainedLimit: 10, 
      sustainedIntervalMs: 10000, 
      burstCapacity: 5, 
      burstIntervalMs: 1000,
      failurePolicy: "fail-open"
    });
    
    await shutdown(client, silentLogger);
    const r = await bp.consume("fo:1", 1);
    // Sub-limiters handle fail-open, so burst protector gets fallback decisions
    assert.equal(r.allowed, true);
    // BurstDecision doesn't include fallback field; sub-limiters' fallback is in metadata
    assert.ok(r.metadata.sustained.fallback === true || r.metadata.burst.fallback === true);
  });

  test("burst protector metadata includes decisions", async () => {
    const bp = createBurstProtector(client, { 
      sustainedLimit: 10, 
      sustainedIntervalMs: 10000, 
      burstCapacity: 5, 
      burstIntervalMs: 1000 
    });
    
    const r = await bp.consume("meta:1", 1);
    assert.ok(r.metadata);
    assert.ok(r.metadata.sustained);
    assert.ok(r.metadata.burst);
    assert.equal(r.metadata.sustained.allowed, true);
    assert.equal(r.metadata.burst.allowed, true);
  });
});

describe("Retry-After Metadata", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("fixed-window retryAfterMs at boundary", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 200 });
    await limiter.consume("retry:1", 1);
    await new Promise(resolve => setTimeout(resolve, 250));
    const r = await limiter.consume("retry:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.retryAfterMs, null);
  });

  test("sliding-window retryAfterMs based on oldest event", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 2, intervalMs: 1000 });
    await limiter.consume("retry:1", 1);
    await limiter.consume("retry:1", 1);
    const r = await limiter.consume("retry:1", 1);
    assert.equal(r.allowed, false);
    assert.ok(r.retryAfterMs !== null && r.retryAfterMs > 0);
    assert.ok(r.retryAfterMs <= 1000);
  });

  test("token-bucket retryAfterMs for refill", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 1000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 10, initialTokens: 10 }
    });
    await limiter.consume("retry:1", 10);
    const r = await limiter.consume("retry:1", 5);
    assert.equal(r.allowed, false);
    assert.ok(r.retryAfterMs !== null && r.retryAfterMs > 0);
    assert.ok(r.retryAfterMs <= 500); // 5 tokens at 10/sec = 500ms
  });

  test("leaky-bucket retryAfterMs for leak", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 10,
      intervalMs: 1000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 10 }
    });
    await limiter.consume("retry:1", 10);
    const r = await limiter.consume("retry:1", 5);
    assert.equal(r.allowed, false);
    assert.ok(r.retryAfterMs !== null && r.retryAfterMs > 0);
    assert.ok(r.retryAfterMs <= 500);
  });

  test("quota retryAfterMs until period reset", async () => {
    const quota = createQuota(client, { resource: "retry", quota: 2, period: "custom", customPeriodMs: 1000 });
    await quota.consume("retry:1", 2);
    const r = await quota.consume("retry:1", 1);
    assert.equal(r.allowed, false);
    assert.ok(r.retryAfterMs !== null && r.retryAfterMs > 0);
    assert.ok(r.retryAfterMs <= 1000);
  });

  test("concurrency retryAfterMs is not provided (no time-based retry)", async () => {
    const limiter = createClient({ url: URL }, silentLogger);
    await limiter.flushdb();
    const concurrency = createConcurrencyLimiter(limiter, { resource: "retry", maxConcurrency: 1, leaseMs: 5000 });
    await concurrency.acquire("owner1");
    const r = await concurrency.tryAcquire("owner2");
    assert.equal(r.acquired, false);
    // Concurrency limiter's tryAcquire doesn't include retryAfterMs
    assert.ok(r.retryAfterMs === undefined || r.retryAfterMs === null);
    await shutdown(limiter, silentLogger);
  });

  test("retryAfterMs never negative", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 100 });
    await limiter.consume("neg:1", 1);
    const r = await limiter.consume("neg:1", 1);
    assert.equal(r.allowed, false);
    assert.ok(r.retryAfterMs !== null && r.retryAfterMs >= 0);
  });

  test("metadata includes algorithm identity", async () => {
    const algorithms: Array<"fixed-window" | "sliding-window" | "token-bucket" | "leaky-bucket"> = [
      "fixed-window", "sliding-window", "token-bucket", "leaky-bucket"
    ];
    
    for (const alg of algorithms) {
      await client.flushdb();
      const limiter = createRateLimiter(client, {
        algorithm: alg,
        limit: 10,
        intervalMs: 60000,
        ...(alg === "token-bucket" && { tokenBucket: { capacity: 10, refillRatePerSecond: 1, initialTokens: 10 } }),
        ...(alg === "leaky-bucket" && { leakyBucket: { capacity: 10, leakRatePerSecond: 1 } })
      });
      const r = await limiter.consume("alg:1", 1);
      assert.equal(r.algorithm, alg);
    }
  });

  test("metadata includes limit and remaining", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 5, intervalMs: 60000 });
    const r = await limiter.consume("meta:1", 2);
    assert.equal(r.limit, 5);
    assert.equal(r.remaining, 3);
    assert.equal(r.consumed, 2);
  });

  test("metadata includes denial reason", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 60000 });
    await limiter.consume("reason:1", 1);
    const r = await limiter.consume("reason:1", 1);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "limited");
  });

  test("metadata includes fallback indicator", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 1000, failurePolicy: "fail-open" });
    await shutdown(client, silentLogger);
    const r = await limiter.consume("fb:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.fallback, true);
  });
});