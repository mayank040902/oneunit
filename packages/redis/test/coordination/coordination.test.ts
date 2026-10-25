import { test } from "vitest";
import assert from "node:assert/strict";
import { createClient, createCoordinationClient, shutdown, silentLogger } from "../../dist/index.js";

function clients() {
  const a = createClient({ url: "redis://127.0.0.1:6379/7" }, silentLogger);
  const b = createClient({ url: "redis://127.0.0.1:6379/7" }, silentLogger);
  return { a, b };
}

test("lock: two clients cannot simultaneously acquire", async () => {
  const { a, b } = clients();
  try {
    await a.flushdb();
    const ca = createCoordinationClient({ client: a });
    const cb = createCoordinationClient({ client: b });
    const r1 = await ca.acquireLock({ resource: "lock1", leaseMs: 5000, timeoutMs: 200 });
    assert.equal(r1.acquired, true);
    const r2 = await cb.tryLock({ resource: "lock1", leaseMs: 5000 });
    assert.equal(r2.acquired, false);
    await ca.releaseLock({ resource: "lock1", token: r1.token });
  } finally {
    await a.flushdb().catch(() => {});
    await shutdown(a, silentLogger);
    await shutdown(b, silentLogger);
  }
});

test("lock: expired owner release cannot delete newer lock", async () => {
  const { a, b } = clients();
  try {
    await a.flushdb();
    const ca = createCoordinationClient({ client: a });
    const cb = createCoordinationClient({ client: b });
    const r1 = await ca.acquireLock({ resource: "lock2", leaseMs: 100, timeoutMs: 200 });
    assert.equal(r1.acquired, true);
    // wait expire
    await new Promise((r) => setTimeout(r, 200));
    const r2 = await cb.acquireLock({ resource: "lock2", leaseMs: 5000, timeoutMs: 200 });
    assert.equal(r2.acquired, true);
    const rel = await ca.releaseLock({ resource: "lock2", token: r1.token });
    assert.equal(rel.released, false);
    const st = await cb.getLockStatus("lock2");
    assert.equal(st.exists, true);
  } finally {
    await a.flushdb().catch(() => {});
    await shutdown(a, silentLogger);
    await shutdown(b, silentLogger);
  }
});

test("semaphore: capacity enforced", async () => {
  const { a, b } = clients();
  try {
    await a.flushdb();
    const ca = createCoordinationClient({ client: a });
    const cb = createCoordinationClient({ client: b });
    const s1 = await ca.acquireSemaphore({ resource: "sem", permits: 1, leaseMs: 5000, timeoutMs: 200 });
    const s2 = await cb.tryAcquireSemaphore({ resource: "sem", permits: 1, leaseMs: 5000 });
    assert.equal(s1.acquired, true);
    assert.equal(s2.acquired, false);
    await ca.releaseSemaphore({ resource: "sem", token: s1.token });
  } finally {
    await a.flushdb().catch(() => {});
    await shutdown(a, silentLogger);
    await shutdown(b, silentLogger);
  }
});

test("single-flight: followers receive result", async () => {
  const { a, b } = clients();
  try {
    await a.flushdb();
    const ca = createCoordinationClient({ client: a });
    const cb = createCoordinationClient({ client: b });
    const [r1, r2] = await Promise.all([
      ca.singleFlight({ key: "sf", leaseMs: 5000, execute: async () => { await new Promise((r) => setTimeout(r, 100)); return 7; } }),
      (async () => { await new Promise((r) => setTimeout(r, 20)); return cb.singleFlight({ key: "sf", leaseMs: 5000, execute: async () => 9 }); })(),
    ]);
    assert.equal(r1.value, 7);
    assert.equal(r2.value, 7);
    assert.equal(r1.isOwner, true);
    assert.equal(r2.isOwner, false);
  } finally {
    await a.flushdb().catch(() => {});
    await shutdown(a, silentLogger);
    await shutdown(b, silentLogger);
  }
});

test("barrier: concurrent arrivals release", async () => {
  const { a } = clients();
  try {
    await a.flushdb();
    const ca = createCoordinationClient({ client: a });
    const [r1, r2] = await Promise.all([
      ca.arriveBarrier({ barrierId: "bar", requiredCount: 2, participantId: "p1", timeoutMs: 5000 }),
      ca.arriveBarrier({ barrierId: "bar", requiredCount: 2, participantId: "p2", timeoutMs: 5000 }),
    ]);
    assert.equal(r1.released, true);
    assert.equal(r2.released, true);
    assert.equal(r1.participantCount, 2);
  } finally {
    await a.flushdb().catch(() => {});
    await shutdown(a, silentLogger);
  }
});

test("job claim: one successful owner", async () => {
  const { a, b } = clients();
  try {
    await a.flushdb();
    const ca = createCoordinationClient({ client: a });
    const cb = createCoordinationClient({ client: b });
    const [c1, c2] = await Promise.all([
      ca.claimJob({ jobId: "job", leaseMs: 5000, timeoutMs: 200 }),
      cb.claimJob({ jobId: "job", leaseMs: 5000, timeoutMs: 200 }),
    ]);
    const successes = [c1, c2].filter((c) => c.claimed).length;
    assert.equal(successes, 1);
  } finally {
    await a.flushdb().catch(() => {});
    await shutdown(a, silentLogger);
    await shutdown(b, silentLogger);
  }
});

test("leader: one leader at a time", async () => {
  const { a, b } = clients();
  try {
    await a.flushdb();
    const ca = createCoordinationClient({ client: a });
    const cb = createCoordinationClient({ client: b });
    const l1 = ca.createLeaderElection({ resource: "lead", leaseMs: 2000, candidateId: "c1" });
    const l2 = cb.createLeaderElection({ resource: "lead", leaseMs: 2000, candidateId: "c2" });
    await l1.start();
    await l2.start();
    // allow
    await new Promise((r) => setTimeout(r, 100));
    const leaders = [l1.isLeader(), l2.isLeader()].filter(Boolean).length;
    assert.equal(leaders, 1);
    await l1.stop();
    await l2.stop();
  } finally {
    await a.flushdb().catch(() => {});
    await shutdown(a, silentLogger);
    await shutdown(b, silentLogger);
  }
});

test("resource lease: fencing token present", async () => {
  const { a } = clients();
  try {
    await a.flushdb();
    const ca = createCoordinationClient({ client: a });
    const r = await ca.acquireLease({ resource: "res", leaseMs: 5000, timeoutMs: 200 });
    assert.equal(r.acquired, true);
    assert.ok(typeof r.fencingToken === "number");
    await ca.releaseLease({ resource: "res", token: r.token });
  } finally {
    await a.flushdb().catch(() => {});
    await shutdown(a, silentLogger);
  }
});
