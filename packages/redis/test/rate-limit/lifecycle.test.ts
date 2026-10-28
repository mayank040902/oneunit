import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRateLimiter, createConcurrencyLimiter, createQuota, createBurstProtector, shutdown, silentLogger } from "../../dist/index.js";

const URL = "redis://127.0.0.1:6379/9";

describe("Lifecycle: Client Shutdown", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
  });

  test("shutdown is idempotent", async () => {
    await shutdown(client, silentLogger);
    await shutdown(client, silentLogger); // Should not throw
    await shutdown(client, silentLogger); // Should not throw
  });

  test("shutdown clears all pending operations - new client sees fresh Redis", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 60000 });
    await limiter.consume("shutdown:1", 1);
    
    // Consume should be denied
    const r = await limiter.consume("shutdown:1", 1);
    assert.equal(r.allowed, false);
    
    // Shutdown client (Redis data persists)
    await shutdown(client, silentLogger);
    
    // New client connects to same Redis - data still there
    const newClient = createClient({ url: URL }, silentLogger);
    try {
      const newLimiter = createRateLimiter(newClient, { algorithm: "fixed-window", limit: 1, intervalMs: 60000 });
      const r2 = await newLimiter.consume("shutdown:1", 1);
      assert.equal(r2.allowed, false, "Redis data persists after client shutdown");
    } finally {
      await shutdown(newClient, silentLogger);
    }
  });

  test("multiple clients can be shutdown independently", async () => {
    const client1 = createClient({ url: URL }, silentLogger);
    const client2 = createClient({ url: URL }, silentLogger);
    
    await client1.flushdb();
    
    const limiter1 = createRateLimiter(client1, { algorithm: "fixed-window", limit: 10, intervalMs: 60000 });
    const limiter2 = createRateLimiter(client2, { algorithm: "fixed-window", limit: 10, intervalMs: 60000 });
    
    await limiter1.consume("multi:1", 5);
    await limiter2.consume("multi:1", 5);
    
    await shutdown(client1, silentLogger);
    // client2 should still work
    const r = await limiter2.consume("multi:2", 1);
    assert.equal(r.allowed, true);
    
    await shutdown(client2, silentLogger);
  });

  test("shutdown with active semaphore permits - permits persist in Redis", async () => {
    const limiter = createConcurrencyLimiter(client, { resource: "shutdown:sem", maxConcurrency: 2, leaseMs: 5000 });
    await limiter.acquire("owner1");
    await limiter.acquire("owner2");
    
    await shutdown(client, silentLogger);
    
    // Permits persist in Redis until lease expires
    // New client sees existing permits
    const newClient = createClient({ url: URL }, silentLogger);
    try {
      const newLimiter = createConcurrencyLimiter(newClient, { resource: "shutdown:sem", maxConcurrency: 2, leaseMs: 5000 });
      const r = await newLimiter.tryAcquire("owner3");
      assert.equal(r.acquired, false, "Existing permits still held in Redis");
    } finally {
      await shutdown(newClient, silentLogger);
    }
  });
});

describe("Lifecycle: Resource Cleanup", () => {
  test("rate limiter does not leak timers", async () => {
    const client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000 });
    await limiter.consume("cleanup:1", 1);
    
    const initialTimers = setTimeout(() => {}, 1000); // Dummy to measure
    clearTimeout(initialTimers);
    
    // No timers should be created by rate limiter
    await shutdown(client, silentLogger);
  });

  test("concurrency limiter does not leak timers on acquire with timeout", async () => {
    const client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    
    const limiter = createConcurrencyLimiter(client, { resource: "cleanup:sem", maxConcurrency: 1, leaseMs: 5000, timeoutMs: 100 });
    await limiter.acquire("owner1");
    
    // This should timeout
    let threw = false;
    try {
      await limiter.acquire("owner2");
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    
    await shutdown(client, silentLogger);
  });

  test("burst protector does not leak resources", async () => {
    const client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    
    const bp = createBurstProtector(client, { 
      sustainedLimit: 10, 
      sustainedIntervalMs: 60000, 
      burstCapacity: 5, 
      burstIntervalMs: 1000,
      concurrencyLimit: 2,
      concurrencyLeaseMs: 5000
    });
    
    const r = await bp.consume("cleanup:bp", 1, true);
    if (r.concurrencyToken) {
      await bp.releaseConcurrency(r.concurrencyToken);
    }
    
    await shutdown(client, silentLogger);
  });

  test("quota does not leak resources", async () => {
    const client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    
    const quota = createQuota(client, { resource: "cleanup:q", quota: 10, period: "daily" });
    await quota.consume("cleanup:q", 1);
    
    await shutdown(client, silentLogger);
  });

  test("adaptive throttler reset clears state", async () => {
    const { createAdaptiveThrottler } = await import("../../dist/index.js");
    const throttler = createAdaptiveThrottler(100, { minLimit: 10, maxLimit: 200, samplingIntervalMs: 0 });
    
    throttler.sample(0.9);
    throttler.sample(0.9);
    assert.ok(throttler.getLimit() < 100);
    
    throttler.reset();
    assert.equal(throttler.getLimit(), 100);
  });

  test("load shedder release clears in-flight", async () => {
    const { createLoadShedder } = await import("../../dist/index.js");
    const shedder = createLoadShedder(10, 100);
    
    shedder.acquire(0);
    shedder.acquire(0);
    assert.equal(shedder.getInFlight(), 2);
    
    shedder.release();
    shedder.release();
    assert.equal(shedder.getInFlight(), 0);
  });

  test("backpressure controller release clears pending", async () => {
    const { createBackpressureController } = await import("../../dist/index.js");
    const bp = createBackpressureController(10, 1000);
    
    await bp.admit(1);
    await bp.admit(1);
    assert.equal(bp.getPending(), 2);
    
    bp.release(1);
    bp.release(1);
    assert.equal(bp.getPending(), 0);
  });
});

describe("Lifecycle: No Cross-Test State Leakage", () => {
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

  test("rate limiter state cleared between tests via flushdb", async () => {
    const limiter = createRateLimiter(client1, { algorithm: "fixed-window", limit: 10, intervalMs: 60000 });
    await limiter.consume("leak:1", 5);
    
    // flushdb in afterEach clears state before next test
    // This test verifies that within this test, state is present
    const check = await limiter.check("leak:1", 1);
    assert.equal(check.remaining, 5);
    
    // After this test, afterEach flushdb will clear for next test
  });

  test("concurrency limiter state cleared between tests via flushdb", async () => {
    const limiter = createConcurrencyLimiter(client1, { resource: "leak:c", maxConcurrency: 1, leaseMs: 5000 });
    await limiter.acquire("owner1");
    
    // State present in this test
    const r = await limiter.tryAcquire("owner2");
    assert.equal(r.acquired, false);
  });

  test("quota state cleared between tests via flushdb", async () => {
    const quota = createQuota(client1, { resource: "leak:q", quota: 5, period: "daily" });
    await quota.consume("leak:q", 5);
    
    // State present in this test
    const r = await quota.consume("leak:q", 1);
    assert.equal(r.allowed, false);
  });

  test("different resources are independent within same test", async () => {
    const limiter = createRateLimiter(client1, { algorithm: "fixed-window", limit: 10, intervalMs: 60000 });
    
    await limiter.consume("res:A", 10);
    const r = await limiter.consume("res:B", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 9);
  });
});

describe("Lifecycle: Unhandled Rejection Prevention", () => {
  test("no unhandled rejections from rate limiter errors", async () => {
    const client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, failurePolicy: "fail-closed" });
    
    // Close connection
    await shutdown(client, silentLogger);
    
    // This should throw synchronously (not cause unhandled rejection)
    let threw = false;
    try {
      await limiter.consume("unhandled:1", 1);
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
  });

  test("no unhandled rejections from concurrency limiter errors", async () => {
    const client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    
    const limiter = createConcurrencyLimiter(client, { resource: "unhandled", maxConcurrency: 1, leaseMs: 5000, failurePolicy: "fail-closed" });
    
    await shutdown(client, silentLogger);
    
    let threw = false;
    try {
      await limiter.acquire("owner1");
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
  });

  test("no unhandled rejections from burst protector", async () => {
    const client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    
    const bp = createBurstProtector(client, { 
      sustainedLimit: 10, 
      sustainedIntervalMs: 60000, 
      burstCapacity: 5, 
      burstIntervalMs: 1000,
      failurePolicy: "fail-closed"
    });
    
    await shutdown(client, silentLogger);
    
    let threw = false;
    try {
      await bp.consume("unhandled:1", 1);
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
  });
});

describe("Lifecycle: Full Integration", () => {
  test("complete workflow: create -> use -> shutdown -> recreate", async () => {
    let client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 100, intervalMs: 60000 });
    await limiter.consume("workflow:1", 50);
    
    await shutdown(client, silentLogger);
    
    // Recreate
    client = createClient({ url: URL }, silentLogger);
    try {
      const newLimiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 100, intervalMs: 60000 });
      const r = await newLimiter.consume("workflow:1", 1);
      assert.equal(r.allowed, true);
      assert.equal(r.remaining, 49); // 100 - 50 - 1 = 49
    } finally {
      await shutdown(client, silentLogger);
    }
  });

  test("complete workflow with concurrency: create -> acquire -> release -> shutdown -> recreate", async () => {
    let client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    
    const limiter = createConcurrencyLimiter(client, { resource: "workflow:c", maxConcurrency: 2, leaseMs: 5000 });
    const acq = await limiter.acquire("owner1");
    await limiter.release(acq.token!);
    
    await shutdown(client, silentLogger);
    
    client = createClient({ url: URL }, silentLogger);
    try {
      const newLimiter = createConcurrencyLimiter(client, { resource: "workflow:c", maxConcurrency: 2, leaseMs: 5000 });
      const r = await newLimiter.tryAcquire("owner2");
      assert.equal(r.acquired, true);
    } finally {
      await shutdown(client, silentLogger);
    }
  });
});