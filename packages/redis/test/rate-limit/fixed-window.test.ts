import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRateLimiter, shutdown, silentLogger } from "../../dist/index.js";

const URL = "redis://127.0.0.1:6379/9";

describe("Fixed-Window Rate Limiter", () => {
  let client: Awaited<ReturnType<typeof createClient>>;
  let limiter: ReturnType<typeof createRateLimiter>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000 });
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("first request allowed", async () => {
    const r = await limiter.consume("user:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 9);
    assert.equal(r.consumed, 1);
    assert.equal(r.retryAfterMs, null);
    assert.ok(r.resetAt !== null);
    assert.ok(r.resetAfterMs > 0);
  });

  test("normal consumption up to limit", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await limiter.consume("user:1", 1);
      assert.equal(r.allowed, true, `Request ${i + 1} should be allowed`);
    }
  });

  test("exact limit boundary - last request allowed", async () => {
    for (let i = 0; i < 9; i++) {
      await limiter.consume("user:1", 1);
    }
    const r = await limiter.consume("user:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 0);
  });

  test("one unit above limit - denied", async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.consume("user:1", 1);
    }
    const r = await limiter.consume("user:1", 1);
    assert.equal(r.allowed, false);
    assert.equal(r.remaining, 0);
    assert.equal(r.reason, "limited");
    assert.ok(r.retryAfterMs !== null && r.retryAfterMs >= 0);
    assert.ok(r.resetAt !== null);
  });

  test("weighted requests - exact limit", async () => {
    const r1 = await limiter.consume("user:1", 5);
    assert.equal(r1.allowed, true);
    assert.equal(r1.remaining, 5);
    const r2 = await limiter.consume("user:1", 5);
    assert.equal(r2.allowed, true);
    assert.equal(r2.remaining, 0);
    const r3 = await limiter.consume("user:1", 1);
    assert.equal(r3.allowed, false);
  });

  test("weighted requests - cost exceeds limit denied immediately", async () => {
    const r = await limiter.consume("user:1", 15);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "cost_exceeds_limit");
  });

  test("check mode does not consume - shows remaining before check cost", async () => {
    await limiter.consume("user:1", 3);
    const check = await limiter.check("user:1", 2);
    assert.equal(check.allowed, true);
    assert.equal(check.remaining, 7); // 10 - 3 = 7 (before check cost)
    assert.equal(check.consumed, 0);
    const after = await limiter.consume("user:1", 2);
    assert.equal(after.allowed, true);
    assert.equal(after.remaining, 5); // 10 - 3 - 2 = 5
  });

  test("multiple independent identities", async () => {
    await limiter.consume("user:1", 10);
    const r = await limiter.consume("user:2", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 9);
  });

  test("reset clears state - check shows full limit", async () => {
    await limiter.consume("user:1", 5);
    await limiter.reset("user:1");
    const r = await limiter.check("user:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 10); // limit - 0 = 10 (check shows before hypothetical cost)
  });

  test("zero cost rejected", async () => {
    await assert.rejects(() => limiter.consume("user:1", 0), /weight must be/);
  });

  test("negative cost rejected", async () => {
    await assert.rejects(() => limiter.consume("user:1", -1), /weight must be/);
  });

  test("NaN cost rejected", async () => {
    await assert.rejects(() => limiter.consume("user:1", NaN), /weight must be/);
  });

  test("Infinity cost rejected", async () => {
    await assert.rejects(() => limiter.consume("user:1", Infinity), /weight must be/);
  });
});

describe("Fixed-Window: Concurrent Requests", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("concurrent requests for final unit - no more than limit admitted", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 5, intervalMs: 60000 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.consume("concurrent:1", 1))
    );
    const allowed = results.filter(r => r.allowed).length;
    assert.equal(allowed, 5, "Exactly 5 requests should be allowed");
    const denied = results.filter(r => !r.allowed).length;
    assert.equal(denied, 5, "5 requests should be denied");
  });

  test("concurrent weighted requests - atomic check and consume", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000 });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => limiter.consume("concurrent:2", i % 2 === 0 ? 1 : 2))
    );
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    assert.ok(totalConsumed <= 10, `Total consumed ${totalConsumed} should not exceed limit 10`);
  });
});

describe("Fixed-Window: TTL and Window Rollover", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("TTL is set on key", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 5, intervalMs: 5000 });
    await limiter.consume("ttl:test", 1);
    const key = (limiter as any).key("ttl:test");
    const ttl = await client.pttl(key);
    assert.ok(ttl > 0 && ttl <= 5000, `TTL should be positive and <= interval, got ${ttl}`);
  });

  test("key expires after window", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 2, intervalMs: 100 });
    await limiter.consume("expire:1", 1);
    await limiter.consume("expire:1", 1);
    const r1 = await limiter.consume("expire:1", 1);
    assert.equal(r1.allowed, false);
    await new Promise(resolve => setTimeout(resolve, 150));
    const r2 = await limiter.consume("expire:1", 1);
    assert.equal(r2.allowed, true, "Should be allowed after window expires");
  });

  test("requests immediately before and after expiration", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 200 });
    const r1 = await limiter.consume("boundary:1", 1);
    assert.equal(r1.allowed, true);
    const r2 = await limiter.consume("boundary:1", 1);
    assert.equal(r2.allowed, false);
    await new Promise(resolve => setTimeout(resolve, 250));
    const r3 = await limiter.consume("boundary:1", 1);
    assert.equal(r3.allowed, true, "Should be allowed in new window");
  });
});

describe("Fixed-Window: Retry-After Accuracy", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("retryAfterMs decreases as window approaches end", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 1000 });
    await limiter.consume("retry:1", 1);
    const r1 = await limiter.consume("retry:1", 1);
    assert.equal(r1.allowed, false);
    const firstRetry = r1.retryAfterMs;
    assert.ok(firstRetry !== null && firstRetry > 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    const r2 = await limiter.consume("retry:1", 1);
    assert.equal(r2.allowed, false);
    const secondRetry = r2.retryAfterMs;
    assert.ok(secondRetry !== null && secondRetry < firstRetry!, "Retry should decrease over time");
  });

  test("retryAfterMs is zero at window boundary", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 100 });
    await limiter.consume("boundary:1", 1);
    await new Promise(resolve => setTimeout(resolve, 150));
    const r = await limiter.consume("boundary:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.retryAfterMs, null);
  });
});

describe("Fixed-Window: Malformed/Expired Redis State", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("missing key treated as zero", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 5, intervalMs: 60000 });
    const r = await limiter.consume("missing:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 4);
  });

  test("expired key treated as zero", async () => {
    const limiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 5, intervalMs: 100 });
    await limiter.consume("expired:1", 3);
    await new Promise(resolve => setTimeout(resolve, 150));
    const r = await limiter.consume("expired:1", 3);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 2);
  });
});

describe("Fixed-Window: Multiple Application Instances", () => {
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

  test("two clients share same limit", async () => {
    const limiter1 = createRateLimiter(client1, { algorithm: "fixed-window", limit: 3, intervalMs: 60000 });
    const limiter2 = createRateLimiter(client2, { algorithm: "fixed-window", limit: 3, intervalMs: 60000 });
    await limiter1.consume("shared:1", 1);
    await limiter1.consume("shared:1", 1);
    const r = await limiter2.consume("shared:1", 1);
    assert.equal(r.allowed, true);
    const r2 = await limiter2.consume("shared:1", 1);
    assert.equal(r2.allowed, false);
  });

  test("concurrent requests from two clients", async () => {
    const limiter1 = createRateLimiter(client1, { algorithm: "fixed-window", limit: 5, intervalMs: 60000 });
    const limiter2 = createRateLimiter(client2, { algorithm: "fixed-window", limit: 5, intervalMs: 60000 });
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => limiter1.consume("shared:2", 1)),
      ...Array.from({ length: 5 }, () => limiter2.consume("shared:2", 1)),
    ]);
    const allowed = results.filter(r => r.allowed).length;
    assert.equal(allowed, 5, "Exactly 5 requests should be allowed across both clients");
  });
});