import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRateLimiter, createConcurrencyLimiter, createQuota, createMultiRateLimiter, shutdown, silentLogger } from "@oneunit/redis";

const URL = "redis://127.0.0.1:6379/9";

describe("Stress Testing: High Concurrency", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("fixed-window: 1000 concurrent requests - no over-consumption", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 100, intervalMs: 60000 });
    const concurrency = 1000;
    const cost = 1;
    
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => limiter.consume("stress:fw", cost))
    );
    
    const allowed = results.filter(r => r.allowed).length;
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    
    assert.equal(totalConsumed, allowed);
    assert.ok(totalConsumed <= 100, `Total consumed ${totalConsumed} should not exceed limit 100`);
    assert.equal(allowed, 100);
  });

  test("sliding-window: 1000 concurrent requests - no over-consumption", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 100, intervalMs: 60000 });
    const concurrency = 1000;
    const cost = 1;
    
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => limiter.consume("stress:sw", cost))
    );
    
    const allowed = results.filter(r => r.allowed).length;
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    
    assert.equal(totalConsumed, allowed);
    assert.ok(totalConsumed <= 100);
  });

  test("token-bucket: 1000 concurrent requests - no over-consumption", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 100,
      intervalMs: 60000,
      tokenBucket: { capacity: 100, refillRatePerSecond: 1, initialTokens: 100 }
    });
    const concurrency = 1000;
    const cost = 1;
    
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => limiter.consume("stress:tb", cost))
    );
    
    const allowed = results.filter(r => r.allowed).length;
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    
    assert.equal(totalConsumed, allowed);
    assert.ok(totalConsumed <= 100);
  });

  test("leaky-bucket: 1000 concurrent requests - no over-consumption", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 100,
      intervalMs: 60000,
      leakyBucket: { capacity: 100, leakRatePerSecond: 1 }
    });
    const concurrency = 1000;
    const cost = 1;
    
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => limiter.consume("stress:lb", cost))
    );
    
    const allowed = results.filter(r => r.allowed).length;
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    
    assert.equal(totalConsumed, allowed);
    assert.ok(totalConsumed <= 100);
  });

  test("quota: 1000 concurrent requests - no over-consumption", async () => {
    const quota = createQuota(client, { resource: "stress:q", quota: 100, period: "custom", customPeriodMs: 60000 });
    const concurrency = 1000;
    const amount = 1;
    
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => quota.consume("stress:q", amount))
    );
    
    const allowed = results.filter(r => r.allowed).length;
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    
    assert.equal(totalConsumed, allowed);
    assert.ok(totalConsumed <= 100);
  });

  test("concurrency: 1000 concurrent acquires - no over-subscription", async () => {
    const limiter = createConcurrencyLimiter(client, { resource: "stress:c", maxConcurrency: 50, leaseMs: 5000 });
    const concurrency = 1000;
    
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => limiter.tryAcquire())
    );
    
    const allowed = results.filter(r => r.acquired).length;
    assert.equal(allowed, 50, "Exactly 50 permits should be acquired");
  });

  test("multi-limiter: 1000 concurrent requests across 3 limiters", async () => {
    const l1 = createRateLimiter(client, { algorithm: "fixed-window", limit: 50, intervalMs: 60000, keyPrefix: "m1" });
    const l2 = createRateLimiter(client, { algorithm: "fixed-window", limit: 30, intervalMs: 60000, keyPrefix: "m2" });
    const l3 = createRateLimiter(client, { algorithm: "fixed-window", limit: 20, intervalMs: 60000, keyPrefix: "m3" });
    const multi = createMultiRateLimiter([l1, l2, l3]);
    
    const concurrency = 1000;
    
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => multi.consume("multi:1", 1))
    );
    
    const allowed = results.filter(r => r.allowed).length;
    // l3 (limit 20) is the bottleneck
    assert.equal(allowed, 20);
  });
});

describe("Stress Testing: Sustained Load", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("fixed-window: sustained requests at limit boundary", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 100, intervalMs: 1000 });
    const batches = 50;
    const perBatch = 2;
    
    let totalAllowed = 0;
    for (let i = 0; i < batches; i++) {
      const results = await Promise.all(
        Array.from({ length: perBatch }, () => limiter.consume("sustained:fw", 1))
      );
      totalAllowed += results.filter(r => r.allowed).length;
      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    
    assert.ok(totalAllowed <= 100, `Total allowed ${totalAllowed} should not exceed limit 100`);
  });

  test("sliding-window: sustained requests with event expiration", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 50, intervalMs: 100 });
    const batches = 20;
    const perBatch = 5;
    
    let totalAllowed = 0;
    for (let i = 0; i < batches; i++) {
      const results = await Promise.all(
        Array.from({ length: perBatch }, () => limiter.consume("sustained:sw", 1))
      );
      totalAllowed += results.filter(r => r.allowed).length;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    
    // With 100ms window and 20 batches at 20ms intervals, 
    // events from first batches should expire allowing more
    assert.ok(totalAllowed >= 50);
  });

  test("token-bucket: sustained requests with refill", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 100,
      intervalMs: 1000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 50, initialTokens: 10 }
    });
    
    // Initial burst
    let results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.consume("sustained:tb", 1))
    );
    let totalAllowed = results.filter(r => r.allowed).length;
    assert.equal(totalAllowed, 10);
    
    // Wait for refill
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // More requests should be allowed due to refill
    results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.consume("sustained:tb", 1))
    );
    totalAllowed += results.filter(r => r.allowed).length;
    
    assert.ok(totalAllowed > 10, "Should have refilled and allowed more");
  });

  test("leaky-bucket: sustained requests with leak", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 100,
      intervalMs: 1000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 50 }
    });
    
    // Fill the bucket
    let results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.consume("sustained:lb", 1))
    );
    let totalAllowed = results.filter(r => r.allowed).length;
    assert.equal(totalAllowed, 10);
    
    // Wait for leak
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // More requests should be allowed due to leak
    results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.consume("sustained:lb", 1))
    );
    totalAllowed += results.filter(r => r.allowed).length;
    
    assert.ok(totalAllowed > 10, "Should have leaked and allowed more");
  });
});

describe("Stress Testing: Mixed Workload", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("mixed read/write: check and consume interleaved", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 100, intervalMs: 60000 });
    const iterations = 500;
    
    const promises: Promise<any>[] = [];
    for (let i = 0; i < iterations; i++) {
      if (i % 2 === 0) {
        promises.push(limiter.check("mixed:1", 1));
      } else {
        promises.push(limiter.consume("mixed:1", 1));
      }
    }
    
    const results = await Promise.all(promises);
    const _allowed = results.filter(r => r.allowed).length;
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + (r.consumed || 0), 0);
    
    assert.ok(totalConsumed <= 100);
  });

  test("weighted mixed: varying costs", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 100, intervalMs: 60000 });
    const iterations = 200;
    
    const promises: Promise<any>[] = [];
    for (let i = 0; i < iterations; i++) {
      const cost = (i % 3) + 1; // Costs 1, 2, 3
      promises.push(limiter.consume("weighted:1", cost));
    }
    
    const results = await Promise.all(promises);
    const allowed = results.filter(r => r.allowed).length;
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    
    assert.ok(totalConsumed <= 100);
    // Each allowed request has cost >= 1, so allowed <= totalConsumed
    assert.ok(allowed <= totalConsumed);
  });

  test("burst protector: sustained + burst + concurrency under load", async () => {
    const { createBurstProtector } = await import("../../dist/index.js");
    const bp = createBurstProtector(client, { 
      sustainedLimit: 50, 
      sustainedIntervalMs: 60000, 
      burstCapacity: 10, 
      burstIntervalMs: 1000,
      concurrencyLimit: 5,
      concurrencyLeaseMs: 5000
    });
    
    const iterations = 100;
    let totalAllowed = 0;
    
    for (let i = 0; i < iterations; i++) {
      const r = await bp.consume("burst:1", 1, true);
      if (r.allowed) totalAllowed++;
      // Release concurrency token if acquired
      if (r.concurrencyToken) {
        await bp.releaseConcurrency(r.concurrencyToken);
      }
    }
    
    assert.ok(totalAllowed <= 50, "Should not exceed sustained limit");
  });
});

describe("Race Condition Testing", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("race: check-then-consume pattern not atomic across limiters", async () => {
    const l1 = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 60000, keyPrefix: "race" });
    const l2 = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "race" });
    const multi = createMultiRateLimiter([l1, l2]);
    
    // Exhaust l1
    await l1.consume("race:1", 1);
    
    // Now concurrent check+consume - both check pass for l2 but l1 denies
    // This demonstrates the race window
    const results = await Promise.all([
      (async () => { 
        const c = await multi.check("race:1", 1);
        if (c.allowed) return await multi.consume("race:1", 1);
        return c;
      })(),
      (async () => { 
        const c = await multi.check("race:1", 1);
        if (c.allowed) return await multi.consume("race:1", 1);
        return c;
      })(),
    ]);
    
    // Both should be denied because l1 is exhausted
    const denied = results.filter(r => !r.allowed).length;
    assert.equal(denied, 2);
  });

  test("race: concurrent semaphore acquire and release", async () => {
    const limiter = createConcurrencyLimiter(client, { resource: "race:c", maxConcurrency: 2, leaseMs: 5000 });
    
    // Acquire 2
    const acq1 = await limiter.acquire("owner1");
    await limiter.acquire("owner2");
    
    // Release owner1 and try to acquire owner3 concurrently
    // Owner1's release should free a permit for owner3's acquire
    const results = await Promise.all([
      limiter.release(acq1.token!),
      limiter.tryAcquire("owner3"),
    ]);
    
    // The tryAcquire should succeed because owner1's release freed a permit
    const releaseResult = results[0];
    const tryAcquireResult = results[1];
    assert.equal(releaseResult.released, true);
    assert.equal(tryAcquireResult.acquired, true);
  });
});

describe("Invariant Verification", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("invariant: remaining never negative", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000 });
    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter.consume("inv:1", 1))
    );
    
    for (const r of results) {
      assert.ok(r.remaining >= 0, `Remaining should never be negative, got ${r.remaining}`);
    }
  });

  test("invariant: consumed never exceeds limit", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000 });
    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter.consume("inv:2", 1))
    );
    
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    assert.ok(totalConsumed <= 10);
  });

  test("invariant: denied requests never consume", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 5, intervalMs: 60000 });
    
    // Consume 5
    await Promise.all(Array.from({ length: 5 }, () => limiter.consume("inv:3", 1)));
    
    // Next 10 should all be denied
    const results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.consume("inv:3", 1))
    );
    
    for (const r of results) {
      assert.equal(r.allowed, false);
      assert.equal(r.consumed, 0);
    }
    
    // Verify actual state
    const check = await limiter.check("inv:3", 1);
    assert.equal(check.remaining, 0);
  });

  test("invariant: token bucket never exceeds capacity", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 100,
      intervalMs: 60000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 100, initialTokens: 10 }
    });
    
    // Drain
    await limiter.consume("inv:tb", 10);
    
    // Wait for refill
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Check remaining never exceeds capacity
    const check = await limiter.check("inv:tb", 1);
    assert.ok(check.remaining <= 10);
  });

  test("invariant: leaky bucket water level never negative", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 100,
      intervalMs: 60000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 100 }
    });
    
    // Fill
    await limiter.consume("inv:lb", 10);
    
    // Wait for full leak
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Check remaining never exceeds capacity
    const check = await limiter.check("inv:lb", 1);
    assert.ok(check.remaining <= 10);
    assert.ok(check.remaining >= 0);
  });

  test("invariant: quota never exceeded", async () => {
    const quota = createQuota(client, { resource: "inv:q", quota: 20, period: "custom", customPeriodMs: 60000 });
    
    const results = await Promise.all(
      Array.from({ length: 100 }, () => quota.consume("inv:q", 1))
    );
    
    const _allowed = results.filter(r => r.allowed).length;
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    
    assert.ok(totalConsumed <= 20);
  });

  test("invariant: concurrency permits never exceed maxConcurrency", async () => {
    const limiter = createConcurrencyLimiter(client, { resource: "inv:c", maxConcurrency: 5, leaseMs: 5000 });
    
    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter.tryAcquire())
    );
    
    const allowed = results.filter(r => r.acquired).length;
    assert.equal(allowed, 5);
  });
});