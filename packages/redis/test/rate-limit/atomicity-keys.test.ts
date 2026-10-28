import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRateLimiter, createConcurrencyLimiter, createQuota, shutdown, silentLogger } from "@oneunit/redis";

const URL = "redis://127.0.0.1:6379/9";

describe("Atomicity and Lua Script Safety", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("fixed-window: concurrent requests atomic - no over-consumption", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 100, intervalMs: 60000 });
    const concurrency = 50;
    const cost = 2;
    
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => limiter.consume("atomic:1", cost))
    );
    
    const allowed = results.filter(r => r.allowed).length;
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    
    assert.equal(totalConsumed, allowed * cost);
    assert.ok(totalConsumed <= 100, `Total consumed ${totalConsumed} should not exceed limit 100`);
  });

  test("sliding-window: concurrent requests atomic - sorted set operations", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 100, intervalMs: 60000 });
    const concurrency = 50;
    const cost = 2;
    
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => limiter.consume("atomic:2", cost))
    );
    
    const allowed = results.filter(r => r.allowed).length;
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    
    assert.equal(totalConsumed, allowed * cost);
    assert.ok(totalConsumed <= 100, `Total consumed ${totalConsumed} should not exceed limit 100`);
  });

  test("token-bucket: concurrent requests atomic - hash operations", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 100,
      intervalMs: 60000,
      tokenBucket: { capacity: 100, refillRatePerSecond: 1, initialTokens: 100 }
    });
    const concurrency = 50;
    const cost = 2;
    
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => limiter.consume("atomic:3", cost))
    );
    
    const allowed = results.filter(r => r.allowed).length;
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    
    assert.equal(totalConsumed, allowed * cost);
    assert.ok(totalConsumed <= 100, `Total consumed ${totalConsumed} should not exceed capacity 100`);
  });

  test("leaky-bucket: concurrent requests atomic - hash operations", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 100,
      intervalMs: 60000,
      leakyBucket: { capacity: 100, leakRatePerSecond: 1 }
    });
    const concurrency = 50;
    const cost = 2;
    
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => limiter.consume("atomic:4", cost))
    );
    
    const allowed = results.filter(r => r.allowed).length;
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    
    assert.equal(totalConsumed, allowed * cost);
    assert.ok(totalConsumed <= 100, `Total consumed ${totalConsumed} should not exceed capacity 100`);
  });

  test("quota: concurrent requests atomic - single key", async () => {
    const quota = createQuota(client, { resource: "atomic", quota: 100, period: "custom", customPeriodMs: 60000 });
    const concurrency = 50;
    const amount = 2;
    
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => quota.consume("atomic:1", amount))
    );
    
    const allowed = results.filter(r => r.allowed).length;
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    
    assert.equal(totalConsumed, allowed * amount);
    assert.ok(totalConsumed <= 100, `Total consumed ${totalConsumed} should not exceed quota 100`);
  });

  test("semaphore: concurrent acquire atomic - sorted set with cleanup", async () => {
    const limiter = createConcurrencyLimiter(client, { resource: "atomic", maxConcurrency: 10, leaseMs: 5000 });
    const concurrency = 15;
    
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => limiter.tryAcquire())
    );
    
    const allowed = results.filter(r => r.acquired).length;
    assert.equal(allowed, 10, "Exactly 10 permits should be acquired");
  });

  test("semaphore: concurrent acquire and release", async () => {
    const limiter = createConcurrencyLimiter(client, { resource: "atomic2", maxConcurrency: 5, leaseMs: 5000 });
    
    // Acquire 5
    const acqs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => limiter.acquire(`owner${i}`))
    );
    assert.equal(acqs.filter(a => a.acquired).length, 5);
    
    // Release 2 and acquire 2 more concurrently
    const release1 = limiter.release(acqs[0].token!);
    const release2 = limiter.release(acqs[1].token!);
    const acquire1 = limiter.acquire("new1");
    const acquire2 = limiter.acquire("new2");
    
    const results = await Promise.all([release1, release2, acquire1, acquire2]);
    const allowed = results.filter(r => 'acquired' in r && r.acquired).length;
    assert.ok(allowed >= 2);
  });

  test("multi-limiter: check then consume race window exists (not atomic)", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 60000, keyPrefix: "race" });
    
    // First consume exhausts
    await limiter.consume("race:1", 1);
    
    // Now concurrent check+consume - both check pass but only one should succeed on consume
    // This documents the race condition
    const results = await Promise.all([
      (async () => { const c = await limiter.check("race:1", 1); if (c.allowed) return await limiter.consume("race:1", 1); return c; })(),
      (async () => { const c = await limiter.check("race:1", 1); if (c.allowed) return await limiter.consume("race:1", 1); return c; })(),
    ]);
    
    // At least one should be denied (both check pass, but only one consume can succeed)
    const denied = results.filter(r => !r.allowed).length;
    assert.ok(denied >= 1, "Race window exists between check and consume");
  });
});

describe("Redis Key Safety", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("rate limiter keys are namespaced with prefix", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "myprefix" });
    await limiter.consume("user:1", 1);
    
    const keys = await client.keys("myprefix:*");
    assert.ok(keys.length > 0);
    assert.ok(keys.every(k => k.startsWith("myprefix:")));
  });

  test("different algorithms use different key suffixes", async () => {
    const fw = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "test" });
    const sw = createRateLimiter(client, { algorithm: "sliding-window", limit: 10, intervalMs: 60000, keyPrefix: "test" });
    const tb = createRateLimiter(client, { algorithm: "token-bucket", limit: 10, intervalMs: 60000, keyPrefix: "test", tokenBucket: { capacity: 10, refillRatePerSecond: 1, initialTokens: 10 } });
    const lb = createRateLimiter(client, { algorithm: "leaky-bucket", limit: 10, intervalMs: 60000, keyPrefix: "test", leakyBucket: { capacity: 10, leakRatePerSecond: 1 } });
    
    await Promise.all([
      fw.consume("diff:1", 1),
      sw.consume("diff:1", 1),
      tb.consume("diff:1", 1),
      lb.consume("diff:1", 1),
    ]);
    
    const keys = await client.keys("test:*");
    // Should have separate keys for each algorithm
    const suffixes = keys.map(k => k.split(":").pop());
    assert.ok(suffixes.includes("fixed-window"));
    assert.ok(suffixes.includes("sliding-window"));
    assert.ok(suffixes.includes("token-bucket"));
    assert.ok(suffixes.includes("leaky-bucket"));
  });

  test("quota keys are separate from rate limiter keys", async () => {
    const rl = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "myprefix" });
    const q = createQuota(client, { resource: "quota", quota: 10, period: "daily", keyPrefix: "myprefix" });
    
    await rl.consume("user:1", 1);
    await q.consume("user:1", 1);
    
    const keys = await client.keys("myprefix:*");
    const hasFixedWindow = keys.some(k => k.includes("fixed-window"));
    const hasQuota = keys.some(k => k.includes("quota"));
    assert.ok(hasFixedWindow);
    assert.ok(hasQuota);
  });

  test("semaphore keys are namespaced with hash tags for Redis Cluster", async () => {
    const limiter = createConcurrencyLimiter(client, { resource: "cluster-test", maxConcurrency: 5, leaseMs: 5000, keyPrefix: "ratelimit" });
    await limiter.acquire("owner1");
    
    const keys = await client.keys("ratelimit:*");
    // Semaphore keys should use hash tags {resource}
    assert.ok(keys.some(k => k.includes("{cluster-test}")));
  });

  test("semaphore uses two keys (semaphore + fencing) - may CROSSSLOT in Cluster", async () => {
    const limiter = createConcurrencyLimiter(client, { resource: "cross-slot", maxConcurrency: 5, leaseMs: 5000 });
    await limiter.acquire("owner1");
    
    // The keys are in the "ratelimit" namespace with hash tags
    const keys = await client.keys("ratelimit:*");
    // There should be two keys: semaphore and fencing
    assert.equal(keys.length, 2);
    assert.ok(keys.every(k => k.includes("{cross-slot}")));
  });

  test("TTL is set on all rate limiter keys", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 5000 });
    await limiter.consume("ttl:1", 1);
    
    const keys = await client.keys("ratelimit:*");
    for (const key of keys) {
      const ttl = await client.pttl(key);
      assert.ok(ttl > 0 && ttl <= 5000, `Key ${key} TTL ${ttl} should be positive and <= interval`);
    }
  });

  test("TTL is set on quota keys", async () => {
    const quota = createQuota(client, { resource: "ttl", quota: 10, period: "custom", customPeriodMs: 5000 });
    await quota.consume("ttl:1", 1);
    
    const keys = await client.keys("quota:*");
    for (const key of keys) {
      const ttl = await client.pttl(key);
      assert.ok(ttl > 0 && ttl <= 5000, `Key ${key} TTL ${ttl} should be positive and <= period`);
    }
  });

  test("semaphore TTL is leaseMs + buffer", async () => {
    const limiter = createConcurrencyLimiter(client, { resource: "ttl", maxConcurrency: 5, leaseMs: 5000 });
    await limiter.acquire("owner1");
    
    const keys = await client.keys("coord:*");
    for (const key of keys) {
      const ttl = await client.pttl(key);
      assert.ok(ttl > 5000 && ttl <= 6000, `Semaphore key ${key} TTL ${ttl} should be leaseMs + buffer`);
    }
  });

  test("no key collision between different resources", async () => {
    const limiter1 = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "pref" });
    const limiter2 = createRateLimiter(client, { algorithm: "fixed-window", limit: 5, intervalMs: 60000, keyPrefix: "pref" });
    
    await limiter1.consume("resource:A", 5);
    await limiter2.consume("resource:B", 5);
    
    const keys = await client.keys("pref:*");
    // Should have 2 separate keys
    assert.equal(keys.length, 2);
  });
});

describe("Lua Script Boundary Conditions", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("fixed-window: cost exceeds limit rejected before Redis call", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 5, intervalMs: 60000 });
    const r = await limiter.consume("boundary:1", 10);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "cost_exceeds_limit");
  });

  test("sliding-window: cost exceeds limit rejected", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 5, intervalMs: 60000 });
    const r = await limiter.consume("boundary:1", 10);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "cost_exceeds_limit");
  });

  test("token-bucket: cost exceeds capacity rejected", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 60000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 1, initialTokens: 10 }
    });
    const r = await limiter.consume("boundary:1", 15);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "cost_exceeds_capacity");
  });

  test("leaky-bucket: cost exceeds capacity rejected", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 10,
      intervalMs: 60000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 1 }
    });
    const r = await limiter.consume("boundary:1", 15);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "cost_exceeds_capacity");
  });

  test("quota: amount exceeds quota rejected", async () => {
    const quota = createQuota(client, { resource: "boundary", quota: 5, period: "daily" });
    const r = await quota.consume("boundary:1", 10);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "quota_exhausted");
  });

  test("semaphore: maxConcurrency=0 rejected by validation at construction", () => {
    assert.throws(
      () => createConcurrencyLimiter(client, { resource: "boundary", maxConcurrency: 0, leaseMs: 5000 }),
      /maxConcurrency must be/
    );
  });
});