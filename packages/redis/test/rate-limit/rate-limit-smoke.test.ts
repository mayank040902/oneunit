import { test } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRateLimiter, createQuota, createConcurrencyLimiter, shutdown, silentLogger } from "@oneunit/redis";

const URL = "redis://127.0.0.1:6379/8";

test("rate-limit smoke: fixed window", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const rl = createRateLimiter(c, { algorithm: "fixed-window", limit: 2, intervalMs: 10000 });
    const r1 = await rl.consume("k", 1);
    const r2 = await rl.consume("k", 1);
    const r3 = await rl.consume("k", 1);
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, true);
    assert.equal(r3.allowed, false);
    await rl.reset("k");
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("rate-limit smoke: token bucket burst", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const rl = createRateLimiter(c, { algorithm: "token-bucket", limit: 5, intervalMs: 10000, tokenBucket: { capacity: 5, refillRatePerSecond: 1 } });
    const r1 = await rl.consume("k", 3);
    const r2 = await rl.consume("k", 3);
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, false);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("rate-limit smoke: sliding window", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const rl = createRateLimiter(c, { algorithm: "sliding-window", limit: 2, intervalMs: 10000 });
    const r1 = await rl.consume("k", 1);
    const r2 = await rl.consume("k", 2);
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, false);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("rate-limit smoke: leaky bucket", async () => {
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

test("rate-limit: quota daily", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const q = createQuota(c, { resource: "q", quota: 3, period: "daily" });
    const r1 = await q.consume("u", 2);
    const r2 = await q.consume("u", 2);
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, false);
    assert.ok(r2.resetAt !== null);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("rate-limit: concurrency", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const cl = createConcurrencyLimiter(c, { resource: "cc", maxConcurrency: 1, leaseMs: 5000 });
    const a = await cl.acquire("o1");
    assert.equal(a.acquired, true);
    const b = await cl.tryAcquire("o2");
    assert.equal(b.acquired, false);
    await cl.release(a.token!);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("rate-limit: weighted consumes multiple", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const rl = createRateLimiter(c, { algorithm: "fixed-window", limit: 5, intervalMs: 10000 });
    const r1 = await rl.consume("k", 3);
    const r2 = await rl.consume("k", 3);
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, false);
    assert.equal(r1.remaining, 2);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});
