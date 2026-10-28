import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

// Test importing from the built package
import { 
  createClient, 
  createRateLimiter, 
  createMultiRateLimiter,
  createQuota,
  createConcurrencyLimiter,
  createBurstProtector,
  createAdaptiveThrottler,
  createLoadShedder,
  createBackpressureController,
  shutdown,
  silentLogger,
  // Types
  type RateLimitDecision,
  type RateLimiterOptions,
  type RateLimitAlgorithm,
  type QuotaDecision,
  type ConcurrencyLimiterOptions,
  type AdaptiveThrottlingOptions,
  type LoadSheddingOptions,
  type BackpressureOptions,
} from "@oneunit/redis";

const URL = "redis://127.0.0.1:6379/9";

describe("Public API: TypeScript Types", () => {
  test("RateLimiterOptions type is exported", () => {
    const options: RateLimiterOptions = {
      algorithm: "fixed-window",
      limit: 10,
      intervalMs: 60000,
    };
    assert.ok(options);
  });

  test("RateLimitAlgorithm type is exported", () => {
    const alg: RateLimitAlgorithm = "token-bucket";
    assert.ok(alg);
  });

  test("RateLimitDecision type is exported", () => {
    const decision: RateLimitDecision = {
      allowed: true,
      algorithm: "fixed-window",
      limit: 10,
      remaining: 9,
      consumed: 1,
      retryAfterMs: null,
      resetAt: null,
      resetAfterMs: null,
      reason: null,
      fallback: false,
    };
    assert.ok(decision);
  });

  test("QuotaDecision type is exported", () => {
    const decision = { allowed: true } as QuotaDecision;
    assert.ok(decision);
  });

  test("ConcurrencyLimiterOptions type is exported", () => {
    const options: ConcurrencyLimiterOptions = {
      resource: "test",
      maxConcurrency: 10,
      leaseMs: 5000,
    };
    assert.ok(options);
  });

  test("AdaptiveThrottlingOptions type is exported", () => {
    const options: AdaptiveThrottlingOptions = {
      minLimit: 10,
      maxLimit: 100,
    };
    assert.ok(options);
  });

  test("LoadSheddingOptions type is exported", () => {
    const options: LoadSheddingOptions = {
      maxInFlight: 10,
    };
    assert.ok(options);
  });

  test("BackpressureOptions type is exported", () => {
    const options: BackpressureOptions = {
      maxPending: 10,
    };
    assert.ok(options);
  });
});

describe("Public API: Function Exports", () => {
  test("createClient is exported", () => {
    assert.ok(typeof createClient === "function");
  });

  test("createRateLimiter is exported", () => {
    assert.ok(typeof createRateLimiter === "function");
  });

  test("createMultiRateLimiter is exported", () => {
    assert.ok(typeof createMultiRateLimiter === "function");
  });

  test("createQuota is exported", () => {
    assert.ok(typeof createQuota === "function");
  });

  test("createConcurrencyLimiter is exported", () => {
    assert.ok(typeof createConcurrencyLimiter === "function");
  });

  test("createBurstProtector is exported", () => {
    assert.ok(typeof createBurstProtector === "function");
  });

  test("createAdaptiveThrottler is exported", () => {
    assert.ok(typeof createAdaptiveThrottler === "function");
  });

  test("createLoadShedder is exported", () => {
    assert.ok(typeof createLoadShedder === "function");
  });

  test("createBackpressureController is exported", () => {
    assert.ok(typeof createBackpressureController === "function");
  });

  test("shutdown is exported", () => {
    assert.ok(typeof shutdown === "function");
  });

  test("silentLogger is exported", () => {
    assert.ok(silentLogger);
  });
});

describe("Public API: Consumer Smoke Test", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("can create and use rate limiter from public API", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000 });
    const r = await limiter.consume("smoke:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 9);
  });

  test("can create and use sliding-window rate limiter", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 10, intervalMs: 60000 });
    const r = await limiter.consume("smoke:2", 1);
    assert.equal(r.allowed, true);
  });

  test("can create and use token-bucket rate limiter", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "token-bucket",
      limit: 10,
      intervalMs: 60000,
      tokenBucket: { capacity: 10, refillRatePerSecond: 1, initialTokens: 10 }
    });
    const r = await limiter.consume("smoke:3", 1);
    assert.equal(r.allowed, true);
  });

  test("can create and use leaky-bucket rate limiter", async () => {
    const limiter = createRateLimiter(client, {
      algorithm: "leaky-bucket",
      limit: 10,
      intervalMs: 60000,
      leakyBucket: { capacity: 10, leakRatePerSecond: 1 }
    });
    const r = await limiter.consume("smoke:4", 1);
    assert.equal(r.allowed, true);
  });

  test("can create and use multi-rate-limiter", async () => {
    const l1 = createRateLimiter(client, { algorithm: "fixed-window", limit: 2, intervalMs: 60000, keyPrefix: "m1" });
    const l2 = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "m2" });
    const multi = createMultiRateLimiter([l1, l2]);
    const r = await multi.consume("multi:1", 1);
    assert.equal(r.allowed, true);
  });

  test("can create and use quota", async () => {
    const quota = createQuota(client, { resource: "smoke:q", quota: 10, period: "daily" });
    const r = await quota.consume("smoke:q", 1);
    assert.equal(r.allowed, true);
  });

  test("can create and use concurrency limiter", async () => {
    const limiter = createConcurrencyLimiter(client, { resource: "smoke:c", maxConcurrency: 2, leaseMs: 5000 });
    const r = await limiter.tryAcquire();
    assert.equal(r.acquired, true);
  });

  test("can create and use burst protector", async () => {
    const bp = createBurstProtector(client, { 
      sustainedLimit: 10, 
      sustainedIntervalMs: 60000, 
      burstCapacity: 5, 
      burstIntervalMs: 1000 
    });
    const r = await bp.consume("smoke:bp", 1);
    assert.equal(r.allowed, true);
  });

  test("can create and use adaptive throttler", async () => {
    const throttler = createAdaptiveThrottler(100, { minLimit: 10, maxLimit: 200 });
    const limit = throttler.sample(0.5);
    assert.equal(limit, 100);
  });

  test("can create and use load shedder", async () => {
    const shedder = createLoadShedder(10, 100);
    const r = shedder.acquire(0);
    assert.equal(r.shed, false);
  });

  test("can create and use backpressure controller", async () => {
    const bp = createBackpressureController(10, 1000);
    const r = await bp.admit(1);
    assert.equal(r.admitted, true);
  });

  test("all algorithms work with weighted requests", async () => {
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
      const r = await limiter.consume("weighted:1", 2.5);
      assert.equal(r.allowed, true);
      assert.equal(r.consumed, 2.5);
    }
  });

  test("fail-open works from public API", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 1000, failurePolicy: "fail-open" });
    await shutdown(client, silentLogger);
    const r = await limiter.consume("fo:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.fallback, true);
  });

  test("fail-closed works from public API", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 1000, failurePolicy: "fail-closed" });
    await shutdown(client, silentLogger);
    let threw = false;
    try { await limiter.consume("fc:1", 1); } catch { threw = true; }
    assert.equal(threw, true);
  });
});

describe("Public API: Subpath Imports", () => {
  test("can import from @oneunit/redis/rate-limit subpath", () => {
    import("@oneunit/redis/rate-limit").then(({ createRateLimiter: rl }) => {
      assert.ok(typeof rl === "function");
    });
  });

  test("can import from @oneunit/redis/coordination subpath", () => {
    import("@oneunit/redis/coordination").then(({ createCoordinationClient: cl }) => {
      assert.ok(typeof cl === "function");
    });
  });

  test("can import from @oneunit/redis/cache subpath", () => {
    import("@oneunit/redis/cache").then((mod) => {
      assert.ok(Object.keys(mod).length > 0);
    });
  });
});

describe("Public API: Error Exports", () => {
  test("RateLimitError is exported from rate-limit", () => {
    import("@oneunit/redis/rate-limit").then(({ RateLimitError }) => {
      assert.ok(typeof RateLimitError === "function");
      const err = new RateLimitError("test");
      assert.ok(err instanceof Error);
    });
  });

  test("RateLimitConfigError is exported from rate-limit", () => {
    import("@oneunit/redis/rate-limit").then(({ RateLimitConfigError }) => {
      assert.ok(typeof RateLimitConfigError === "function");
    });
  });

  test("ConcurrencyAcquisitionError is exported from rate-limit", () => {
    import("@oneunit/redis/rate-limit").then(({ ConcurrencyAcquisitionError }) => {
      assert.ok(typeof ConcurrencyAcquisitionError === "function");
    });
  });

  test("BackpressureError is exported from rate-limit", () => {
    import("@oneunit/redis/rate-limit").then(({ BackpressureError }) => {
      assert.ok(typeof BackpressureError === "function");
    });
  });
});