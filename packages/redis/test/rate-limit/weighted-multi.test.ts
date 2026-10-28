import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRateLimiter, createMultiRateLimiter, shutdown, silentLogger } from "@oneunit/redis";

const URL = "redis://127.0.0.1:6379/9";

describe("Weighted Rate Limiting", () => {
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

  test("cost of 1 (default)", async () => {
    const r = await limiter.consume("user:1");
    assert.equal(r.allowed, true);
    assert.equal(r.consumed, 1);
    assert.equal(r.remaining, 9);
  });

  test("larger positive costs", async () => {
    const r = await limiter.consume("user:1", 5);
    assert.equal(r.allowed, true);
    assert.equal(r.consumed, 5);
    assert.equal(r.remaining, 5);
  });

  test("fractional costs", async () => {
    const r1 = await limiter.consume("user:1", 1.5);
    assert.equal(r1.allowed, true);
    assert.equal(r1.consumed, 1.5);
    const r2 = await limiter.consume("user:1", 2.5);
    assert.equal(r2.allowed, true);
    assert.equal(r2.consumed, 2.5);
    assert.equal(r2.remaining, 6);
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

  test("cost exceeding limit denied immediately", async () => {
    const r = await limiter.consume("user:1", 15);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "cost_exceeds_limit");
    assert.equal(r.consumed, 0);
  });

  test("weighted cost at exact limit boundary", async () => {
    await limiter.consume("user:1", 3);
    await limiter.consume("user:1", 3);
    const r = await limiter.consume("user:1", 4);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 0);
    const r2 = await limiter.consume("user:1", 1);
    assert.equal(r2.allowed, false);
  });

  test("weighted costs work across algorithms", async () => {
    const algorithms: Array<"fixed-window" | "sliding-window" | "token-bucket" | "leaky-bucket"> = [
      "fixed-window", "sliding-window", "token-bucket", "leaky-bucket"
    ];
    for (const alg of algorithms) {
      await client.flushdb();
      const lim = createRateLimiter(client, {
        algorithm: alg,
        limit: 10,
        intervalMs: 60000,
        ...(alg === "token-bucket" && { tokenBucket: { capacity: 10, refillRatePerSecond: 1, initialTokens: 10 } }),
        ...(alg === "leaky-bucket" && { leakyBucket: { capacity: 10, leakRatePerSecond: 1 } })
      });
      const r = await lim.consume("alg:1", 3.5);
      assert.equal(r.allowed, true, `${alg}: should allow fractional cost`);
      assert.equal(r.consumed, 3.5, `${alg}: consumed should match`);
    }
  });

  test("extremely large values handled", async () => {
    const r = await limiter.consume("large:1", 1e10);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "cost_exceeds_limit");
  });

  test("numeric precision with fractional weights", async () => {
    for (let i = 0; i < 100; i++) {
      const r = await limiter.consume("precise:1", 0.1);
      assert.equal(r.allowed, true);
    }
    const r = await limiter.consume("precise:1", 0.1);
    assert.equal(r.allowed, false);
  });
});

describe("Multi-Dimensional Limiting", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("per-user and global limits", async () => {
    const userLimiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 2, intervalMs: 60000, keyPrefix: "user" });
    const globalLimiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 5, intervalMs: 60000, keyPrefix: "global" });
    const multi = createMultiRateLimiter([userLimiter, globalLimiter]);

    await userLimiter.consume("user:1", 2);
    const r = await multi.consume("user:1", 1);
    assert.equal(r.allowed, false);
    assert.equal(r.decisions[0].reason, "limited");
    assert.equal(r.decisions[1].allowed, true);
  });

  test("per-tenant and per-route limits", async () => {
    const tenantLimiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "tenant" });
    const routeLimiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 5, intervalMs: 60000, keyPrefix: "route" });
    const multi = createMultiRateLimiter([tenantLimiter, routeLimiter]);

    // Use same resource for both limiters
    const resource = "tenant:1:GET:/api/users";
    await routeLimiter.consume(resource, 5);
    const r = await multi.consume(resource, 1);
    assert.equal(r.allowed, false);
    assert.equal(r.decisions[1].reason, "limited");
  });

  test("per-IP and per-account limits", async () => {
    const ipLimiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 3, intervalMs: 60000, keyPrefix: "ip" });
    const accountLimiter = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "account" });
    const multi = createMultiRateLimiter([ipLimiter, accountLimiter]);

    // Use same resource for both limiters
    const resource = "account:1@192.168.1.1";
    await ipLimiter.consume(resource, 3);
    const r = await multi.consume(resource, 1);
    assert.equal(r.allowed, false);
    assert.equal(r.decisions[0].reason, "limited");
  });

  test("multiple independent policies - denial by each", async () => {
    const a = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 60000, keyPrefix: "a" });
    const b = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 60000, keyPrefix: "b" });
    const multi = createMultiRateLimiter([a, b]);

    await a.consume("u", 1);
    await b.consume("u", 1);
    const r = await multi.consume("u", 1);
    assert.equal(r.allowed, false);
    assert.equal(r.decisions.length, 2);
    assert.equal(r.decisions[0].allowed, false);
    assert.equal(r.decisions[1].allowed, false);
  });

  test("several exhausted policies simultaneously", async () => {
    const limiters = [
      createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 60000, keyPrefix: "p1" }),
      createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 60000, keyPrefix: "p2" }),
      createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 60000, keyPrefix: "p3" }),
    ];
    const multi = createMultiRateLimiter(limiters);

    for (const lim of limiters) {
      await lim.consume("exhausted", 1);
    }
    const r = await multi.consume("exhausted", 1);
    assert.equal(r.allowed, false);
    assert.equal(r.decisions.length, 3);
    for (const d of r.decisions) {
      assert.equal(d.allowed, false);
    }
  });

  test("correct denial reason and policy metadata", async () => {
    const a = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 60000, keyPrefix: "a" });
    const b = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "b" });
    const multi = createMultiRateLimiter([a, b]);

    await a.consume("u", 1);
    const r = await multi.consume("u", 1);
    assert.equal(r.allowed, false);
    assert.ok(r.decisions[0].reason === "limited");
    assert.ok(r.decisions[1].allowed === true);
    assert.ok(r.retryAfterMs !== null);
  });

  test("no unintended partial consumption when all-or-nothing promised", async () => {
    const a = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 60000, keyPrefix: "a" });
    const b = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "b" });
    const multi = createMultiRateLimiter([a, b]);

    await a.consume("u", 1);
    const before = await b.check("u", 1);
    assert.equal(before.remaining, 10, "b has not been consumed yet");
    const r = await multi.consume("u", 1);
    assert.equal(r.allowed, false);
    const after = await b.check("u", 1);
    assert.equal(after.remaining, 10, "b should not have consumed");
  });

  test("one policy succeeds, another fails", async () => {
    const a = createRateLimiter(client, { algorithm: "fixed-window", limit: 1, intervalMs: 60000, keyPrefix: "a" });
    const b = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "b" });
    const multi = createMultiRateLimiter([a, b]);

    await a.consume("u", 1);
    const r = await multi.consume("u", 1);
    assert.equal(r.allowed, false);
    assert.equal(r.decisions[0].allowed, false);
    assert.equal(r.decisions[1].allowed, true);
  });

  test("consistency across multiple clients - shared limiters", async () => {
    const client2 = createClient({ url: URL }, silentLogger);
    try {
      const a1 = createRateLimiter(client, { algorithm: "fixed-window", limit: 2, intervalMs: 60000, keyPrefix: "a" });
      const a2 = createRateLimiter(client2, { algorithm: "fixed-window", limit: 2, intervalMs: 60000, keyPrefix: "a" });
      const b1 = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "b" });
      const b2 = createRateLimiter(client2, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "b" });
      const multi1 = createMultiRateLimiter([a1, b1]);
      const multi2 = createMultiRateLimiter([a2, b2]);

      await multi1.consume("shared", 1); // a=1, b=1
      await multi2.consume("shared", 1); // a=2, b=2
      const r = await multi1.consume("shared", 1); // a=3 > 2 -> denied
      assert.equal(r.allowed, false);
      const r2 = await multi2.consume("shared", 1); // a=3 > 2 -> denied
      assert.equal(r2.allowed, false);
    } finally {
      await shutdown(client2, silentLogger);
    }
  });

  test("check mode across all limiters - no consumption", async () => {
    const a = createRateLimiter(client, { algorithm: "fixed-window", limit: 2, intervalMs: 60000, keyPrefix: "a" });
    const b = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "b" });
    const multi = createMultiRateLimiter([a, b]);

    await a.consume("u", 1);
    const check = await multi.check("u", 1);
    assert.equal(check.allowed, true);
    assert.equal(check.decisions[0].remaining, 1); // a: limit=2, consumed=1, remaining=1
    assert.equal(check.decisions[1].remaining, 10); // b: limit=10, not consumed, remaining=10
    assert.equal(check.decisions[0].consumed, 0);
    assert.equal(check.decisions[1].consumed, 0);
  });
});

describe("Multi-Dimensional: Race Condition Between Check and Consume", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("concurrent multi.consume - race window exists", async () => {
    const a = createRateLimiter(client, { algorithm: "fixed-window", limit: 2, intervalMs: 60000, keyPrefix: "race" });
    const b = createRateLimiter(client, { algorithm: "fixed-window", limit: 10, intervalMs: 60000, keyPrefix: "race" });
    const multi = createMultiRateLimiter([a, b]);

    // First consume exhausts 'a'
    await a.consume("race:1", 1);
    await a.consume("race:1", 1);

    // Now concurrent multi.consume - both check pass but only one should succeed on consume
    // This test documents the race condition - not atomic
    const results = await Promise.all([
      multi.consume("race:1", 1),
      multi.consume("race:1", 1),
    ]);

    // At least one should be denied because 'a' is exhausted
    const denied = results.filter(r => !r.allowed).length;
    assert.ok(denied >= 1, "At least one should be denied due to exhausted limiter");
  });
});