import { test } from "vitest";
import assert from "node:assert/strict";
import {
  buildKey,
  serialize,
  deserialize,
  jitterTtl,
  setIfAbsent,
  compareAndSwap,
  detectCapabilities,
} from "../../dist/features/core-helpers.js";
import { createClient, shutdown, silentLogger } from "../../dist/index.js";

test("buildKey joins validated segments", () => {
  assert.equal(buildKey("user", 42, "session"), "user:42:session");
  assert.throws(() => buildKey(""), /empty/i);
  assert.throws(() => buildKey(null as never), /null/i);
});

test("serialize and deserialize JSON values", () => {
  const value = { foo: 1, bar: "x" };
  const raw = serialize(value);
  assert.deepEqual(deserialize(raw), value);
  assert.equal(deserialize(null), null);
  assert.equal(deserialize(""), null);
});

test("jitterTtl bounds base ttl", () => {
  const value = jitterTtl(100, 0.1);
  assert.ok(value >= 90 && value <= 110);
  assert.throws(() => jitterTtl(0), /positive/i);
});


import assert from "node:assert/strict";

test("setIfAbsent behaves as an atomic write gate", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/3" }, silentLogger);
  try {
    await client.flushdb();
    assert.equal(await setIfAbsent(client, "cas:key", "first", { ttlSeconds: 60 }), true);
    assert.equal(await setIfAbsent(client, "cas:key", "second"), false);
    assert.equal(await client.get("cas:key"), "first");
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("compareAndSwap swaps only from the expected value", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/3" }, silentLogger);
  try {
    await client.flushdb();
    await client.set("cas:counter", "1");
    assert.equal(await compareAndSwap(client, "cas:counter", "1", "2", { ttlSeconds: 60 }), true);
    assert.equal(await client.get("cas:counter"), "2");
    assert.equal(await compareAndSwap(client, "cas:counter", "stale", "3"), false);
    assert.equal(await client.get("cas:counter"), "2");
    assert.equal(await compareAndSwap(client, "cas:missing", null, "created"), true);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("compareAndSwap handles concurrent writers deterministically", async () => {
  const clientA = createClient({ url: "redis://127.0.0.1:6379/3" }, silentLogger);
  const clientB = createClient({ url: "redis://127.0.0.1:6379/3" }, silentLogger);
  try {
    await clientA.flushdb();
    await clientA.set("cas:lock", "0");

    const results = await Promise.all([
      compareAndSwap(clientA, "cas:lock", "0", "writer-a"),
      compareAndSwap(clientB, "cas:lock", "0", "writer-b"),
    ]);

    assert.equal(results.filter(Boolean).length, 1);
    const winner = await clientA.get("cas:lock");
    assert.ok(winner === "writer-a" || winner === "writer-b");
  } finally {
    await clientA.flushdb().catch(() => undefined);
    await shutdown(clientA, silentLogger);
    await shutdown(clientB, silentLogger);
  }
});

test("detectCapabilities reports a connected Redis server", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/3" }, silentLogger);
  try {
    const caps = await detectCapabilities(client);
    assert.ok(caps.version);
    assert.equal(caps.hasStreams, true);
  } finally {
    await shutdown(client, silentLogger);
  }
});

test("setIfAbsent validates TTL", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/7" }, silentLogger);
  try {
    await assert.rejects(() => setIfAbsent(client, "k", "v", { ttlSeconds: 0 }), /positive finite/);
    await assert.rejects(() => setIfAbsent(client, "k", "v", { ttlSeconds: NaN }), /positive finite/);
  } finally {
    await shutdown(client, silentLogger);
  }
});

test("compareAndSwap validates TTL", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/7" }, silentLogger);
  try {
    await client.flushdb();
    await assert.rejects(() => compareAndSwap(client, "k", null, "v", { ttlSeconds: 0 }), /positive finite/);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("deserialize returns null for malformed input", () => {
  assert.equal(deserialize("{bad"), null);
  assert.equal(deserialize("null"), null);
});
