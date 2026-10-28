import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { createAdaptiveThrottler, createLoadShedder, createBackpressureController } from "../../dist/index.js";

describe("Adaptive Throttling", () => {
  test("normal load signal - no adjustment", () => {
    const throttler = createAdaptiveThrottler(100, { minLimit: 10, maxLimit: 200, samplingIntervalMs: 0 });
    const limit = throttler.sample(0.5); // 50% load - in middle band
    assert.equal(limit, 100);
  });

  test("sustained overload reduces limit", () => {
    const throttler = createAdaptiveThrottler(100, { minLimit: 10, maxLimit: 200, samplingIntervalMs: 0, maxAdjustmentPerStep: 5 });
    throttler.sample(0.9); // High load
    const limit = throttler.sample(0.9); // Second sample
    assert.ok(limit < 100, "Limit should decrease under sustained overload");
  });

  test("recovery after overload increases limit", () => {
    const throttler = createAdaptiveThrottler(50, { minLimit: 10, maxLimit: 200, samplingIntervalMs: 0, recoveryStep: 5 });
    throttler.sample(0.9); // High load
    throttler.sample(0.9); // Reduces
    const limit = throttler.sample(0.2); // Low load
    assert.ok(limit > 50, "Limit should increase during recovery");
  });

  test("min/max limit bounds respected", () => {
    const throttler = createAdaptiveThrottler(100, { minLimit: 10, maxLimit: 50, samplingIntervalMs: 0, maxAdjustmentPerStep: 100 });
    throttler.sample(0.9);
    throttler.sample(0.9);
    throttler.sample(0.9);
    assert.ok(throttler.getLimit() >= 10, "Should not go below minLimit");
    
    const throttler2 = createAdaptiveThrottler(10, { minLimit: 10, maxLimit: 50, samplingIntervalMs: 0, recoveryStep: 100 });
    throttler2.sample(0.1);
    throttler2.sample(0.1);
    assert.ok(throttler2.getLimit() <= 50, "Should not exceed maxLimit");
  });

  test("invalid/missing signals are clamped and processed", () => {
    const throttler = createAdaptiveThrottler(100, { minLimit: 10, maxLimit: 200, samplingIntervalMs: 0 });
    // NaN is treated as 0 load (clamped) -> recovery -> increases
    const afterNaN = throttler.sample(NaN);
    assert.ok(afterNaN >= 100);
    // Infinity clamped to 1 -> overload -> decreases from current
    const afterInf = throttler.sample(Infinity);
    assert.ok(afterInf <= afterNaN);
    // Negative clamped to 0 -> recovery
    const afterNeg = throttler.sample(-1);
    assert.ok(afterNeg >= afterInf);
  });

  test("sampling interval prevents rapid adjustments", () => {
    const now = Date.now();
    const throttler = createAdaptiveThrottler(100, { minLimit: 10, maxLimit: 200, samplingIntervalMs: 1000, maxAdjustmentPerStep: 5 });
    // Set lastSignal to before sampling interval
    (throttler as any).lastSignal = now - 2000;
    throttler.sample(0.9, now); // First sample - should adjust
    const limit1 = throttler.getLimit();
    assert.ok(limit1 < 100);
    throttler.sample(0.9, now + 500); // Within interval - no adjust
    assert.equal(throttler.getLimit(), limit1);
    throttler.sample(0.9, now + 2500); // After interval - should adjust again
    assert.ok(throttler.getLimit() < limit1);
  });

  test("hysteresis prevents oscillation", () => {
    const throttler = createAdaptiveThrottler(100, { minLimit: 10, maxLimit: 200, samplingIntervalMs: 0, hysteresis: 0.2 });
    // Load oscillates around 0.5 (middle band: 0.4+0.2=0.6 to 0.8)
    throttler.sample(0.65); // In middle band - no change
    assert.equal(throttler.getLimit(), 100);
    throttler.sample(0.75); // Still in middle band
    assert.equal(throttler.getLimit(), 100);
    throttler.sample(0.85); // Above 0.8 - decrease
    assert.ok(throttler.getLimit() < 100);
  });

  test("max adjustment per step limits change rate", () => {
    const throttler = createAdaptiveThrottler(100, { minLimit: 10, maxLimit: 200, samplingIntervalMs: 0, maxAdjustmentPerStep: 2 });
    throttler.sample(0.9);
    throttler.sample(0.9);
    throttler.sample(0.9);
    assert.ok(throttler.getLimit() >= 94, "Should not decrease more than 2 per step");
  });

  test("reset restores base limit", () => {
    const throttler = createAdaptiveThrottler(100, { minLimit: 10, maxLimit: 200, samplingIntervalMs: 0 });
    throttler.sample(0.9);
    throttler.sample(0.9);
    assert.ok(throttler.getLimit() < 100);
    throttler.reset();
    assert.equal(throttler.getLimit(), 100);
  });

  test("clamped load values", () => {
    const throttler = createAdaptiveThrottler(100, { minLimit: 10, maxLimit: 200, samplingIntervalMs: 0 });
    throttler.sample(1.5); // Clamped to 1
    throttler.sample(-0.5); // Clamped to 0
    // Should not crash
  });
});

describe("Load Shedding", () => {
  test("normal admission under limit", () => {
    const shedder = createLoadShedder(10, 100);
    const r = shedder.acquire(0);
    assert.equal(r.shed, false);
    assert.equal(shedder.getInFlight(), 1);
  });

  test("overload rejection for low priority", () => {
    const shedder = createLoadShedder(2, 100);
    shedder.acquire(0);
    shedder.acquire(0);
    const r = shedder.acquire(0); // Priority 0 < 5, should shed
    assert.equal(r.shed, true);
    assert.equal(r.reason, "overloaded");
    assert.equal(r.priority, 0);
  });

  test("high priority admitted during overload", () => {
    const shedder = createLoadShedder(2, 100);
    shedder.acquire(0);
    shedder.acquire(0);
    const r = shedder.acquire(10); // Priority 10 >= 5, should admit
    assert.equal(r.shed, false);
    assert.equal(shedder.getInFlight(), 3);
  });

  test("release decrements in-flight", () => {
    const shedder = createLoadShedder(2, 100);
    shedder.acquire(0);
    shedder.acquire(0);
    assert.equal(shedder.getInFlight(), 2);
    shedder.release();
    assert.equal(shedder.getInFlight(), 1);
  });

  test("release doesn't go below zero", () => {
    const shedder = createLoadShedder(2, 100);
    shedder.release();
    assert.equal(shedder.getInFlight(), 0);
  });

  test("priority clamped to non-negative", () => {
    const shedder = createLoadShedder(1, 100);
    shedder.acquire(0);
    const r = shedder.acquire(-10); // Clamped to 0
    assert.equal(r.shed, true);
  });

  test("queueThreshold option accepted but not used", () => {
    const shedder = createLoadShedder(10, 50); // queueThreshold=50
    // queueThreshold is accepted but doesn't affect logic
    const r = shedder.acquire(0);
    assert.equal(r.shed, false);
  });
});

describe("Backpressure Controller", () => {
  test("admits when under limit", async () => {
    const bp = createBackpressureController(5, 1000);
    const r = await bp.admit(1);
    assert.equal(r.admitted, true);
    assert.equal(r.waitMs, 0);
    assert.equal(bp.getPending(), 1);
  });

  test("waits when at limit", async () => {
    const bp = createBackpressureController(2, 1000);
    await bp.admit(1);
    await bp.admit(1);
    const start = Date.now();
    const r = await bp.admit(1, async (ms) => {
      await new Promise(resolve => setTimeout(resolve, ms));
    });
    const elapsed = Date.now() - start;
    assert.equal(r.admitted, false);
    assert.ok(elapsed >= 100, "Should have waited");
  });

  test("respects maxWaitMs", async () => {
    const bp = createBackpressureController(1, 50); // maxWaitMs=50
    await bp.admit(1);
    const start = Date.now();
    const r = await bp.admit(1, async (ms) => {
      await new Promise(resolve => setTimeout(resolve, ms));
    });
    const elapsed = Date.now() - start;
    assert.equal(r.admitted, false);
    assert.ok(elapsed >= 50 && elapsed <= 200, "Should respect maxWaitMs");
  });

  test("rejects immediately if no waitFn provided", async () => {
    const bp = createBackpressureController(1, 1000);
    await bp.admit(1);
    const r = await bp.admit(1);
    assert.equal(r.admitted, false);
    assert.equal(r.waitMs, 0);
  });

  test("admissionTimeoutMs option", async () => {
    const bp = createBackpressureController(2, 1000);
    const r = await bp.admit(1); // First admit
    assert.equal(r.admitted, true);
  });

  test("release decrements pending", async () => {
    const bp = createBackpressureController(2, 1000);
    await bp.admit(1);
    await bp.admit(1);
    assert.equal(bp.getPending(), 2);
    bp.release(1);
    assert.equal(bp.getPending(), 1);
  });

  test("release doesn't go below zero", async () => {
    const bp = createBackpressureController(2, 1000);
    bp.release(1);
    assert.equal(bp.getPending(), 0);
  });

  test("reset clears pending", async () => {
    const bp = createBackpressureController(2, 1000);
    await bp.admit(1);
    await bp.admit(1);
    bp.reset();
    assert.equal(bp.getPending(), 0);
  });

  test("weighted admission", async () => {
    const bp = createBackpressureController(5, 1000);
    const r = await bp.admit(3);
    assert.equal(r.admitted, true);
    assert.equal(bp.getPending(), 3);
    const r2 = await bp.admit(3); // Would exceed 5
    assert.equal(r2.admitted, false);
  });

  test("negative weight rejected", async () => {
    const bp = createBackpressureController(5, 1000);
    await assert.rejects(() => bp.admit(-1), /weight must be positive/);
    await assert.rejects(() => bp.admit(0), /weight must be positive/);
  });
});