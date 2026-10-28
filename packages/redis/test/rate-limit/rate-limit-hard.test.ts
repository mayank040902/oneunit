import { test } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRateLimiter, createQuota, createConcurrencyLimiter, createMultiRateLimiter, shutdown, silentLogger } from "@oneunit/redis";

const URL = "redis://127.0.0.1:6379/9";

test("hard rate: fixed exact boundary and retry", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const rl = createRateLimiter(c, { algorithm: "fixed-window", limit: 2, intervalMs: 5000 });
    const a = await rl.consume("k", 1);
    const b = await rl.consume("k", 1);
    const d = await rl.consume("k", 1);
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, true);
    assert.equal(d.allowed, false);
    assert.ok((d.retryAfterMs ?? 0) >= 0);
    assert.ok(d.resetAt !== null);
    await rl.reset("k");
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("hard rate: fixed weighted and invalid", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const rl = createRateLimiter(c, { algorithm: "fixed-window", limit: 5, intervalMs: 5000 });
    await assert.rejects(() => rl.consume("k", 0), /weight must be/);
    const r = await rl.consume("k", 6);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "cost_exceeds_limit");
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("hard rate: token bucket refill and capacity", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const rl = createRateLimiter(c, { algorithm: "token-bucket", limit: 4, intervalMs: 10000, tokenBucket: { capacity: 4, refillRatePerSecond: 1, initialTokens: 4 } });
    const r1 = await rl.consume("k", 4);
    assert.equal(r1.allowed, true);
    const r2 = await rl.consume("k", 1);
    assert.equal(r2.allowed, false);
    // refill is time-based; cannot assert deterministically without time control, but ensure no negative remaining
    assert.ok(r2.remaining >= 0);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("hard rate: sliding window repeated same key", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const rl = createRateLimiter(c, { algorithm: "sliding-window", limit: 3, intervalMs: 10000 });
    const r1 = await rl.consume("k", 2);
    const r2 = await rl.consume("k", 2);
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, false);
    const rem = r2.remaining;
    assert.ok(rem >= 0 && rem <= 3);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("hard rate: leaky bucket", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const rl = createRateLimiter(c, { algorithm: "leaky-bucket", limit: 3, intervalMs: 10000, leakyBucket: { capacity: 3, leakRatePerSecond: 1 } });
    const r1 = await rl.consume("k", 2);
    const r2 = await rl.consume("k", 2);
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, false);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("hard rate: check does not consume", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const rl = createRateLimiter(c, { algorithm: "fixed-window", limit: 2, intervalMs: 10000 });
    await rl.consume("k", 1);
    const chk = await rl.check("k", 1);
    assert.equal(chk.remaining, 1, "consume should not have happened");
    const after = await rl.consume("k", 1);
    assert.equal(after.allowed, true);
    assert.equal(after.remaining, 0);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("hard rate: multi-dimensional denial", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const a = createRateLimiter(c, { algorithm: "fixed-window", limit: 1, intervalMs: 10000, keyPrefix: "rla" });
    const b = createRateLimiter(c, { algorithm: "fixed-window", limit: 10, intervalMs: 10000, keyPrefix: "rlb" });
    const multi = createMultiRateLimiter([a, b]);
    await a.consume("u", 1); // exhaust a
    const res = await multi.consume("u", 1);
    assert.equal(res.allowed, false);
    assert.equal(res.decisions.length, 2);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("hard rate: concurrency max", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const cl = createConcurrencyLimiter(c, { resource: "cc", maxConcurrency: 2, leaseMs: 5000 });
    const a = await cl.acquire("o1");
    const b = await cl.acquire("o2");
    assert.equal(a.acquired, true);
    assert.equal(b.acquired, true);
    const c3 = await cl.tryAcquire("o3");
    assert.equal(c3.acquired, false);
    await cl.release(a.token!);
    await cl.release(b.token!);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("hard rate: concurrency duplicate release", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const cl = createConcurrencyLimiter(c, { resource: "ccd", maxConcurrency: 1, leaseMs: 5000 });
    const a = await cl.acquire("o1");
    const r1 = await cl.release(a.token!);
    const r2 = await cl.release(a.token!);
    assert.equal(r1.released, true);
    assert.equal(r2.released, false);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("hard rate: fail-closed on closed redis", async () => {
  const c = createClient({ url: URL }, silentLogger);
  await c.flushdb().catch(()=>{});
  await shutdown(c, silentLogger);
  const rl = createRateLimiter(c, { algorithm: "fixed-window", limit: 2, intervalMs: 1000, failurePolicy: "fail-closed" });
  let threw = false;
  try { await rl.consume("k", 1); } catch { threw = true; }
  assert.equal(threw, true);
});

test("hard rate: fail-open on closed redis", async () => {
  const c = createClient({ url: URL }, silentLogger);
  await c.flushdb().catch(()=>{});
  await shutdown(c, silentLogger);
  const rl = createRateLimiter(c, { algorithm: "fixed-window", limit: 2, intervalMs: 1000, failurePolicy: "fail-open" });
  const r = await rl.consume("k", 1);
  assert.equal(r.allowed, true);
  assert.equal(r.fallback, true);
});

test("hard rate: quota custom period and exhaustion", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const q = createQuota(c, { resource: "q", quota: 3, period: "custom", customPeriodMs: 60000, weight: 2 });
    const r1 = await q.consume("u", 1);
    assert.equal(r1.allowed, true);
    const r2 = await q.consume("u", 1);
    assert.equal(r2.allowed, false);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("hard rate: monthly quota consumes", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const q = createQuota(c, { resource: "qm", quota: 5, period: "monthly" });
    const r = await q.consume("u", 3);
    assert.equal(r.allowed, true);
    assert.ok(r.resetAt !== null);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});
