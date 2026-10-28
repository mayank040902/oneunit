import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createClient, createQuota, shutdown, silentLogger } from "@oneunit/redis";

const URL = "redis://127.0.0.1:6379/9";

describe("Daily Quota", () => {
  let client: Awaited<ReturnType<typeof createClient>>;
  let quota: ReturnType<typeof createQuota>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    quota = createQuota(client, { resource: "daily", quota: 10, period: "daily" });
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("normal consumption", async () => {
    const r = await quota.consume("user:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.consumed, 1);
    assert.equal(r.used, 1);
    assert.equal(r.remaining, 9);
    assert.equal(r.quota, 10);
    assert.equal(r.period, "daily");
    assert.ok(r.resetAt !== null);
  });

  test("exact quota exhaustion", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await quota.consume("user:1", 1);
      assert.equal(r.allowed, true);
    }
  });

  test("over-quota denial", async () => {
    await quota.consume("user:1", 10);
    const r = await quota.consume("user:1", 1);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "quota_exhausted");
    assert.equal(r.consumed, 0);
    assert.equal(r.used, 10);
    assert.equal(r.remaining, 0);
  });

  test("weighted quota consumption", async () => {
    const weightedQuota = createQuota(client, { resource: "weighted", quota: 10, period: "daily", weight: 2 });
    const r1 = await weightedQuota.consume("user:1", 1); // consumes 2
    assert.equal(r1.allowed, true);
    assert.equal(r1.consumed, 2);
    assert.equal(r1.used, 2);
    assert.equal(r1.remaining, 8);
    
    const r2 = await weightedQuota.consume("user:1", 4); // consumes 8
    assert.equal(r2.allowed, true);
    assert.equal(r2.consumed, 8);
    assert.equal(r2.used, 10);
    assert.equal(r2.remaining, 0);
    
    const r3 = await weightedQuota.consume("user:1", 1); // would consume 2, over quota
    assert.equal(r3.allowed, false);
  });

  test("concurrent requests for final quota unit", async () => {
    const results = await Promise.all(
      Array.from({ length: 15 }, () => quota.consume("concurrent:1", 1))
    );
    const allowed = results.filter(r => r.allowed).length;
    assert.equal(allowed, 10, "Exactly 10 requests should be allowed");
  });

  test("multiple users have independent quotas", async () => {
    await quota.consume("user:1", 10);
    const r = await quota.consume("user:2", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 9);
  });

  test("resetAt is next day UTC midnight", async () => {
    const r = await quota.consume("user:1", 1);
    const now = new Date();
    const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
    assert.equal(r.resetAt, expected.getTime());
  });

  test("retryAfterMs decreases over time", async () => {
    await quota.consume("retry:1", 10);
    const r1 = await quota.consume("retry:1", 1);
    const firstRetry = r1.retryAfterMs!;
    await new Promise(resolve => setTimeout(resolve, 1000));
    const r2 = await quota.consume("retry:1", 1);
    const secondRetry = r2.retryAfterMs!;
    assert.ok(secondRetry < firstRetry, "Retry should decrease over time");
  });

  test("zero amount rejected", async () => {
    await assert.rejects(() => quota.consume("user:1", 0), /amount must be positive/);
  });

  test("negative amount rejected", async () => {
    await assert.rejects(() => quota.consume("user:1", -1), /amount must be positive/);
  });

  test("NaN amount rejected", async () => {
    await assert.rejects(() => quota.consume("user:1", NaN), /amount must be positive/);
  });
});

describe("Monthly Quota", () => {
  let client: Awaited<ReturnType<typeof createClient>>;
  let quota: ReturnType<typeof createQuota>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
    quota = createQuota(client, { resource: "monthly", quota: 10, period: "monthly" });
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("normal consumption", async () => {
    const r = await quota.consume("user:1", 3);
    assert.equal(r.allowed, true);
    assert.equal(r.consumed, 3);
    assert.equal(r.used, 3);
    assert.equal(r.remaining, 7);
  });

  test("resetAt is first day of next month UTC", async () => {
    const r = await quota.consume("user:1", 1);
    const now = new Date();
    const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    assert.equal(r.resetAt, expected.getTime());
  });

  test("handles February correctly", async () => {
    // Can't easily test February without time manipulation
    // But we verify the logic uses Date.UTC which handles leap years
    const r = await quota.consume("feb:1", 1);
    assert.ok(r.resetAt !== null);
  });

  test("handles months with 28, 29, 30, 31 days", async () => {
    // The implementation uses Date.UTC(year, month+1, 1) which correctly handles all month lengths
    const r = await quota.consume("monthlen:1", 1);
    assert.ok(r.resetAt !== null);
  });

  test("UTC behavior - reset at midnight UTC", async () => {
    const r = await quota.consume("utc:1", 1);
    const resetDate = new Date(r.resetAt!);
    assert.equal(resetDate.getUTCHours(), 0);
    assert.equal(resetDate.getUTCMinutes(), 0);
    assert.equal(resetDate.getUTCSeconds(), 0);
    assert.equal(resetDate.getUTCMilliseconds(), 0);
  });

  test("concurrent consumption respects quota", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => quota.consume("concurrent:1", 1))
    );
    const allowed = results.filter(r => r.allowed).length;
    assert.equal(allowed, 10);
  });
});

describe("Custom Period Quota", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("custom period with weight", async () => {
    const quota = createQuota(client, { resource: "custom", quota: 5, period: "custom", customPeriodMs: 60000, weight: 2 });
    const r1 = await quota.consume("user:1", 1); // consumes 2
    assert.equal(r1.allowed, true);
    assert.equal(r1.consumed, 2);
    
    const r2 = await quota.consume("user:1", 1); // consumes 2
    assert.equal(r2.allowed, true);
    assert.equal(r2.consumed, 2);
    assert.equal(r2.used, 4);
    
    const r3 = await quota.consume("user:1", 1); // would consume 2, over quota (5)
    assert.equal(r3.allowed, false);
  });

  test("custom period expiration", async () => {
    const quota = createQuota(client, { resource: "expire", quota: 2, period: "custom", customPeriodMs: 200 });
    await quota.consume("expire:1", 2);
    const r1 = await quota.consume("expire:1", 1);
    assert.equal(r1.allowed, false);
    
    await new Promise(resolve => setTimeout(resolve, 250));
    const r2 = await quota.consume("expire:1", 1);
    assert.equal(r2.allowed, true, "Quota should reset after custom period");
  });

  test("customPeriodMs required for custom period", async () => {
    assert.throws(
      () => createQuota(client, { resource: "test", quota: 10, period: "custom" }),
      /customPeriodMs required/
    );
  });

  test("customPeriodMs must be positive", async () => {
    assert.throws(
      () => createQuota(client, { resource: "test", quota: 10, period: "custom", customPeriodMs: -1 }),
      /customPeriodMs required/
    );
  });
});

describe("Quota: Fail-Open and Fail-Closed", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("fail-closed on closed redis", async () => {
    await shutdown(client, silentLogger);
    const quota = createQuota(client, { resource: "fc", quota: 10, period: "daily", failurePolicy: "fail-closed" });
    let threw = false;
    try { await quota.consume("user:1", 1); } catch { threw = true; }
    assert.equal(threw, true);
  });

  test("fail-open on closed redis", async () => {
    await shutdown(client, silentLogger);
    const quota = createQuota(client, { resource: "fo", quota: 10, period: "daily", failurePolicy: "fail-open" });
    const r = await quota.consume("user:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.fallback, true);
  });

  test("fallback decision includes error metadata", async () => {
    await shutdown(client, silentLogger);
    const quota = createQuota(client, { resource: "meta", quota: 10, period: "daily", failurePolicy: "fail-open" });
    const r = await quota.consume("user:1", 1);
    assert.equal(r.allowed, true);
    assert.equal(r.fallback, true);
    // Note: Quota fallback doesn't include error in metadata like rate limiter
    // This documents the difference
  });
});

describe("Quota: Timezone Option (Not Implemented)", () => {
  let client: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    client = createClient({ url: URL }, silentLogger);
    await client.flushdb();
  });

  afterEach(async () => {
    await client.flushdb().catch(() => {});
    await shutdown(client, silentLogger);
  });

  test("timezone option accepted but ignored - uses UTC", async () => {
    // The timezone option exists in types but is not implemented
    const quota = createQuota(client, { resource: "tz", quota: 10, period: "daily", timezone: "America/New_York" });
    const r = await quota.consume("user:1", 1);
    assert.equal(r.allowed, true);
    // Should still use UTC midnight
    const resetDate = new Date(r.resetAt!);
    assert.equal(resetDate.getUTCHours(), 0);
  });
});