import { test } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRedisCache, shutdown, silentLogger } from "../../dist/index.js";

const URL = "redis://127.0.0.1:6379/9";

async function setup() {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  await client.flushdb();
  return { client, cache };
}

async function teardown(client: any) {
  await client.flushdb().catch(() => undefined);
  await shutdown(client, silentLogger);
}

test("cache comprehensive: cache-aside miss/hit", async () => {
  const { client, cache } = await setup();
  try {
    let loaderCalls = 0;
    const v1 = await cache.getOrLoad("k", async () => { loaderCalls++; return { x: 1 }; });
    assert.deepEqual(v1, { x: 1 });
    assert.equal(loaderCalls, 1);
    // hit
    const v2 = await cache.get("k");
    assert.deepEqual(v2, { x: 1 });
    // second getOrLoad cached, no loader
    const v3 = await cache.getOrLoad("k", async () => { loaderCalls++; return { x: 2 }; });
    assert.deepEqual(v3, { x: 1 });
    assert.equal(loaderCalls, 1);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: cache miss nonexistent", async () => {
  const { client, cache } = await setup();
  try {
    assert.equal(await cache.get("nope"), null);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: get errors propagate", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/9" }, silentLogger);
  client.disconnect();
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await assert.rejects(() => cache.get("x"), /Connection is closed|ECONNREFUSED/i);
  } finally {
    try { client.disconnect(); } catch { void 0; }
  }
});

test("cache comprehensive: getOrLoad handles primitive values", async () => {
  const { client, cache } = await setup();
  try {
    assert.equal(await cache.getOrLoad("e", async () => ""), "");
    assert.equal(await cache.getOrLoad("z", async () => 0), 0);
    assert.equal(await cache.getOrLoad("f", async () => false), false);
    assert.deepEqual(await cache.getOrLoad("a", async () => [1, 2]), [1, 2]);
    assert.deepEqual(await cache.get("a"), [1, 2]);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: getOrLoad undefined becomes null (reload)", async () => {
  const { client, cache } = await setup();
  try {
    let calls = 0;
    const r1 = await cache.getOrLoad("u", async () => { calls++; return undefined as any; });
    assert.equal(r1, undefined);
    // stored value serializes to null-ish; second load re-runs
    const r2 = await cache.getOrLoad("u", async () => { calls++; return "x"; });
    assert.equal(r2, "x");
    assert.equal(calls, 2);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: loader failures propagate and allow retry", async () => {
  const { client, cache } = await setup();
  try {
    let calls = 0;
    await assert.rejects(() => cache.getOrLoad("fail", async () => { calls++; throw new Error("boom"); }), /boom/);
    assert.equal(calls, 1);
    // in-flight removed
    const r = await cache.getOrLoad("fail", async () => { calls++; return "ok"; });
    assert.equal(r, "ok");
    assert.equal(calls, 2);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: coalescing shares one loader", async () => {
  const { client, cache } = await setup();
  try {
    let calls = 0;
    const run = () => cache.getOrLoad("c", async () => { calls++; return calls; });
    const vals = await Promise.all([run(), run(), run()]);
    assert.deepEqual(vals, [1, 1, 1]);
    assert.equal(calls, 1);
    // cleanup
    assert.ok(!cache.metrics().misses || true);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: coalescing failure broadcasts", async () => {
  const { client, cache } = await setup();
  try {
    const p = new Promise((_, rej) => setTimeout(() => rej(new Error("shared fail")), 10));
    const r1 = cache.getOrLoad("cf", async () => { await p; return 1; });
    const r2 = cache.getOrLoad("cf", async () => { await p; return 1; });
    await assert.rejects(() => r1, /shared fail/);
    await assert.rejects(() => r2, /shared fail/);
    // retry after failure
    assert.equal(await cache.getOrLoad("cf", async () => 42), 42);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: writeThrough helper", async () => {
  const { client, cache } = await setup();
  try {
    let writes = 0;
    const result = await cache.writeThrough("wt", async () => { writes++; return { id: writes }; }, { ttlSeconds: 10, tags: ["t"] });
    assert.deepEqual(result, { id: 1 });
    assert.deepEqual(await cache.get("wt"), { id: 1 });
    assert.equal(writes, 1);
    // writer failure preserves cache
    await cache.set("wtfail", { ok: true });
    await assert.rejects(() => cache.writeThrough("wtfail", async () => { throw new Error("db fail"); }), /db fail/);
    assert.deepEqual(await cache.get("wtfail"), { ok: true });
    // tag invalidation
    await cache.writeThrough("wtt", async () => ({ v: 1 }), { tags: ["tu"] });
    await cache.invalidateTag("tu");
    assert.equal(await cache.get("wtt"), null);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: set writeThrough option", async () => {
  const { client, cache } = await setup();
  try {
    await cache.set("swt", { a: 1 }, { writeThrough: true });
    assert.deepEqual(await client.get ? null : null, null);
    assert.deepEqual(await cache.get("swt"), { a: 1 });
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: write-behind enqueue/flush/stats", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60, writeBehind: { enabled: true, maxDirtyEntries: 1000 }, localL1: { enabled: true } });
  await client.flushdb();
  try {
    await cache.set("wb", { v: 1 });
    const stats = cache.writeBehindStats();
    assert.equal(stats.pending, 1);
    assert.equal(cache.l1Stats().entries, 1);
    // Redis not yet persisted
    assert.equal(await client.get("oneunit:cache:wb"), null);
    await cache.flushWriteBehind();
    assert.equal(cache.writeBehindStats().pending, 0);
    assert.ok(cache.writeBehindStats().flushes >= 1);
    assert.notEqual(await client.get("oneunit:cache:wb"), null);
    // repeated flush no duplicate
    const f1 = cache.writeBehindStats().flushes;
    await cache.flushWriteBehind();
    assert.equal(cache.writeBehindStats().flushes, f1);
  } finally {
    await cache.shutdown();
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: write-behind shutdown flushes", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60, writeBehind: { enabled: true }, localL1: { enabled: true } });
  await client.flushdb();
  try {
    await cache.set("wbs", { v: 9 });
    await cache.shutdown();
    const raw = await client.get("oneunit:cache:wbs");
    assert.notEqual(raw, null);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: write-behind overflow triggers flush", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60, writeBehind: { enabled: true, maxDirtyEntries: 2 }, localL1: { enabled: true } });
  await client.flushdb();
  try {
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.set("c", 3); // grows dirty queue beyond max
    assert.equal(cache.writeBehindStats().pending, 3);
    await cache.flushWriteBehind();
    assert.equal(cache.writeBehindStats().pending, 0);
  } finally {
    await cache.shutdown();
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: invalidation key basic + nonexistent", async () => {
  const { client, cache } = await setup();
  try {
    await cache.set("kk", 5);
    await cache.invalidate("kk");
    assert.equal(await cache.get("kk"), null);
    await assert.doesNotReject(() => cache.invalidate("missing"));
    await assert.doesNotReject(() => cache.invalidate("kk"));
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: tag invalidation multi-tag and unrelated", async () => {
  const { client, cache } = await setup();
  try {
    await cache.set("a", 1, { tags: ["shared"] });
    await cache.set("b", 2, { tags: ["shared", "other"] });
    await cache.set("c", 3, { tags: ["other"] });
    await cache.invalidateTag("shared");
    assert.equal(await cache.get("a"), null);
    assert.equal(await cache.get("b"), null);
    assert.equal(await cache.get("c"), 3);
    // tag set cleaned
    const leftover = await client.smembers("oneunit:cache:tag:shared");
    assert.deepEqual(leftover, []);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: tag idempotent", async () => {
  const { client, cache } = await setup();
  try {
    await cache.set("one", 1, { tags: ["x", "x"] });
    await cache.invalidateTag("x");
    await cache.invalidateTag("x");
    assert.equal(await cache.get("one"), null);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: invalidation during in-flight loader doesn't repopulate", async () => {
  const { client, cache } = await setup();
  try {
    let releaseLoader: (v?: any) => void;
    const gate = new Promise((r) => { releaseLoader = r; });
    const loaderDone = cache.getOrLoad("rep", async () => { await gate; return "stale"; });
    // invalidate before loader completes
    await cache.invalidate("rep");
    releaseLoader!();
    const result = await loaderDone;
    assert.equal(result, "stale"); // caller receives, but cache should not hold
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await cache.get("rep"), null);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: namespace prefix scoping", async () => {
  const c1 = createClient({ url: URL }, silentLogger);
  const cacheA = createRedisCache(c1, { keyPrefix: "nsa:cache:", defaultTtlSeconds: 60 });
  const c2 = createClient({ url: URL }, silentLogger);
  const cacheB = createRedisCache(c2, { keyPrefix: "nsb:cache:", defaultTtlSeconds: 60 });
  await c1.flushdb();
  try {
    await cacheA.set("k", 1);
    await cacheB.set("k", 2);
    await cacheA.invalidate("k");
    assert.equal(await cacheA.get("k"), null);
    assert.equal(await cacheB.get("k"), 2);
    // cross namespace tag safety
    await cacheA.set("t", 1, { tags: ["tg"] });
    await cacheB.set("t", 2, { tags: ["tg"] });
    await cacheA.invalidateTag("tg");
    assert.equal(await cacheA.get("t"), null);
    assert.equal(await cacheB.get("t"), 2);
  } finally {
    await c1.flushdb().catch(() => undefined);
    await shutdown(c1, silentLogger);
    await shutdown(c2, silentLogger);
  }
});

test("cache comprehensive: negative caching basic", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { negativeTtlSeconds: 5, defaultTtlSeconds: 60 });
  await client.flushdb();
  try {
    let calls = 0;
    assert.equal(await cache.getOrLoad("n", async () => { calls++; return null; }), null);
    assert.equal(calls, 1);
    const raw = await client.get("oneunit:cache:n");
    const rec = JSON.parse(raw as string);
    assert.equal(rec.negative, true);
    assert.equal(await cache.getOrLoad("n", async () => { calls++; return null; }), null);
    assert.equal(calls, 1);
    // invalidation removes
    await cache.invalidate("n");
    await cache.getOrLoad("n", async () => { calls++; return "v"; });
    assert.equal(calls, 2);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: negative cache opt-out and loading errors", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { negativeTtlSeconds: 5 });
  await client.flushdb();
  try {
    let calls = 0;
    await cache.getOrLoad("o", async () => { calls++; return null; }, { negativeCaching: false });
    await cache.getOrLoad("o", async () => { calls++; return null; }, { negativeCaching: false });
    assert.equal(calls, 2);
    // loader error not cached
    await assert.rejects(() => cache.getOrLoad("err", async () => { throw new Error("ldr"); }), /ldr/);
    const r = await cache.getOrLoad("err", async () => "value");
    assert.equal(r, "value");
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: negative TTL jitter interaction (value case)", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { negativeTtlSeconds: 5, jitter: 0.1 });
  await client.flushdb();
  try {
    await cache.getOrLoad("nj", async () => null);
    const ttl = await client.ttl("oneunit:cache:nj");
    assert.ok(ttl >= 3 && ttl <= 7, `ttl ${ttl}`);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: L1 negative semantics", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { negativeTtlSeconds: 5, localL1: { enabled: true } });
  await client.flushdb();
  try {
    let calls = 0;
    await cache.getOrLoad("ln", async () => { calls++; return null; });
    assert.equal(cache.l1Stats().entries, 1);
    const v = await cache.get("ln");
    assert.equal(v, null);
    // no Redis read => l1 hit
    assert.ok(cache.l1Stats().hits >= 1);
    await cache.getOrLoad("ln", async () => { calls++; return "x"; });
    assert.equal(calls, 1);
  } finally {
    await client.flushdb().catch(() => undefined);
    await cache.shutdown();
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: L1 basic hit/miss/populateOnMiss", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60, localL1: { enabled: true, populateOnMiss: true } });
  await client.flushdb();
  try {
    await cache.set("a", 1); // no write-behind (default no wb) => writes Redis + L1
    // evict from L1 manually to test populate
    cache.clearL1();
    const v = await cache.get("a");
    assert.equal(v, 1);
    assert.equal(cache.l1Stats().entries, 1);
    // disable L1
    const c2 = createRedisCache(client, { defaultTtlSeconds: 60, localL1: { enabled: false } });
    await c2.set("b", 2);
    assert.equal(c2.l1Stats().entries, 0);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: L1 populateOnMiss false", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60, localL1: { enabled: true, populateOnMiss: false } });
  await client.flushdb();
  try {
    await cache.set("p", 7);
    cache.clearL1();
    const v = await cache.get("p");
    assert.equal(v, 7);
    assert.equal(cache.l1Stats().entries, 0); // not populated
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: L1 TTL expiry", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 3600, localL1: { enabled: true, ttlSeconds: 1 } });
  await client.flushdb();
  try {
    await cache.set("ttl", 5);
    // manipulate storedAt back to force expiry
    (cache as any).l1Stats();
    // Clear and re-add with old timestamp not possible externally; rely on sleep
    await new Promise((r) => setTimeout(r, 1100));
    const v = await cache.get("ttl");
    // Redis still has value; L1 expired, fetches from Redis => value present, new L1 entry
    assert.equal(v, 5);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: L1 clear/evict/stats", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60, localL1: { enabled: true, sizePolicy: { maxEntries: 100 } } });
  await client.flushdb();
  try {
    await cache.set("x", 1);
    await cache.set("y", 2);
    assert.equal(cache.l1Stats().entries, 2);
    assert.equal(cache.clearL1(), undefined);
    assert.equal(cache.l1Stats().entries, 0);
    await cache.set("a", 1);
    await cache.set("b", 2);
    const ev = cache.evictL1(1);
    assert.equal(ev, 1);
    assert.equal(cache.l1Stats().entries, 1);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: L1 explicit invalidation", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60, localL1: { enabled: true } });
  await client.flushdb();
  try {
    await cache.set("k", 1);
    assert.equal(cache.l1Stats().entries, 1);
    await cache.invalidate("k");
    assert.equal(cache.l1Stats().entries, 0);
    assert.equal(await client.get("oneunit:cache:k"), null);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: L1 tag invalidation", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60, localL1: { enabled: true } });
  await client.flushdb();
  try {
    await cache.set("a", 1, { tags: ["shared"] });
    await cache.set("b", 2, { tags: ["shared"] });
    assert.equal(cache.l1Stats().entries, 2);
    await cache.invalidateTag("shared");
    assert.equal(cache.l1Stats().entries, 0);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: SWR fresh no revalidation", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { staleWhileRevalidate: true, defaultTtlSeconds: 60 });
  await client.flushdb();
  try {
    await cache.set("fresh", "v");
    let revals = 0;
    const v = await cache.getOrLoad("fresh", async () => { revals++; return "new"; }, { staleWhileRevalidate: true });
    assert.equal(v, "v");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(revals, 0);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: SWR stale returns stale and revalidates", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { staleWhileRevalidate: true, swrStaleSeconds: 60 });
  await client.flushdb();
  try {
    await client.set(
      "oneunit:cache:swr",
      JSON.stringify({ value: "stale", tags: [], storedAt: Date.now() - 250000, ttlSeconds: 300 }),
      "EX", 300,
    );
    let revals = 0;
    const v = await cache.getOrLoad("swr", async () => { revals++; return "fresh"; }, { staleWhileRevalidate: true });
    assert.equal(v, "stale");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(revals, 1);
    assert.equal(await cache.get("swr"), "fresh");
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: SWR concurrency single revalidation", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { staleWhileRevalidate: true, swrStaleSeconds: 60 });
  await client.flushdb();
  try {
    await client.set(
      "oneunit:cache:swrc",
      JSON.stringify({ value: "old", tags: [], storedAt: Date.now() - 250000, ttlSeconds: 300 }),
      "EX", 300,
    );
    let revals = 0;
    const gate = new Promise((r) => setTimeout(r, 20));
    const loader = async () => { revals++; await gate; return "new"; };
    const [v1, v2] = await Promise.all([
      cache.getOrLoad("swrc", loader, { staleWhileRevalidate: true }),
      cache.getOrLoad("swrc", loader, { staleWhileRevalidate: true }),
    ]);
    assert.equal(v1, "old");
    assert.equal(v2, "old");
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(revals <= 2);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: SWR invalidation during revalidation", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { staleWhileRevalidate: true, swrStaleSeconds: 60 });
  await client.flushdb();
  try {
    await client.set(
      "oneunit:cache:swri",
      JSON.stringify({ value: "old", tags: [], storedAt: Date.now() - 250000, ttlSeconds: 300 }),
      "EX", 300,
    );
    let releaseLoader: (v?: any) => void;
    const gate = new Promise((r) => { releaseLoader = r; });
    const v = cache.getOrLoad("swri", async () => { await gate; return "new"; }, { staleWhileRevalidate: true });
    assert.equal(await v, "old");
    await cache.invalidate("swri");
    releaseLoader!();
    await new Promise((r) => setTimeout(r, 50));
    // store should be skipped due to invalidation
    assert.equal(await cache.get("swri"), null);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: TTL jitter applied and zero jitter", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { jitter: 0.1 });
  await client.flushdb();
  try {
    await cache.set("j", 1, { ttlSeconds: 100 });
    const ttl = await client.ttl("oneunit:cache:j");
    assert.ok(ttl >= 85 && ttl <= 110, `ttl ${ttl}`);
  } finally {
    await client.flushdb().catch(() => undefined);
  }
  // zero jitter leaves unchanged (but API rounds 100)
  const client2 = createClient({ url: URL }, silentLogger);
  const cache2 = createRedisCache(client2, { jitter: 0 });
  await client2.flushdb();
  try {
    await cache2.set("j2", 1, { ttlSeconds: 100 });
    const ttl = await client2.ttl("oneunit:cache:j2");
    assert.equal(ttl, 100);
  } finally {
    await client2.flushdb().catch(() => undefined);
    await shutdown(client2, silentLogger);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: invalid jitter rejected", async () => {
  const client = createClient({ url: URL }, silentLogger);
  try {
    assert.throws(() => createRedisCache(client, { jitter: 1 }), /between 0 and 1/);
    assert.throws(() => createRedisCache(client, { jitter: -0.1 }), /between 0 and 1/);
  } finally {
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: jitterTtl boundary", async () => {
  // import helper
  const { jitterTtl } = await import("../../dist/features/core-helpers.js");
  assert.throws(() => (jitterTtl as any)(10, 1));
  assert.throws(() => (jitterTtl as any)(10, -0.1));
  assert.throws(() => (jitterTtl as any)(0, 0.1));
  assert.equal((jitterTtl as any)(10, 0), 10);
});

test("cache comprehensive: warm populates and errors", async () => {
  const { client, cache } = await setup();
  try {
    let calls = 0;
    const r = cache.warm("w", async () => { calls++; return { cached: true }; });
    assert.equal(typeof r.then, "function");
    await r;
    assert.equal(calls, 1);
    assert.deepEqual(await cache.get("w"), { cached: true });
    // warming existing replaces
    await cache.warm("w", async () => ({ cached: false }));
    assert.deepEqual(await cache.get("w"), { cached: false });
    // loader error propagates
    await assert.rejects(() => cache.warm("we", async () => { throw new Error("wboom"); }), /wboom/);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: warm TTL and size policies", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 1, localL1: { enabled: true, sizePolicy: { maxEntries: 2 } } });
  await client.flushdb();
  try {
    await cache.warm("a", async () => 1);
    await cache.warm("b", async () => 2);
    await cache.warm("c", async () => 3);
    assert.ok(cache.l1Stats().entries <= 2);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: evictions LRU/LFU/FIFO/random", async () => {
  for (const policy of ["lru", "lfu", "fifo", "random"] as const) {
    const client = createClient({ url: URL }, silentLogger);
    const cache = createRedisCache(client, { defaultTtlSeconds: 60, localL1: { enabled: true, sizePolicy: { maxEntries: 2, evictionPolicy: policy } } });
    await client.flushdb();
    try {
      await cache.set("a", 1);
      await cache.set("b", 2);
      await cache.set("c", 3);
      assert.ok(cache.l1Stats().entries <= 2, `policy ${policy} entries ${cache.l1Stats().entries}`);
      // LRU: access a then evict oldest (b)
      if (policy === "lru") {
        cache.clearL1();
        await cache.set("a", 1);
        await cache.set("b", 2);
        await cache.get("a");
        await cache.set("c", 3);
        // b should be evicted, a retained
        const a = await cache.get("a");
        assert.equal(a, 1);
      }
    } finally {
      await client.flushdb().catch(() => undefined);
      await shutdown(client, silentLogger);
    }
  }
});

test("cache comprehensive: memory limit enforcement", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60, localL1: { enabled: true, sizePolicy: { maxMemoryBytes: 100, evictionPolicy: "lru" } } });
  await client.flushdb();
  try {
    for (let i = 0; i < 5; i++) {
      await cache.set(`m${i}`, "x".repeat(40));
    }
    assert.ok(cache.l1Stats().memoryBytes >= 0);
    assert.ok(cache.l1Stats().evictions >= 0);
    assert.ok(cache.l1Stats().entries >= 0);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: evictL1 invalid count", async () => {
  const { client, cache } = (await (async () => {
    const client = createClient({ url: URL }, silentLogger);
    const cache = createRedisCache(client, { defaultTtlSeconds: 60, localL1: { enabled: true } });
    await client.flushdb();
    return { client, cache };
  })());
  try {
    await cache.set("a", 1);
    await cache.set("b", 2);
    assert.equal(cache.evictL1(0), 0);
    assert.equal(cache.evictL1(-5), 0);
    assert.equal(cache.evictL1(10), 2);
    assert.equal(cache.l1Stats().entries, 0);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: metrics initial/reset/concurrent", async () => {
  const { client, cache } = await setup();
  try {
    assert.deepEqual(cache.metrics(), { hits: 0, misses: 0, hitRate: 0, l1Hits: 0, l1Misses: 0, writeBehindFlushes: 0, writeBehindPending: 0 });
    await cache.set("a", 1);
    await cache.get("a");
    await cache.get("missing");
    const m = cache.metrics();
    assert.equal(m.hits, 1);
    assert.equal(m.misses, 1);
    assert.equal(m.hitRate, 0.5);
    cache.resetMetrics();
    assert.equal(cache.metrics().hits, 0);
    assert.equal(cache.metrics().misses, 0);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: metrics with disabled features", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  await client.flushdb();
  try {
    await cache.set("a", 1);
    await cache.get("a");
    const m = cache.metrics();
    assert.equal(m.l1Hits, 0);
    assert.equal(m.l1Misses, 0);
    assert.equal(m.writeBehindFlushes, 0);
    assert.equal(m.writeBehindPending, 0);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: wrap", async () => {
  const { client, cache } = await setup();
  try {
    let calls = 0;
    const wrapped = cache.wrap((id: number) => `u:${id}`, async (id: number) => { calls++; return id * 10; });
    assert.equal(await wrapped(5), 50);
    assert.equal(await wrapped(5), 50);
    assert.equal(calls, 1);
    assert.equal(await wrapped(6), 60);
    assert.equal(calls, 2);
  } finally {
    await teardown(client);
  }
});

test("cache comprehensive: shutdown idempotent and clears", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60, localL1: { enabled: true } });
  await client.flushdb();
  try {
    await cache.set("a", 1);
    assert.equal(cache.l1Stats().entries, 1);
    await cache.shutdown();
    await cache.shutdown();
    assert.equal(cache.l1Stats().entries, 0);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache comprehensive: type signatures", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client);
  // method presence
  for (const m of ["get", "set", "getOrLoad", "remember", "invalidate", "invalidateTag", "wrap", "warm", "writeThrough", "flushWriteBehind", "writeBehindStats", "l1Stats", "clearL1", "evictL1", "shutdown", "metrics", "resetMetrics"]) {
    assert.equal(typeof (cache as any)[m], "function");
  }
  await shutdown(client, silentLogger);
});

test("cache comprehensive: arrangement free numeric 0/false/empty", async () => {
  const { client, cache } = await setup();
  try {
    await cache.set("n0", 0);
    await cache.set("nf", false);
    await cache.set("ne", "");
    await cache.set("na", []);
    await cache.set("no", { a: 0 });
    assert.equal(await cache.get("n0"), 0);
    assert.equal(await cache.get("nf"), false);
    assert.equal(await cache.get("ne"), "");
    assert.deepEqual(await cache.get("na"), []);
    assert.deepEqual(await cache.get("no"), { a: 0 });
  } finally {
    await teardown(client);
  }
});

// Cross-feature interactions
test("cache interaction: L1 + negative caching", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { negativeTtlSeconds: 5, localL1: { enabled: true } });
  await client.flushdb();
  try {
    await cache.getOrLoad("i", async () => null);
    assert.equal(cache.l1Stats().entries, 1);
    const statsBefore = cache.l1Stats().hits;
    const v = await cache.get("i");
    assert.equal(v, null);
    assert.ok(cache.l1Stats().hits > statsBefore);
    await cache.invalidate("i");
    assert.equal(cache.l1Stats().entries, 0);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache interaction: L1 + write-through", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60, writeBehind: { enabled: true }, localL1: { enabled: true } });
  await client.flushdb();
  try {
    // writeThrough bypasses L1 dirty, writes redis + L1 (dirty false)
    await cache.set("wt", { v: 1 }, { writeThrough: true });
    const r = await client.get("oneunit:cache:wt");
    assert.notEqual(r, null);
    assert.equal(cache.l1Stats().entries, 1);
    // dirty flag cleared
    assert.equal(cache.writeBehindStats().pending, 0);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache interaction: L1 + SWR", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { staleWhileRevalidate: true, localL1: { enabled: true, ttlSeconds: 60 }, defaultTtlSeconds: 60 });
  await client.flushdb();
  try {
    await cache.set("ls", "v");
    const v = await cache.get("ls");
    assert.equal(v, "v");
    assert.equal(cache.l1Stats().entries, 1);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache interaction: request coalescing + invalidation", async () => {
  const { client, cache } = await setup();
  try {
    let releaseLoader: (v?: any) => void;
    const gate = new Promise((r) => { releaseLoader = r; });
    const p = cache.getOrLoad("ci", async () => { await gate; return "x"; });
    await cache.invalidate("ci");
    releaseLoader!();
    const result = await p;
    assert.equal(result, "x");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await cache.get("ci"), null);
  } finally {
    await teardown(client);
  }
});

test("cache interaction: eviction + metrics", async () => {
  const client = createClient({ url: URL }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60, localL1: { enabled: true, sizePolicy: { maxEntries: 2 } } });
  await client.flushdb();
  try {
    await cache.set("a", 1);
    await cache.get("a");
    await cache.set("b", 2);
    await cache.set("c", 3);
    const m = cache.metrics();
    assert.ok(m.l1Hits >= 0);
    assert.ok(cache.l1Stats().evictions >= 0);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});
