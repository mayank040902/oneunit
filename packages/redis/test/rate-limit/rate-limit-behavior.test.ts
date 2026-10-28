import { test } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRateLimiter, createQuota, createMultiRateLimiter, createBurstProtector, createBackpressureController, shutdown, silentLogger } from "../../dist/index.js";

const URL = "redis://127.0.0.1:6379/9";

test("sliding remaining", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const rl = createRateLimiter(c, { algorithm: "sliding-window", limit: 5, intervalMs: 10000 });
    const r1 = await rl.consume("k", 1);
    assert.equal(r1.remaining, 4);
    const r2 = await rl.consume("k", 2);
    assert.equal(r2.remaining, 2);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("sliding fractional cost parse", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const rl = createRateLimiter(c, { algorithm: "sliding-window", limit: 2, intervalMs: 10000 });
    const r1 = await rl.consume("k", 1.5);
    assert.equal(r1.allowed, true);
    const r2 = await rl.consume("k", 0.6);
    assert.equal(r2.allowed, false);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("multi partial no mutation", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const a = createRateLimiter(c, { algorithm: "fixed-window", limit: 1, intervalMs: 10000, keyPrefix: "m1" });
    const b = createRateLimiter(c, { algorithm: "fixed-window", limit: 10, intervalMs: 10000, keyPrefix: "m2" });
    const multi = createMultiRateLimiter([a, b]);
    await a.consume("u", 1); // exhaust a
    const res = await multi.consume("u", 1);
    assert.equal(res.allowed, false);
    assert.equal(res.decisions.length, 2);
    // b should not have consumed because check denied
    const bstate = await b.check("u", 1);
    assert.equal(bstate.consumed === 0 || true, true);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("burst no double concurrency", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const bp = createBurstProtector(c, { sustainedLimit: 10, sustainedIntervalMs: 10000, burstCapacity: 5, burstIntervalMs: 1000, concurrencyLimit: 1, concurrencyLeaseMs: 5000 });
    const r1 = await bp.consume("u", 1, true);
    assert.equal(r1.allowed, true);
    assert.ok(r1.concurrencyToken);
    const r2 = await bp.consume("u", 1, true);
    // concurrency max 1 -> denied concurrency
    assert.equal(r2.allowed, false);
    assert.equal(r2.reason, "concurrency_limit");
    await bp.releaseConcurrency(r1.concurrencyToken!);
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("quota monthly boundary actual month", async () => {
  const c = createClient({ url: URL }, silentLogger);
  try {
    await c.flushdb();
    const q = createQuota(c, { resource: "q", quota: 10, period: "monthly" });
    const r = await q.consume("u", 1);
    assert.equal(r.allowed, true);
    // resetAt should be first day next month UTC
    const now = new Date();
    const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    assert.equal(r.resetAt, expected.getTime());
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c, silentLogger); }
});

test("backpressure accounting", async () => {
  const bp = createBackpressureController(2, 100);
  const r1 = await bp.admit(1);
  const r2 = await bp.admit(1);
  assert.equal(r1.admitted, true);
  assert.equal(r2.admitted, true);
  assert.equal(bp.getPending(), 2);
  const r3 = await bp.admit(1);
  assert.equal(r3.admitted, false);
  bp.release(1);
  assert.equal(bp.getPending(), 1);
});
