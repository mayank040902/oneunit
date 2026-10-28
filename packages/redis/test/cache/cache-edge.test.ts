import { test } from "vitest";
import assert from "node:assert/strict";
import { createClient, createRedisCache, shutdown, silentLogger } from "@oneunit/redis";

test("cache edge: invalid jitter rejects", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/7" }, silentLogger);
  try {
    assert.throws(() => createRedisCache(client, { jitter: 1.5 }), /jitter must be between/);
    assert.throws(() => createRedisCache(client, { jitter: -0.1 }), /jitter must be between/);
  } finally { await shutdown(client, silentLogger); }
});

test("cache edge: negative caching distinguishes not found", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/7" }, silentLogger);
  try {
    await client.flushdb();
    const cache = createRedisCache(client, { negativeTtlSeconds: 2, defaultTtlSeconds: 10 });
    const r1 = await cache.getOrLoad("missing", async () => null);
    assert.equal(r1, null);
    let calls = 0;
    const r2 = await cache.getOrLoad("missing", async () => { calls++; return "x"; });
    assert.equal(r2, null);
    assert.equal(calls, 0, "negative cache suppresses loader");
    await cache.shutdown();
  } finally { await client.flushdb().catch(() => {}); await shutdown(client, silentLogger); }
});
