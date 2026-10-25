import { test } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRedisCache, shutdown, silentLogger } from "../../dist/index.js";

test("cache stores and retrieves values with TTL", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await client.flushdb();
    await cache.set("greeting", { text: "hello" });
    assert.deepEqual(await cache.get("greeting"), { text: "hello" });
    await cache.invalidate("greeting");
    assert.equal(await cache.get("greeting"), null);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache getOrLoad caches loader results", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await client.flushdb();
    let calls = 0;
    const first = await cache.getOrLoad("loaded", async () => {
      calls += 1;
      return { value: calls };
    });
    const second = await cache.getOrLoad("loaded", async () => {
      calls += 1;
      return { value: calls };
    });
    assert.deepEqual(first, { value: 1 });
    assert.deepEqual(second, { value: 1 });
    assert.equal(calls, 1);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache protects against load stampede", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await client.flushdb();
    let calls = 0;
    const load = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return calls;
    };

    const values = await Promise.all([
      cache.getOrLoad("stampede", load),
      cache.getOrLoad("stampede", load),
      cache.getOrLoad("stampede", load),
    ]);

    assert.deepEqual(values, [1, 1, 1]);
    assert.equal(calls, 1);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache tag invalidation removes tagged keys", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await client.flushdb();
    await cache.set("alpha", 1, { tags: ["shared"] });
    await cache.set("beta", 2, { tags: ["shared", "other"] });
    await cache.set("gamma", 3, { tags: ["other"] });

    await cache.invalidateTag("shared");

    assert.equal(await cache.get("alpha"), null);
    assert.equal(await cache.get("beta"), null);
    assert.equal(await cache.get("gamma"), 3);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache wrap memoizes function results", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await client.flushdb();
    let calls = 0;
    const wrapped = cache.wrap((id: number) => `user:${id}`, async (id: number) => {
      calls += 1;
      return id * 10;
    });

    assert.equal(await wrapped(5), 50);
    assert.equal(await wrapped(5), 50);
    assert.equal(calls, 1);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache drops malformed recorded values", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await client.flushdb();
    await client.set("oneunit:cache:broken", "{bad json");
    assert.equal(await cache.get("broken"), null);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache invalidate missing tag is safe", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await client.flushdb();
    await assert.doesNotReject(() => cache.invalidateTag("missing"));
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache disabling stampede protection allows concurrent loaders", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await client.flushdb();
    let calls = 0;
    await Promise.all([
      cache.getOrLoad("no-coalesce", async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return calls;
      }, { stampedeProtection: false }),
      cache.getOrLoad("no-coalesce", async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return calls;
      }, { stampedeProtection: false }),
    ]);
    assert.equal(calls, 2);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache tag invalidation is idempotent and removes reverse indexes", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await client.flushdb();
    await cache.set("one", 1, { tags: ["x", "x"] });
    await cache.invalidateTag("x");
    await cache.invalidateTag("x");
    assert.equal(await cache.get("one"), null);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache write-through stores the writer result", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await client.flushdb();
    let writes = 0;
    const result = await cache.writeThrough("through", async () => {
      writes += 1;
      return { id: writes };
    });
    assert.deepEqual(result, { id: 1 });
    assert.deepEqual(await cache.get("through"), { id: 1 });
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("write-through propagates writer failures and preserves prior cache", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await client.flushdb();
    await cache.set("through-fail", { ok: true });
    await assert.rejects(
      () => cache.writeThrough("through-fail", async () => {
        throw new Error("database write failed");
      }),
      /database write failed/,
    );
    assert.deepEqual(await cache.get("through-fail"), { ok: true });
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("write-through supports tag invalidation", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await client.flushdb();
    await cache.writeThrough("through-tag", async () => ({ version: 1 }), { tags: ["user:1"] });
    await cache.invalidateTag("user:1");
    assert.equal(await cache.get("through-tag"), null);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("write-through real-world update flow", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  const db = new Map<number, { name: string; version: number }>();

  try {
    await client.flushdb();

    const loadUser = async (id: number) => {
      return cache.getOrLoad(`user:${id}`, async () => db.get(id) ?? { name: "unknown", version: 0 });
    };

    const updateUser = (id: number, name: string) =>
      cache.writeThrough(`user:${id}`, async () => {
        const current = db.get(id) ?? { name: "unknown", version: 0 };
        const next = { name, version: current.version + 1 };
        db.set(id, next);
        return next;
      });

    assert.deepEqual(await loadUser(1), { name: "unknown", version: 0 });
    await updateUser(1, "Ada");
    assert.deepEqual(await loadUser(1), { name: "Ada", version: 1 });
    await updateUser(1, "Alan");
    assert.deepEqual(await cache.get("user:1"), { name: "Alan", version: 2 });
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache negative caching skips the loader for not-found results", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { negativeTtlSeconds: 5 });
  try {
    await client.flushdb();
    let calls = 0;
    const first = await cache.getOrLoad("not-there", async () => {
      calls += 1;
      return null;
    });
    assert.equal(first, null);
    assert.equal(calls, 1);

    const raw = await client.get("oneunit:cache:not-there");
    const record = JSON.parse(raw as string);
    assert.equal(record.negative, true);

    const second = await cache.getOrLoad("not-there", async () => {
      calls += 1;
      return null;
    });
    assert.equal(second, null);
    assert.equal(calls, 1);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache negative caching can be disabled per load", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { negativeTtlSeconds: 5 });
  try {
    await client.flushdb();
    let calls = 0;
    await cache.getOrLoad("opt-out", async () => {
      calls += 1;
      return null;
    }, { negativeCaching: false });
    assert.equal(calls, 1);
    await cache.getOrLoad("opt-out", async () => {
      calls += 1;
      return null;
    }, { negativeCaching: false });
    assert.equal(calls, 2);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache stale-while-revalidate serves stale and revalidates in background", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { staleWhileRevalidate: true });
  try {
    await client.flushdb();
    // Store an intentionally stale record: past its staleness window but still
    // within its TTL, so Redis hasn't evicted it yet.
    await client.set(
      "oneunit:cache:swr",
      JSON.stringify({ value: "stale", tags: [], storedAt: Date.now() - 250000, ttlSeconds: 300 }),
      "EX",
      300,
    );

    let revalidations = 0;
    const value = await cache.getOrLoad("swr", async () => {
      revalidations += 1;
      return "fresh";
    }, { staleWhileRevalidate: true });

    assert.equal(value, "stale");

    // Background revalidation should have fired shortly after.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(revalidations, 1);
    assert.deepEqual(await cache.get("swr"), "fresh");
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache warm populates without returning the value", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60 });
  try {
    await client.flushdb();
    let calls = 0;
    await cache.warm("warmed", async () => {
      calls += 1;
      return { cached: true };
    });
    assert.equal(calls, 1);
    assert.deepEqual(await cache.get("warmed"), { cached: true });
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache metrics track hits and misses", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { defaultTtlSeconds: 60, metrics: true });
  try {
    await client.flushdb();
    await cache.set("a", 1);
    assert.deepEqual(await cache.get("a"), 1);
    assert.equal(await cache.get("missing"), null);

    const m = cache.metrics();
    assert.equal(m.hits, 1);
    assert.equal(m.misses, 1);
    assert.equal(m.hitRate, 0.5);

    cache.resetMetrics();
    assert.deepEqual(cache.metrics(), { hits: 0, misses: 0, hitRate: 0, l1Hits: 0, l1Misses: 0, writeBehindFlushes: 0, writeBehindPending: 0 });
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("cache TTL jitter spreads expiry within the jitter band", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/8" }, silentLogger);
  const cache = createRedisCache(client, { jitter: 0.1 });
  try {
    await client.flushdb();
    await cache.set("jittered", 1, { ttlSeconds: 100 });
    const ttl = await client.ttl("oneunit:cache:jittered");
    assert.ok(ttl >= 85 && ttl <= 110, `expected jittered TTL near 100, got ${ttl}`);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});
