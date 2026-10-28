import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRateLimiter, shutdown, silentLogger } from "../../dist/index.js";

const URL = "redis://127.0.0.1:6379/9";

describe("Sliding-Window Rate Limiter", () => {
  let client: Awaited<ReturnType<typeof createClient>>;
  let limiter: ReturnType<typeof createRateLimiter>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 10, intervalMs: 60000 });
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

  test("check mode does not consume - shows remaining after hypothetical cost", async () => {
    await limiter.consume("user:1", 3);
    const check = await limiter.check("user:1", 2);
    assert.equal(check.allowed, true);
    assert.equal(check.remaining, 5); // 10 - (3+2) = 5 (after hypothetical cost)
    assert.equal(check.consumed, 0);
    const after = await limiter.consume("user:1", 2);
    assert.equal(after.allowed, true);
    assert.equal(after.remaining, 5); // 10 - (3+2) = 5
  });

  test("multiple independent identities", async () => {
    await limiter.consume("user:1", 10);
    const r = await limiter.consume("user:2", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 9);
  });

  test("reset clears state", async () => {
    await limiter.consume("user:1", 5);
    await limiter.reset("user:1");
    const r = await limiter.check("user:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 9);
  });

  test("zero cost rejected", async () => {
    await assert.rejects(() => limiter.consume("user:1", 0), /weight must be/);
  });

  test("negative cost rejected", async () => {
    await assert.rejects(() => limiter.consume("user:1", -1), /weight must be/);
  });
});

describe("Sliding-Window: Events Entering and Leaving Window", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("events expire after interval", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 2, intervalMs: 200 });
    await limiter.consume("expire:1", 1);
    await limiter.consume("expire:1", 1);
    const r1 = await limiter.consume("expire:1", 1);
    assert.equal(r1.allowed, false);
    await new Promise(resolve => setTimeout(resolve, 250));
    const r2 = await limiter.consume("expire:1", 1);
    assert.equal(r2.allowed, true, "Old events should have expired");
  });

  test("partial expiration - oldest events expire first", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 5, intervalMs: 500 });
    await limiter.consume("partial:1", 2);
    await new Promise(resolve => setTimeout(resolve, 300));
    await limiter.consume("partial:1", 2);
    await new Promise(resolve => setTimeout(resolve, 300));
    const r = await limiter.consume("partial:1", 2);
    assert.equal(r.allowed, true, "First batch should have expired after ~600ms");
  });

  test("events at exact cutoff are pruned", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 3, intervalMs: 300 });
    await limiter.consume("cutoff:1", 1);
    await new Promise(resolve => setTimeout(resolve, 150));
    await limiter.consume("cutoff:1", 1);
    await new Promise(resolve => setTimeout(resolve, 150));
    await limiter.consume("cutoff:1", 1);
    const r = await limiter.consume("cutoff:1", 1);
    assert.equal(r.allowed, true, "First event should be outside window");
  });
});

describe("Sliding-Window: Duplicate Event Members", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("unique tokens prevent duplicate member collisions", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 100, intervalMs: 60000 });
    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter.consume("duplicate:1", 1))
    );
    const allowed = results.filter(r => r.allowed).length;
    assert.equal(allowed, 50, "All 50 concurrent requests should be allowed");
  });
});

describe("Sliding-Window: Same-Millisecond Requests", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("high-frequency requests in same millisecond", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 100, intervalMs: 60000 });
    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter.consume("highfreq:1", 1))
    );
    const allowed = results.filter(r => r.allowed).length;
    assert.equal(allowed, 50, "All same-millisecond requests should be tracked separately");
  });
});

describe("Sliding-Window: Concurrent Consumption", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("concurrent requests for final units - no more than limit admitted", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 5, intervalMs: 60000 });
    const results = await Promise.all(
      Array.from({ length: 15 }, () => limiter.consume("concurrent:1", 1))
    );
    const allowed = results.filter(r => r.allowed).length;
    assert.equal(allowed, 5, "Exactly 5 requests should be allowed");
  });

  test("concurrent weighted requests - atomic", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 10, intervalMs: 60000 });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => limiter.consume("concurrent:2", i % 2 === 0 ? 1 : 2))
    );
    const totalConsumed = results.filter(r => r.allowed).reduce((sum, r) => sum + r.consumed, 0);
    assert.ok(totalConsumed <= 10, `Total consumed ${totalConsumed} should not exceed limit 10`);
  });
});

describe("Sliding-Window: Pruning and TTL Behavior", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("TTL is set on key with buffer", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 5, intervalMs: 5000 });
    await limiter.consume("ttl:test", 1);
    const key = (limiter as any).key("ttl:test");
    const ttl = await client.pttl(key);
    assert.ok(ttl > 5000 && ttl <= 6000, `TTL should be interval + buffer, got ${ttl}`);
  });

  test("old events are pruned on each request", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 3, intervalMs: 300 });
    await limiter.consume("prune:1", 1);
    await new Promise(resolve => setTimeout(resolve, 350));
    await limiter.consume("prune:1", 1);
    const key = (limiter as any).key("prune:1");
    const count = await client.zcard(key);
    assert.equal(count, 1, "Only one event should remain after pruning");
  });
});

describe("Sliding-Window: Memory Growth", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("memory bounded by window - old events removed", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 1000, intervalMs: 200 });
    for (let i = 0; i < 100; i++) {
      await limiter.consume("memory:1", 1);
      if (i % 20 === 0) await new Promise(resolve => setTimeout(resolve, 50));
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    const key = (limiter as any).key("memory:1");
    const count = await client.zcard(key);
    assert.ok(count <= 1000, `Event count ${count} should not exceed limit significantly`);
  });
});

describe("Sliding-Window: Retry Timing Based on Future Expiration", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("retryAfterMs based on oldest event expiration", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 2, intervalMs: 1000 });
    await limiter.consume("retry:1", 1);
    await limiter.consume("retry:1", 1);
    const r = await limiter.consume("retry:1", 1);
    assert.equal(r.allowed, false);
    assert.ok(r.retryAfterMs !== null && r.retryAfterMs > 0);
    assert.ok(r.retryAfterMs <= 1000);
  });

  test("retryAfterMs decreases as oldest event approaches expiration", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 2, intervalMs: 1000 });
    await limiter.consume("retry:2", 1);
    await limiter.consume("retry:2", 1);
    const r1 = await limiter.consume("retry:2", 1);
    const firstRetry = r1.retryAfterMs!;
    await new Promise(resolve => setTimeout(resolve, 200));
    const r2 = await limiter.consume("retry:2", 1);
    const secondRetry = r2.retryAfterMs!;
    assert.ok(secondRetry < firstRetry, "Retry should decrease as oldest event ages");
  });
});

describe("Sliding-Window: Multiple Application Instances", () => {
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

  test("two clients share same sliding window", async () => {
    const limiter1 = createRateLimiter(client1, { algorithm: "sliding-window", limit: 3, intervalMs: 60000 });
    const limiter2 = createRateLimiter(client2, { algorithm: "sliding-window", limit: 3, intervalMs: 60000 });
    await limiter1.consume("shared:1", 1);
    await limiter1.consume("shared:1", 1);
    const r = await limiter2.consume("shared:1", 1);
    assert.equal(r.allowed, true);
    const r2 = await limiter2.consume("shared:1", 1);
    assert.equal(r2.allowed, false);
  });

  test("concurrent requests from two clients", async () => {
    const limiter1 = createRateLimiter(client1, { algorithm: "sliding-window", limit: 5, intervalMs: 60000 });
    const limiter2 = createRateLimiter(client2, { algorithm: "sliding-window", limit: 5, intervalMs: 60000 });
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => limiter1.consume("shared:2", 1)),
      ...Array.from({ length: 5 }, () => limiter2.consume("shared:2", 1)),
    ]);
    const allowed = results.filter(r => r.allowed).length;
    assert.equal(allowed, 5, "Exactly 5 requests should be allowed across both clients");
  });
});

describe("Sliding-Window: Malformed/Expired Redis State", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("missing key treated as empty", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 5, intervalMs: 60000 });
    const r = await limiter.consume("missing:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 4);
  });

  test("expired sorted set treated as empty", async () => {
    const limiter = createRateLimiter(client, { algorithm: "sliding-window", limit: 5, intervalMs: 100 });
    await limiter.consume("expired:1", 3);
    await new Promise(resolve => setTimeout(resolve, 150));
    const r = await limiter.consume("expired:1", 3);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 2);
  });
});