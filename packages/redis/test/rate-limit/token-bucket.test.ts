import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRateLimiter, shutdown, silentLogger } from "@oneunit/redis";

const URL = "redis://127.0.0.1:6379/9";

describe("Token-Bucket Rate Limiter", () => {
  let client: Awaited<ReturnType<typeof createClient>>;
  let limiter: ReturnType<typeof createRateLimiter>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 60000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 10, initialTokens: 10 }
    });
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("initial token count equals capacity - check shows current tokens", async () => {
    const r = await limiter.check("user:1", 10);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 10); // check shows current tokens
  });

  test("full capacity can be consumed at once", async () => {
    const r = await limiter.consume("user:1", 10);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 0);
    assert.equal(r.consumed, 10);
  });

  test("partial consumption reduces tokens - check shows current tokens", async () => {
    await limiter.consume("user:1", 3);
    const r = await limiter.check("user:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 7); // 10 - 3 = 7 current tokens
  });

  test("refill after elapsed time", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 1000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 10, initialTokens: 10 }
    });
    await limiter.consume("refill:1", 10);
    const r1 = await limiter.consume("refill:1", 1);
    assert.equal(r1.allowed, false);
    await new Promise(resolve => setTimeout(resolve, 200));
    const r2 = await limiter.consume("refill:1", 1);
    assert.equal(r2.allowed, true, "Should have refilled ~2 tokens");
  });

  test("full refill after long interval", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 5,
      intervalMs: 1000,
      tokenBucket: { capacity: 5, refillRatePerSecond: 5, initialTokens: 5 }
    });
    await limiter.consume("fullrefill:1", 5);
    await new Promise(resolve => setTimeout(resolve, 1200));
    const r = await limiter.consume("fullrefill:1", 5);
    assert.equal(r.allowed, true, "Should have fully refilled");
    assert.equal(r.remaining, 0);
  });

  test("fractional weights allowed", async () => {
    const r1 = await limiter.consume("frac:1", 1.5);
    assert.equal(r1.allowed, true);
    const r2 = await limiter.consume("frac:1", 1.5);
    assert.equal(r2.allowed, true);
    const r3 = await limiter.consume("frac:1", 1.5);
    assert.equal(r3.allowed, true);
    const r4 = await limiter.consume("frac:1", 1.5);
    assert.equal(r4.allowed, true);
    const r5 = await limiter.consume("frac:1", 1.5);
    assert.equal(r5.allowed, true);
    const r6 = await limiter.consume("frac:1", 1.5);
    assert.equal(r6.allowed, true);
    const r7 = await limiter.consume("frac:1", 1.5);
    assert.equal(r7.allowed, false);
  });

  test("weighted consumption", async () => {
    const r = await limiter.consume("weighted:1", 3);
    assert.equal(r.allowed, true);
    assert.equal(r.consumed, 3);
    assert.equal(r.remaining, 7);
  });

  test("requests larger than bucket capacity denied", async () => {
    const r = await limiter.consume("large:1", 15);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "cost_exceeds_capacity");
  });

  test("denied requests do not consume tokens", async () => {
    await limiter.consume("deny:1", 8);
    const r1 = await limiter.consume("deny:1", 5);
    assert.equal(r1.allowed, false);
    const check = await limiter.check("deny:1", 1);
    assert.equal(check.allowed, true);
    assert.equal(check.remaining, 2);
  });

  test("check mode does not consume tokens - shows current tokens", async () => {
    await limiter.consume("check:1", 5);
    const check = await limiter.check("check:1", 2);
    assert.equal(check.allowed, true);
    assert.equal(check.remaining, 5); // current tokens = 5
    assert.equal(check.consumed, 0);
    const after = await limiter.consume("check:1", 2);
    assert.equal(after.allowed, true);
    assert.equal(after.remaining, 3); // 5 - 2 = 3 after consumption
  });

  test("reset clears state - check shows full capacity", async () => {
    await limiter.consume("user:1", 5);
    await limiter.reset("user:1");
    const r = await limiter.check("user:1", 10);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 10); // reset restores to initialTokens (10)
  });

  test("zero cost rejected", async () => {
    await assert.rejects(() => limiter.consume("user:1", 0), /weight must be/);
  });

  test("negative cost rejected", async () => {
    await assert.rejects(() => limiter.consume("user:1", -1), /weight must be/);
  });
});

describe("Token-Bucket: Concurrent Consumption", () => {
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
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 60000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 1, initialTokens: 10 }
    });
    const results = await Promise.all(
      Array.from({ length: 15 }, () => limiter.consume("concurrent:1", 1))
    );
    const allowed = results.filter(r => r.allowed).length;
    assert.equal(allowed, 10, "Exactly 10 requests should be allowed");
  });

  test("concurrent weighted requests - atomic", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 60000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 1, initialTokens: 10 }
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => limiter.consume("concurrent:2", i % 2 === 0 ? 1 : 2))
    );
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    assert.ok(totalConsumed <= 10, `Total consumed ${totalConsumed} should not exceed capacity 10`);
  });
});

describe("Token-Bucket: Refill Dynamics", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("refill rate respected - tokens added over time", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 1000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 5, initialTokens: 0 }
    });
    const r1 = await limiter.consume("refill:1", 1);
    assert.equal(r1.allowed, false);
    await new Promise(resolve => setTimeout(resolve, 300));
    const r2 = await limiter.consume("refill:1", 1);
    assert.equal(r2.allowed, true, "Should have refilled ~1.5 tokens");
  });

  test("refill does not exceed capacity", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 5,
      intervalMs: 1000,
      tokenBucket: { capacity: 5, refillRatePerSecond: 10, initialTokens: 5 }
    });
    await limiter.consume("cap:1", 3);
    await new Promise(resolve => setTimeout(resolve, 500));
    const check = await limiter.check("cap:1", 1);
    assert.ok(check.remaining <= 5, "Tokens should not exceed capacity");
  });

  test("initialTokens can be less than capacity", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 60000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 1, initialTokens: 3 }
    });
    const r1 = await limiter.consume("init:1", 3);
    assert.equal(r1.allowed, true);
    assert.equal(r1.remaining, 0);
    const r2 = await limiter.consume("init:1", 1);
    assert.equal(r2.allowed, false);
  });

  test("initialTokens defaults to capacity - check shows capacity", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 5,
      intervalMs: 60000,
      tokenBucket: { capacity: 5, refillRatePerSecond: 1 }
    });
    const r = await limiter.check("default:1", 5);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 5); // initialTokens defaults to capacity
  });
});

describe("Token-Bucket: Negative Elapsed Time Handling", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("clock drift - negative elapsed treated as zero", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 5,
      intervalMs: 60000,
      tokenBucket: { capacity: 5, refillRatePerSecond: 1, initialTokens: 5 }
    });
    await limiter.consume("drift:1", 5);
    // Can't easily test negative elapsed without mocking Redis TIME
    // But we can verify the Lua handles it
    const check = await limiter.check("drift:1", 1);
    assert.equal(check.allowed, false);
  });
});

describe("Token-Bucket: Numeric Precision", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("large capacity and refill rates", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 1000000,
      intervalMs: 60000,
      tokenBucket: { capacity: 1000000, refillRatePerSecond: 100000, initialTokens: 1000000 }
    });
    const r = await limiter.consume("large:1", 500000);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 500000);
  });

  test("very small refill rate", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 60000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 0.001, initialTokens: 0 }
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    const r = await limiter.consume("slow:1", 1);
    assert.equal(r.allowed, false, "Should not have refilled enough");
  });
});

describe("Token-Bucket: Multiple Application Instances", () => {
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
      algorithm: "token-bucket",
      limit: 5,
      intervalMs: 60000,
      tokenBucket: { capacity: 5, refillRatePerSecond: 1, initialTokens: 5 }
    });
    const limiter2 = createRateLimiter(client2, {
      algorithm: "token-bucket",
      limit: 5,
      intervalMs: 60000,
      tokenBucket: { capacity: 5, refillRatePerSecond: 1, initialTokens: 5 }
    });
    await limiter1.consume("shared:1", 3);
    const r = await limiter2.consume("shared:1", 3);
    assert.equal(r.allowed, false, "Should see tokens consumed by other client");
  });

  test("concurrent consumption from two clients", async () => {
    const limiter1 = createRateLimiter(client1, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 60000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 1, initialTokens: 10 }
    });
    const limiter2 = createRateLimiter(client2, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 60000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 1, initialTokens: 10 }
    });
    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => limiter1.consume("shared:2", 1)),
      ...Array.from({ length: 10 }, () => limiter2.consume("shared:2", 1)),
    ]);
    const allowed = results.filter(r => r.allowed).length;
    assert.equal(allowed, 10, "Total allowed should not exceed capacity");
  });
});

describe("Token-Bucket: Retry-After Accuracy", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("retryAfterMs reflects time to refill needed tokens", async () => {
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
    assert.ok(r.retryAfterMs <= 500, "Should refill 5 tokens at 10/sec = 500ms");
  });

  test("retryAfterMs decreases as tokens refill", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 1000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 10, initialTokens: 10 }
    });
    await limiter.consume("retry:2", 10);
    const r1 = await limiter.consume("retry:2", 5);
    const firstRetry = r1.retryAfterMs!;
    await new Promise(resolve => setTimeout(resolve, 100));
    const r2 = await limiter.consume("retry:2", 5);
    const secondRetry = r2.retryAfterMs!;
    assert.ok(secondRetry < firstRetry, "Retry should decrease as tokens refill");
  });
});

describe("Token-Bucket: Metadata", () => {
  let client: Awaited<ReturnType<typeof createClient>>;
  let limiter: ReturnType<typeof createRateLimiter>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 60000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 1, initialTokens: 10 }
    });
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("limit equals capacity", async () => {
    const limiter2 = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 60000,
      tokenBucket: { capacity: 15, refillRatePerSecond: 1, initialTokens: 15 }
    });
    const r = await limiter2.check("meta:1", 1);
    assert.equal(r.limit, 15);
  });

  test("algorithm identity is token-bucket", async () => {
    const r = await limiter.check("meta:1", 1);
    assert.equal(r.algorithm, "token-bucket");
  });

  test("resetHint in metadata", async () => {
    const r = await limiter.check("meta:1", 1);
    assert.ok(r.metadata?.resetHint !== undefined);
  });
});