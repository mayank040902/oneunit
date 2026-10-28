import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRateLimiter, shutdown, silentLogger } from "@oneunit/redis";

const URL = "redis://127.0.0.1:6379/9";

describe("Leaky-Bucket Rate Limiter (Policing)", () => {
  let client: Awaited<ReturnType<typeof createClient>>;
  let limiter: ReturnType<typeof createRateLimiter>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 10,
      intervalMs: 60000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 10 }
    });
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("admission threshold - first request allowed", async () => {
    const r = await limiter.consume("user:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 9);
    assert.equal(r.consumed, 1);
  });

  test("admission threshold - up to capacity", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await limiter.consume("user:1", 1);
      assert.equal(r.allowed, true, `Request ${i + 1} should be allowed`);
    }
  });

  test("admission threshold - at capacity denied", async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.consume("user:1", 1);
    }
    const r = await limiter.consume("user:1", 1);
    assert.equal(r.allowed, false);
    assert.equal(r.remaining, 0);
    assert.equal(r.reason, "limited");
  });

  test("leak rate behavior - water level drops over time", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 5,
      intervalMs: 1000,
      leakyBucket: { capacity: 5, leakRatePerSecond: 5 }
    });
    await limiter.consume("leak:1", 5);
    const r1 = await limiter.consume("leak:1", 1);
    assert.equal(r1.allowed, false);
    await new Promise(resolve => setTimeout(resolve, 300));
    const r2 = await limiter.consume("leak:1", 1);
    assert.equal(r2.allowed, true, "Should have leaked ~1.5 capacity");
  });

  test("weighted costs add to water level", async () => {
    await limiter.consume("weighted:1", 3);
    const r = await limiter.consume("weighted:1", 4);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 3);
  });

  test("cost exceeds capacity denied immediately", async () => {
    const r = await limiter.consume("large:1", 15);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "cost_exceeds_capacity");
  });

  test("check mode does not add water - shows current capacity", async () => {
    await limiter.consume("check:1", 5);
    const check = await limiter.check("check:1", 2);
    assert.equal(check.allowed, true);
    assert.equal(check.remaining, 5); // capacity 10 - water 5 = 5
    assert.equal(check.consumed, 0);
    const after = await limiter.consume("check:1", 2);
    assert.equal(after.allowed, true);
    assert.equal(after.remaining, 3); // capacity 10 - water 7 = 3
  });

  test("reset clears water level - check shows full capacity", async () => {
    await limiter.consume("user:1", 5);
    await limiter.reset("user:1");
    const r = await limiter.check("user:1", 10);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 10); // capacity 10 - water 0 = 10
  });

  test("zero cost rejected", async () => {
    await assert.rejects(() => limiter.consume("user:1", 0), /weight must be/);
  });

  test("negative cost rejected", async () => {
    await assert.rejects(() => limiter.consume("user:1", -1), /weight must be/);
  });
});

describe("Leaky-Bucket: Concurrent Decisions", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("concurrent requests - no more than capacity admitted", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 10,
      intervalMs: 60000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 1 }
    });
    const results = await Promise.all(
      Array.from({ length: 15 }, () => limiter.consume("concurrent:1", 1))
    );
    const allowed = results.filter(r => r.allowed).length;
    assert.equal(allowed, 10, "Exactly 10 requests should be allowed");
  });

  test("concurrent weighted requests - atomic", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 10,
      intervalMs: 60000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 1 }
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => limiter.consume("concurrent:2", i % 2 === 0 ? 1 : 2))
    );
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    assert.ok(totalConsumed <= 10, `Total consumed ${totalConsumed} should not exceed capacity 10`);
  });
});

describe("Leaky-Bucket: Leak Dynamics", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("water level cannot go below zero", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 5,
      intervalMs: 1000,
      leakyBucket: { capacity: 5, leakRatePerSecond: 10 }
    });
    await limiter.consume("negative:1", 5);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const r = await limiter.consume("negative:1", 5);
    assert.equal(r.allowed, true, "Water should not go negative, allowing full capacity");
    assert.equal(r.remaining, 0);
  });

  test("leak rate respected over time", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 10,
      intervalMs: 1000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 2 }
    });
    await limiter.consume("leakrate:1", 10);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const r = await limiter.consume("leakrate:1", 4);
    assert.equal(r.allowed, true, "Should have leaked ~4 capacity");
  });

  test("partial leak allows partial consumption - denied when insufficient capacity", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 10,
      intervalMs: 1000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 5 }
    });
    await limiter.consume("partial:1", 10);
    await new Promise(resolve => setTimeout(resolve, 500));
    const r = await limiter.consume("partial:1", 3);
    assert.equal(r.allowed, false, "Should have leaked ~2.5, only 2.5 capacity remains, 3 denied");
    // After more time, should allow
    await new Promise(resolve => setTimeout(resolve, 600));
    const r2 = await limiter.consume("partial:1", 3);
    assert.equal(r2.allowed, true, "After ~1.1s total, ~5.5 leaked, 3 allowed");
  });
});

describe("Leaky-Bucket: TTL and Expiration", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("TTL is set to 24 hours (86400 seconds)", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 5,
      intervalMs: 5000,
      leakyBucket: { capacity: 5, leakRatePerSecond: 1 }
    });
    await limiter.consume("ttl:test", 1);
    const key = (limiter as any).key("ttl:test");
    const ttl = await client.pttl(key);
    assert.ok(ttl > 0 && ttl <= 86400000, `TTL should be positive and <= 24h, got ${ttl}`);
  });

  test("key persists - water level maintained across requests", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 2,
      intervalMs: 100,
      leakyBucket: { capacity: 2, leakRatePerSecond: 1 }
    });
    await limiter.consume("persist:1", 2);
    await new Promise(resolve => setTimeout(resolve, 150));
    const r = await limiter.consume("persist:1", 1);
    assert.equal(r.allowed, false, "Water level should persist (key has 24h TTL)");
  });
});

describe("Leaky-Bucket: Multiple Application Instances", () => {
  let client1: Awaited<ReturnType<typeof createClient>>;
  let client2: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client1 = createClient({ url: URL }, silentLogger);
    client2 = createClient({ url: URL }, silentLogger);
    await client1.flushdb();
  });

  afterEach(async () => {
    await client1.flushdb().catch(() => {});
    await shutdown(client1, silentLogger);
    await shutdown(client2, silentLogger);
  });

  test("two clients share same bucket state", async () => {
    const limiter1 = createRateLimiter(client1, {
      algorithm: "leaky-bucket",
      limit: 5,
      intervalMs: 60000,
      leakyBucket: { capacity: 5, leakRatePerSecond: 1 }
    });
    const limiter2 = createRateLimiter(client2, {
      algorithm: "leaky-bucket",
      limit: 5,
      intervalMs: 60000,
      leakyBucket: { capacity: 5, leakRatePerSecond: 1 }
    });
    await limiter1.consume("shared:1", 3);
    const r = await limiter2.consume("shared:1", 3);
    assert.equal(r.allowed, false, "Should see water added by other client");
  });

  test("concurrent consumption from two clients", async () => {
    const limiter1 = createRateLimiter(client1, {
      algorithm: "leaky-bucket",
      limit: 10,
      intervalMs: 60000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 1 }
    });
    const limiter2 = createRateLimiter(client2, {
      algorithm: "leaky-bucket",
      limit: 10,
      intervalMs: 60000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 1 }
    });
    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => limiter1.consume("shared:2", 1)),
      ...Array.from({ length: 10 }, () => limiter2.consume("shared:2", 1)),
    ]);
    const allowed = results.filter(r => r.allowed).length;
    assert.equal(allowed, 10, "Total allowed should not exceed capacity");
  });
});

describe("Leaky-Bucket: Retry-After Accuracy", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("retryAfterMs reflects time to leak needed capacity", async () => {
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
    assert.ok(r.retryAfterMs <= 500, "Should leak 5 at 10/sec = 500ms");
  });

  test("retryAfterMs decreases as water leaks", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 10,
      intervalMs: 1000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 10 }
    });
    await limiter.consume("retry:2", 10);
    const r1 = await limiter.consume("retry:2", 5);
    const firstRetry = r1.retryAfterMs!;
    await new Promise(resolve => setTimeout(resolve, 100));
    const r2 = await limiter.consume("retry:2", 5);
    const secondRetry = r2.retryAfterMs!;
    assert.ok(secondRetry < firstRetry, "Retry should decrease as water leaks");
  });
});

describe("Leaky-Bucket: Documentation - Policing Not Shaping", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("no queue - denied requests return immediately", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 1,
      intervalMs: 1000,
      leakyBucket: { capacity: 1, leakRatePerSecond: 1 }
    });
    await limiter.consume("queue:1", 1);
    const start = Date.now();
    const r = await limiter.consume("queue:1", 1);
    const elapsed = Date.now() - start;
    assert.equal(r.allowed, false);
    assert.ok(elapsed < 50, "Denied request should return immediately (no queue delay)");
  });

  test("no wait timeout - not a shaping queue", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 1,
      intervalMs: 1000,
      leakyBucket: { capacity: 1, leakRatePerSecond: 1 }
    });
    await limiter.consume("notqueue:1", 1);
    const r = await limiter.consume("notqueue:1", 1);
    assert.ok(r.retryAfterMs !== null, "Returns retry hint but does not wait");
  });
});

describe("Leaky-Bucket: Metadata", () => {
  let client: Awaited<ReturnType<typeof createClient>>;
  let limiter: ReturnType<typeof createRateLimiter>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 10,
      intervalMs: 60000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 1 }
    });
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("limit equals capacity", async () => {
    const limiter2 = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 10,
      intervalMs: 60000,
      leakyBucket: { capacity: 15, leakRatePerSecond: 1 }
    });
    const r = await limiter2.check("meta:1", 1);
    assert.equal(r.limit, 15);
  });

  test("algorithm identity is leaky-bucket", async () => {
    const r = await limiter.check("meta:1", 1);
    assert.equal(r.algorithm, "leaky-bucket");
  });

  test("resetAt and resetAfterMs are null (no fixed window)", async () => {
    const r = await limiter.check("meta:1", 1);
    assert.equal(r.resetAt, null);
    assert.equal(r.resetAfterMs, null);
  });
});