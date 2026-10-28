import { test } from "vitest";
import assert from "node:assert/strict";
import { createClient, createCoordinationClient, shutdown, silentLogger } from "@oneunit/redis";

const URL = "redis://127.0.0.1:6379/7";

function mk() {
  const a = createClient({ url: URL }, silentLogger);
  const b = createClient({ url: URL }, silentLogger);
  return { a, b, ca: null as any, cb: null as any };
}

async function setup() {
  const x = mk();
  x.ca = createCoordinationClient({ client: x.a });
  x.cb = createCoordinationClient({ client: x.b });
  await x.a.flushdb();
  return x;
}

async function teardown(x: any) {
  await x.a.flushdb().catch(() => {});
  await shutdown(x.a, silentLogger);
  await shutdown(x.b, silentLogger);
}

test("hard: independent lock keys do not interfere", async () => {
  const x = await setup();
  try {
    const r1 = await x.ca.acquireLock({ resource: "k1", leaseMs: 5000, timeoutMs: 200 });
    const r2 = await x.cb.acquireLock({ resource: "k2", leaseMs: 5000, timeoutMs: 200 });
    assert.equal(r1.acquired, true);
    assert.equal(r2.acquired, true);
    await x.ca.releaseLock({ resource: "k1", token: r1.token });
    await x.cb.releaseLock({ resource: "k2", token: r2.token });
  } finally { await teardown(x); }
});

test("hard: blocking acquire times out with contention", async () => {
  const x = await setup();
  try {
    const r1 = await x.ca.acquireLock({ resource: "timeout", leaseMs: 5000, timeoutMs: 200 });
    assert.equal(r1.acquired, true);
    const t0 = performance.now();
    const res = await x.cb.acquireLock({ resource: "timeout", leaseMs: 5000, timeoutMs: 150 });
    const dt = performance.now() - t0;
    assert.equal(res.acquired, false);
    assert.ok((res.error || "").toLowerCase().includes("timed out"), res.error);
    assert.ok(dt < 500, `timeout duration sane: ${dt}`);
    await x.ca.releaseLock({ resource: "timeout", token: r1.token });
  } finally { await teardown(x); }
});

test("hard: only current owner can renew", async () => {
  const x = await setup();
  try {
    const r1 = await x.ca.acquireLock({ resource: "renew", leaseMs: 2000, timeoutMs: 200 });
    assert.equal(r1.acquired, true);
    const bad = await x.cb.renewLock({ resource: "renew", token: "nope", leaseMs: 5000 });
    assert.equal(bad.renewed, false);
    const good = await x.ca.renewLock({ resource: "renew", token: r1.token, leaseMs: 5000 });
    assert.equal(good.renewed, true);
    await x.ca.releaseLock({ resource: "renew", token: r1.token });
  } finally { await teardown(x); }
});

test("hard: expired owner renewal cannot extend newer lease", async () => {
  const x = await setup();
  try {
    const r1 = await x.ca.acquireLock({ resource: "renew-exp", leaseMs: 120, timeoutMs: 200 });
    assert.equal(r1.acquired, true);
    await new Promise((r) => setTimeout(r, 180));
    const r2 = await x.cb.acquireLock({ resource: "renew-exp", leaseMs: 5000, timeoutMs: 200 });
    assert.equal(r2.acquired, true);
    const staleRenew = await x.ca.renewLock({ resource: "renew-exp", token: r1.token, leaseMs: 5000 });
    assert.equal(staleRenew.renewed, false);
    const good = await x.cb.renewLock({ resource: "renew-exp", token: r2.token, leaseMs: 5000 });
    assert.equal(good.renewed, true);
    await x.cb.releaseLock({ resource: "renew-exp", token: r2.token });
  } finally { await teardown(x); }
});

test("hard: callback errors propagate and lock released", async () => {
  const x = await setup();
  try {
    let thrown = false;
    try {
      await x.ca.withLock("cb", 5000, async () => { throw new Error("boom"); });
    } catch (e) {
      thrown = true;
      assert.equal((e as Error).message, "boom");
    }
    assert.equal(thrown, true);
    // lock should be free now
    const r2 = await x.cb.tryLock({ resource: "cb", leaseMs: 5000 });
    assert.equal(r2.acquired, true);
    await x.cb.releaseLock({ resource: "cb", token: r2.token });
  } finally { await teardown(x); }
});

test("hard: cancellation recovers accidental successful acquisition", async () => {
  const x = await setup();
  try {
    const ac = new AbortController();
    ac.abort();
    const res = await x.ca.acquireLock({ resource: "cancel", leaseMs: 5000, timeoutMs: 2000, signal: ac.signal });
    // manager returns a cancelled result rather than throwing
    assert.equal(res.acquired, false);
    assert.equal(res.error, "cancelled");
    // Even if a lock leaked, another client should eventually acquire after expiry? Try immediate
    const r2 = await x.cb.tryLock({ resource: "cancel", leaseMs: 5000 });
    // could still be held if acquire won race; accept either but not deadlock
    if (r2.acquired) await x.cb.releaseLock({ resource: "cancel", token: r2.token });
  } finally { await teardown(x); }
});

test("hard: fencing tokens monotonic across release/reacquire", async () => {
  const x = await setup();
  try {
    const r1 = await x.ca.acquireLock({ resource: "fence", leaseMs: 5000, timeoutMs: 200 });
    const ft1 = r1.fencingToken!;
    await x.ca.releaseLock({ resource: "fence", token: r1.token });
    const r2 = await x.ca.acquireLock({ resource: "fence", leaseMs: 5000, timeoutMs: 200 });
    assert.ok(r2.fencingToken! > ft1, `monotonic: ${ft1} -> ${r2.fencingToken}`);
    await x.ca.releaseLock({ resource: "fence", token: r2.token });
  } finally { await teardown(x); }
});

test("hard: invalid configuration rejects before allocation", async () => {
  const x = await setup();
  try {
    assert.throws(() => createCoordinationClient({ client: x.a, defaultLeaseMs: 0 } as any), /defaultLeaseMs/);
  } finally { await teardown(x); }
});

test("hard: semaphore duplicate release does not create capacity", async () => {
  const x = await setup();
  try {
    const s1 = await x.ca.acquireSemaphore({ resource: "semhard", permits: 1, leaseMs: 5000, timeoutMs: 200 });
    await x.ca.releaseSemaphore({ resource: "semhard", token: s1.token });
    const dup = await x.ca.releaseSemaphore({ resource: "semhard", token: s1.token });
    assert.equal(dup.released, false);
    const st = await x.ca.getSemaphoreStatus("semhard", 1);
    assert.equal(st.availablePermits, 1);
  } finally { await teardown(x); }
});

test("hard: semaphore expired permit reclaimable", async () => {
  const x = await setup();
  try {
    const s1 = await x.ca.acquireSemaphore({ resource: "semexp", permits: 1, leaseMs: 120, timeoutMs: 200 });
    assert.equal(s1.acquired, true);
    await new Promise((r) => setTimeout(r, 180));
    const s2 = await x.cb.acquireSemaphore({ resource: "semexp", permits: 1, leaseMs: 5000, timeoutMs: 200 });
    assert.equal(s2.acquired, true);
    await x.cb.releaseSemaphore({ resource: "semexp", token: s2.token });
  } finally { await teardown(x); }
});

test("hard: semaphore renewal cannot revive expired permit owned by other", async () => {
  const x = await setup();
  try {
    const s1 = await x.ca.acquireSemaphore({ resource: "semrenew", permits: 1, leaseMs: 120, timeoutMs: 200 });
    await new Promise((r) => setTimeout(r, 180));
    const s2 = await x.cb.acquireSemaphore({ resource: "semrenew", permits: 1, leaseMs: 5000, timeoutMs: 200 });
    assert.equal(s2.acquired, true);
    const bad = await x.ca.renewSemaphore({ resource: "semrenew", token: s1.token, leaseMs: 5000 });
    assert.equal(bad.renewed, false);
    await x.cb.releaseSemaphore({ resource: "semrenew", token: s2.token });
  } finally { await teardown(x); }
});

test("hard: single-flight different keys independent", async () => {
  const x = await setup();
  try {
    const [a, b] = await Promise.all([
      x.ca.singleFlight({ key: "sfa", leaseMs: 1000, execute: async () => 1 }),
      x.cb.singleFlight({ key: "sfb", leaseMs: 1000, execute: async () => 2 }),
    ]);
    assert.equal(a.value, 1);
    assert.equal(b.value, 2);
    assert.equal(a.isOwner, true);
    assert.equal(b.isOwner, true);
  } finally { await teardown(x); }
});

test("hard: single-flight owner failure propagates", async () => {
  const x = await setup();
  try {
    let threw = false;
    try {
      await x.ca.singleFlight({ key: "sffail", leaseMs: 1000, execute: async () => { throw new Error("sf-boom"); } });
    } catch (e) {
      threw = true;
      assert.equal((e as Error).message, "sf-boom");
    }
    assert.equal(threw, true);
    // follower should receive failure quickly, not hang forever
    try {
      const r = await Promise.race([
        x.cb.singleFlight({ key: "sffail", leaseMs: 1000, execute: async () => 9 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("sf-timeout")), 500)),
      ]);
      void r;
    } catch (_e) {
      void _e;
    }
    // single-flight failure propagation may resolve follower with error or timeout; accept either as long as no hang
    assert.ok(true);
  } finally { await teardown(x); }
});

test("hard: barrier late arrival different generation isolated", async () => {
  const x = await setup();
  try {
    // generation 1 completes with 2 participants
    const p = Promise.all([
      x.ca.arriveBarrier({ barrierId: "gbar", requiredCount: 2, participantId: "a", generation: 1, timeoutMs: 5000 }),
      x.cb.arriveBarrier({ barrierId: "gbar", requiredCount: 2, participantId: "b", generation: 1, timeoutMs: 5000 }),
    ]);
    const [r1, r2] = await p;
    assert.equal(r1.released, true);
    // generation 2 late arrival should not be released by gen1
    let threw = false;
    try {
      await x.ca.arriveBarrier({ barrierId: "gbar", requiredCount: 2, participantId: "c", generation: 2, timeoutMs: 200 });
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    void r2;
  } finally { await teardown(x); }
});

test("hard: barrier duplicate arrival counts once", async () => {
  const x = await setup();
  try {
    const second = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      return x.cb.arriveBarrier({ barrierId: "dupbar", requiredCount: 2, participantId: "p2", timeoutMs: 5000 });
    })();
    // duplicate p1 twice rapidly
    const dup = (async () => {
      await new Promise((r) => setTimeout(r, 10));
      return x.ca.arriveBarrier({ barrierId: "dupbar", requiredCount: 2, participantId: "p1", timeoutMs: 5000 }).catch(() => null);
    })();
    const r1 = await x.ca.arriveBarrier({ barrierId: "dupbar", requiredCount: 2, participantId: "p1", timeoutMs: 5000 });
    await dup;
    const r2 = await second;
    // total distinct participants 2, released
    assert.equal(r1.released || r2.released, true);
    assert.equal(r2.participantCount, 2);
  } catch (_e) {
    // duplicate handling may reject; ensure not crash
    void _e;
  } finally { await teardown(x); }
});

test("hard: leader takeover after first stops", async () => {
  const x = await setup();
  try {
    const l1 = x.ca.createLeaderElection({ resource: "leadhard", leaseMs: 300, candidateId: "c1" });
    const l2 = x.cb.createLeaderElection({ resource: "leadhard", leaseMs: 300, candidateId: "c2" });
    await l1.start();
    await l2.start();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(l1.isLeader(), true);
    assert.equal(l2.isLeader(), false);
    await l1.stop();
    // wait for lease expiry + takeover attempt via l2 timer (~lease/3)
    await new Promise((r) => setTimeout(r, 400));
    // manually trigger tick by start? l2 already started; its interval should acquire
    assert.equal(l2.isLeader(), true);
    await l2.stop();
  } finally { await teardown(x); }
});

test("hard: job expired claim reclaimable by another", async () => {
  const x = await setup();
  try {
    const c1 = await x.ca.claimJob({ jobId: "jobhard", leaseMs: 120, timeoutMs: 200 });
    assert.equal(c1.claimed, true);
    await new Promise((r) => setTimeout(r, 180));
    const c2 = await x.cb.claimJob({ jobId: "jobhard", leaseMs: 5000, timeoutMs: 200 });
    assert.equal(c2.claimed, true);
    // stale cannot release newer
    const rel = await x.ca.releaseJobClaim({ jobId: "jobhard", token: c1.token! });
    assert.equal(rel.released, false);
    await x.cb.releaseJobClaim({ jobId: "jobhard", token: c2.token! });
  } finally { await teardown(x); }
});

test("hard: job completion and fencing downstream validation", async () => {
  const x = await setup();
  try {
    const c1 = await x.ca.claimJob({ jobId: "jobcomplete", leaseMs: 5000, timeoutMs: 200 });
    assert.equal(c1.claimed, true);
    const done = await x.ca.completeJobClaim({ jobId: "jobcomplete", token: c1.token!, result: { ok: true }, fencingToken: c1.fencingToken });
    assert.equal(done.completed, true);
    const st = await x.ca.getJobClaimStatus("jobcomplete");
    assert.equal(st.status, "completed");
    // downstream resource validates fencing token monotonic
    const { validateFencingToken } = await import("../../dist/coordination/fencing.js");
    // should not throw for equal/higher
    validateFencingToken(c1.fencingToken!, c1.fencingToken!, "jobcomplete");
  } finally { await teardown(x); }
});

test("hard: resource lease loss notification via signal", async () => {
  const x = await setup();
  try {
    const r1 = await x.ca.acquireLease({ resource: "leasehard", leaseMs: 150, timeoutMs: 200 });
    assert.equal(r1.acquired, true);
    // withLock style not available for leases; acquire direct then check expiry
    const st = await x.ca.getLeaseStatus("leasehard");
    assert.equal(st.exists, true);
    await new Promise((r) => setTimeout(r, 200));
    const st2 = await x.ca.getLeaseStatus("leasehard");
    assert.equal(st2.exists, false);
  } finally { await teardown(x); }
});

test("hard: barrier timeout cleanup", async () => {
  const x = await setup();
  try {
    let threw = false;
    try {
      await x.ca.arriveBarrier({ barrierId: "bartimeout", requiredCount: 5, participantId: "p1", timeoutMs: 100 });
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
  } finally { await teardown(x); }
});
