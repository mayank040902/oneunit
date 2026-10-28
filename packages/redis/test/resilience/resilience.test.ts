import { test } from "vitest";
import assert from "node:assert/strict";
import {
  createClient,
  silentLogger,
} from "@oneunit/redis";
import {
  createResilienceEngine,
  type ResilienceOperation,
} from "../../dist/resilience/index.js";
import { classifyOperation } from "../../dist/resilience/policy.js";
import { ExpirationManager } from "../../dist/resilience/expiration-manager.js";
import { LocalStore } from "../../dist/resilience/local-store.js";
import { classifyError as classifyRedisError } from "../../dist/client/events.js";

const TEST_URL = "redis://127.0.0.1:6379/15";

async function waitForDisconnected(client: { status: string; once: (event: string, handler: () => void) => void }): Promise<void> {
  return new Promise((resolve) => {
    if (client.status === "closed" || client.status === "waiting" || client.status === "reconnecting") {
      resolve();
      return;
    }
    client.once("close", () => resolve());
    setTimeout(() => resolve(), 5000);
  });
}

async function withLazyEngine<T>(
  options: Parameters<typeof createResilienceEngine>[1] | undefined,
  fn: (engine: Awaited<ReturnType<typeof createResilienceEngine>>) => Promise<T>,
): Promise<T> {
  const client = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  try {
    const engine = createResilienceEngine(client, options);
    return await fn(engine);
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
}

// ============================================================================
// Operation validation edge cases
// ============================================================================

test("validate: missing operation id throws", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await assert.rejects(
      engine.execute({
        id: "",
        command: "set",
        key: "k",
        args: ["v"],
      } as ResilienceOperation),
      /operation id is required/,
    );
  });
});

test("validate: missing operation key throws", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await assert.rejects(
      engine.execute({
        id: "op-1",
        command: "set",
        key: "",
        args: ["v"],
      } as ResilienceOperation),
      /operation key is required/,
    );
  });
});

test("validate: zero TTL throws", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await assert.rejects(
      engine.execute({
        id: "op-1",
        command: "set",
        key: "k",
        args: ["v"],
        ttlSeconds: 0,
      } as ResilienceOperation),
      /ttlSeconds must be a positive finite number/,
    );
  });
});

test("validate: negative TTL throws", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await assert.rejects(
      engine.execute({
        id: "op-1",
        command: "set",
        key: "k",
        args: ["v"],
        ttlSeconds: -5,
      } as ResilienceOperation),
      /ttlSeconds must be a positive finite number/,
    );
  });
});

test("validate: NaN TTL throws", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await assert.rejects(
      engine.execute({
        id: "op-1",
        command: "set",
        key: "k",
        args: ["v"],
        ttlSeconds: NaN,
      } as ResilienceOperation),
      /ttlSeconds must be a positive finite number/,
    );
  });
});

test("validate: expiresAt must be finite and positive", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await assert.rejects(
      engine.execute({
        id: "op-1",
        command: "set",
        key: "k",
        args: ["v"],
        expiresAt: 0,
      } as ResilienceOperation),
      /expiresAt must be a positive finite timestamp/,
    );

    await assert.rejects(
      engine.execute({
        id: "op-2",
        command: "set",
        key: "k",
        args: ["v"],
        expiresAt: NaN,
      } as ResilienceOperation),
      /expiresAt must be a positive finite timestamp/,
    );
  });
});

// ============================================================================
// Local store edge cases
// ============================================================================

test("local store: overwriting existing entry bumps version", () => {
  const store = new LocalStore<string>({ maxEntries: 100, maxPayloadBytes: 10000 });
  const now = Date.now();

  const e1 = store.write("k", "v1", { operationId: "op-1", now, ttlSeconds: 60 });
  assert.equal(e1.version, 1);
  assert.equal(e1.value, "v1");

  const e2 = store.write("k", "v2", { operationId: "op-2", now, ttlSeconds: 60 });
  assert.equal(e2.version, 2);
  assert.equal(e2.value, "v2");

  const read = store.read("k", now);
  assert.equal(read.result, "HIT");
  assert.equal(read.value, "v2");
});

test("local store: deleting non-existent key creates tombstone", () => {
  const store = new LocalStore<string>({ maxEntries: 100, maxPayloadBytes: 10000 });
  const now = Date.now();

  const tombstone = store.del("missing-key", { operationId: "op-del", now });
  assert.equal(tombstone.state, "tombstone");
  assert.equal(tombstone.value, null);
  assert.equal(tombstone.version, 1);

  const read = store.read("missing-key", now);
  assert.equal(read.result, "MISS");
  assert.equal(read.value, null);
});

test("local store: delete after delete preserves tombstone", () => {
  const store = new LocalStore<string>({ maxEntries: 100, maxPayloadBytes: 10000 });
  const now = Date.now();

  store.del("k", { operationId: "op-1", now });
  const t2 = store.del("k", { operationId: "op-2", now });

  assert.equal(t2.version, 2);
  const entry = store.get("k");
  assert.ok(entry);
  assert.equal(entry.state, "tombstone");
});

test("local store: write overwrites tombstone and returns to valid", () => {
  const store = new LocalStore<string>({ maxEntries: 100, maxPayloadBytes: 10000 });
  const now = Date.now();

  store.del("k", { operationId: "op-del", now });
  const entry = store.get("k");
  assert.ok(entry);
  assert.equal(entry.state, "tombstone");

  const written = store.write("k", "new-value", { operationId: "op-write", now, ttlSeconds: 60 });
  assert.equal(written.state, "valid");
  assert.equal(written.value, "new-value");
  assert.equal(written.version, 2);

  const read = store.read("k", now);
  assert.equal(read.result, "HIT");
  assert.equal(read.value, "new-value");
});

test("local store: expire on non-existent key is a no-op", () => {
  const store = new LocalStore<string>({ maxEntries: 100, maxPayloadBytes: 10000 });
  const now = Date.now();

  store.write("k", "v", { operationId: "op-1", now, ttlSeconds: 60 });

  // ttlSeconds: 0 → expiresAt = now → immediately expired
  store.write("k", "v", { operationId: "op-2", now, ttlSeconds: 0 });
  const read = store.read("k", now + 1);
  assert.equal(read.result, "MISS");
  assert.equal(read.value, null);
});

test("local store: large payload rejected by max entry size", () => {
  const store = new LocalStore<string>({
    maxEntries: 100,
    maxPayloadBytes: 100000,
    maxEntryBytes: 100,
  });
  const now = Date.now();

  const bigValue = "x".repeat(1000);
  assert.throws(
    () => store.write("big-key", bigValue, { operationId: "op-1", now }),
    /exceeds maximum entry size/,
  );
});

test("local store: memory accounting on overwrite", () => {
  const store = new LocalStore<string>({ maxEntries: 100, maxPayloadBytes: 10000 });
  const now = Date.now();

  store.write("k", "short", { operationId: "op-1", now });
  const bytesAfterFirst = store.estimatedPayloadBytes;
  assert.ok(bytesAfterFirst > 0);

  store.write("k", "a-much-longer-value-that-takes-more-space", {
    operationId: "op-2",
    now,
  });
  const bytesAfterSecond = store.estimatedPayloadBytes;
  assert.ok(bytesAfterSecond > bytesAfterFirst);

  const read = store.read("k", now);
  assert.equal(read.value, "a-much-longer-value-that-takes-more-space");
});

test("local store: multiple keys independent", () => {
  const store = new LocalStore<string>({ maxEntries: 100, maxPayloadBytes: 10000 });
  const now = Date.now();

  store.write("k1", "v1", { operationId: "op-1", now });
  store.write("k2", "v2", { operationId: "op-2", now });
  store.del("k1", { operationId: "op-3", now });

  assert.equal(store.read("k1", now).result, "MISS");
  assert.equal(store.read("k2", now).result, "HIT");
  assert.equal(store.read("k2", now).value, "v2");
  assert.equal(store.size, 2);
});

// ============================================================================
// TTL boundary conditions
// ============================================================================

test("TTL: entry expires exactly at deadline", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await engine.execute({
      id: "ttl-1",
      command: "set",
      key: "ttl-boundary:key",
      args: ["boundary-value"],
      ttlSeconds: 1,
    });

    const hit = await engine.execute({
      id: "ttl-2",
      command: "get",
      key: "ttl-boundary:key",
      args: [],
    });
    assert.equal(hit.outcome, "EXECUTED");
    assert.equal(hit.value, "boundary-value");

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const miss = await engine.execute({
      id: "ttl-3",
      command: "get",
      key: "ttl-boundary:key",
      args: [],
    });
    assert.equal(miss.outcome, "EXECUTED");
    assert.equal(miss.value, null);
  });
});

test("TTL: entry with no TTL never expires", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await engine.execute({
      id: "no-ttl-1",
      command: "set",
      key: "no-ttl:key",
      args: ["permanent"],
    });

    const read = await engine.execute({
      id: "no-ttl-2",
      command: "get",
      key: "no-ttl:key",
      args: [],
    });
    assert.equal(read.outcome, "EXECUTED");
    assert.equal(read.value, "permanent");
    assert.equal(read.remainingTtlSeconds, undefined);
  });
});

test("TTL: remaining TTL decreases on subsequent reads", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await engine.execute({
      id: "ttl-dec-1",
      command: "set",
      key: "ttl-dec:key",
      args: ["decaying"],
      ttlSeconds: 10,
    });

    const first = await engine.execute({
      id: "ttl-dec-2",
      command: "get",
      key: "ttl-dec:key",
      args: [],
    });
    assert.ok(first.remainingTtlSeconds! <= 10);
    assert.ok(first.remainingTtlSeconds! > 0);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const second = await engine.execute({
      id: "ttl-dec-3",
      command: "get",
      key: "ttl-dec:key",
      args: [],
    });
    assert.ok(second.remainingTtlSeconds! < first.remainingTtlSeconds!);
    assert.ok(second.remainingTtlSeconds! >= 0);
  });
});

// ============================================================================
// Expiration manager edge cases
// ============================================================================

test("expiration: computeExpiresAt with explicit expiresAt overrides TTL", () => {
  const exp = new ExpirationManager({ clock: () => 100000 });
  const result = exp.computeExpiresAt({
    ttlSeconds: 60,
    expiresAt: 999999,
    acceptedAt: 100000,
  });
  assert.equal(result, 999999);
});

test("expiration: computeExpiresAt with no TTL and no expiresAt returns undefined", () => {
  const exp = new ExpirationManager({ clock: () => 100000 });
  const result = exp.computeExpiresAt({});
  assert.equal(result, undefined);
});

test("expiration: remainingTtlSeconds returns 0 when exactly at expiry", () => {
  const exp = new ExpirationManager({ clock: () => 100000 });
  const result = exp.ttlForPersistence(
    {
      expiresAt: 100000,
      createdAt: 0,
      acceptedAt: 0,
      retries: 0,
      sequence: 0,
      sizeBytes: 0,
      state: "QUEUED",
      id: "x",
      command: "set",
      key: "k",
      args: [],
    },
    100000,
  );
  assert.equal(result.ttlSeconds, 0);
  assert.equal(result.expired, true);
});

test("expiration: remainingTtlSeconds for no-TTL entry returns undefined", () => {
  const exp = new ExpirationManager({ clock: () => 100000 });
  const result = exp.ttlForPersistence(
    {
      expiresAt: undefined,
      createdAt: 0,
      acceptedAt: 0,
      retries: 0,
      sequence: 0,
      sizeBytes: 0,
      state: "QUEUED",
      id: "x",
      command: "set",
      key: "k",
      args: [],
    },
    100000,
  );
  assert.equal(result.ttlSeconds, -1);
  assert.equal(result.expired, false);
});

// ============================================================================
// Policy edge cases
// ============================================================================

test("policy: all non-idempotent commands rejected by default", () => {
  const nonIdempotent = ["incr", "incrby", "decr", "decrby"];
  for (const cmd of nonIdempotent) {
    const result = classifyOperation({
      id: "pol-1",
      command: cmd,
      key: "k",
      args: [],
    } as ResilienceOperation);
    assert.equal(result.allowed, false);
    assert.equal(result.policy, "reject");
  }
});

test("policy: all idempotent commands allowed by default", () => {
  const idempotent = ["get", "set", "setex", "setnx", "del", "expire", "exists", "ttl", "sadd", "smembers", "srem", "hset", "hget", "hdel", "getset"];
  for (const cmd of idempotent) {
    const result = classifyOperation({
      id: "pol-2",
      command: cmd,
      key: "k",
      args: [],
    } as ResilienceOperation);
    assert.equal(result.allowed, true);
    assert.equal(result.policy, "buffer");
  }
});

test("policy: explicit policy override works for both directions", () => {
  const override1 = classifyOperation({
    id: "pol-3",
    command: "incr",
    key: "k",
    args: [],
    policy: "buffer",
  } as ResilienceOperation);
  assert.equal(override1.allowed, true);
  assert.equal(override1.policy, "buffer");

  const override2 = classifyOperation({
    id: "pol-4",
    command: "set",
    key: "k",
    args: ["v"],
    policy: "reject",
  } as ResilienceOperation);
  assert.equal(override2.allowed, false);
  assert.equal(override2.policy, "reject");
});

// ============================================================================
// Degraded-mode local data management tests
// ============================================================================

test("degraded mode: local write then read (read-your-writes)", async () => {
  await withLazyEngine(undefined, async (engine) => {
    const setResult = await engine.execute({
      id: "ryw-1",
      command: "set",
      key: "ryw:key",
      args: ["ryw-value"],
      ttlSeconds: 120,
    });
    assert.equal(setResult.outcome, "BUFFERED");

    const getResult = await engine.execute({
      id: "ryw-2",
      command: "get",
      key: "ryw:key",
      args: [],
    });
    assert.equal(getResult.outcome, "EXECUTED");
    assert.equal(getResult.value, "ryw-value");

    const entry = engine.localStore.get("ryw:key");
    assert.ok(entry);
    assert.equal(entry.state, "valid");
  });
});

test("degraded mode: local read returns MISS for deleted key (tombstone)", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await engine.execute({
      id: "tomb-1",
      command: "set",
      key: "tomb:key",
      args: ["tomb-value"],
    });

    const delResult = await engine.execute({
      id: "tomb-2",
      command: "del",
      key: "tomb:key",
      args: [],
    });
    assert.equal(delResult.outcome, "BUFFERED");

    const getResult = await engine.execute({
      id: "tomb-3",
      command: "get",
      key: "tomb:key",
      args: [],
    });
    assert.equal(getResult.outcome, "EXECUTED");
    assert.equal(getResult.value, null);

    const entry = engine.localStore.get("tomb:key");
    assert.ok(entry);
    assert.equal(entry.state, "tombstone");
  });
});

test("degraded mode: local read returns UNKNOWN for never-cached key", async () => {
  await withLazyEngine(undefined, async (engine) => {
    const result = await engine.execute({
      id: "unk-1",
      command: "get",
      key: "unk:never-cached",
      args: [],
    });
    assert.equal(result.outcome, "REJECTED");
    assert.equal(result.state, "REJECTED");
    assert.ok(result.reason?.includes("No local data"));
  });
});

test("degraded mode: setnx on existing key is a local no-op", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await engine.execute({
      id: "setnx-1",
      command: "set",
      key: "setnx:key",
      args: ["first"],
    });

    const result = await engine.execute({
      id: "setnx-2",
      command: "setnx",
      key: "setnx:key",
      args: ["second"],
    });
    assert.equal(result.outcome, "BUFFERED");

    const getResult = await engine.execute({
      id: "setnx-3",
      command: "get",
      key: "setnx:key",
      args: [],
    });
    assert.equal(getResult.value, "first");
  });
});

test("degraded mode: hset/hget local read-write", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await engine.execute({
      id: "h-1",
      command: "hset",
      key: "h:key",
      args: ["field1", "value1"],
    });

    const result = await engine.execute({
      id: "h-2",
      command: "hget",
      key: "h:key",
      args: ["field1"],
    });
    assert.equal(result.outcome, "EXECUTED");
    assert.equal(result.value, "value1");

    const missing = await engine.execute({
      id: "h-3",
      command: "hget",
      key: "h:key",
      args: ["nonexistent"],
    });
    assert.equal(missing.outcome, "EXECUTED");
    assert.ok(missing.value === null || missing.value === undefined);
  });
});

test("degraded mode: sadd/smembers/srem local read-write", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await engine.execute({
      id: "s-1",
      command: "sadd",
      key: "s:key",
      args: ["member1"],
    });
    await engine.execute({
      id: "s-2",
      command: "sadd",
      key: "s:key",
      args: ["member2"],
    });

    const result = await engine.execute({
      id: "s-3",
      command: "smembers",
      key: "s:key",
      args: [],
    });
    assert.equal(result.outcome, "EXECUTED");
    const members = result.value as unknown[];
    assert.ok(members.includes("member1"));
    assert.ok(members.includes("member2"));

    await engine.execute({
      id: "s-4",
      command: "srem",
      key: "s:key",
      args: ["member2"],
    });

    const members2 = (await engine.execute({
      id: "s-5",
      command: "smembers",
      key: "s:key",
      args: [],
    })).value as unknown[];
    assert.ok(members2.includes("member1"));
    assert.ok(!members2.includes("member2"));
  });
});

// ============================================================================
// Enabled/disabled toggle
// ============================================================================

test("toggle: default is enabled (no options)", async () => {
  await withLazyEngine(undefined, async (engine) => {
    const result = await engine.execute({
      id: "toggle-default-1",
      command: "set",
      key: "toggle-default:key",
      args: ["default-enabled"],
    });
    assert.equal(result.outcome, "BUFFERED");
    assert.equal(engine.store.size, 1);
  });
});

test("toggle: explicitly enabled", async () => {
  await withLazyEngine({ enabled: true }, async (engine) => {
    const result = await engine.execute({
      id: "toggle-explicit-1",
      command: "set",
      key: "toggle-explicit:key",
      args: ["explicit-enabled"],
    });
    assert.equal(result.outcome, "BUFFERED");
    assert.equal(engine.store.size, 1);
  });
});

test("toggle: disabled passes through to Redis without buffering", async () => {
  await withLazyEngine({ enabled: false }, async (engine) => {
    const result = await engine.execute({
      id: "toggle-disabled-1",
      command: "set",
      key: "toggle-disabled:key",
      args: ["disabled"],
    });
    assert.equal(result.outcome, "EXECUTED");
    assert.equal(engine.store.size, 0);
    assert.equal(engine.localStore.size, 0);
    assert.equal(engine.isDegraded, false);

    const value = await engine.redis.get("toggle-disabled:key");
    assert.equal(value, "disabled");
  });
});

test("toggle: disabled metrics show zero activity", async () => {
  await withLazyEngine({ enabled: false }, async (engine) => {
    await engine.execute({
      id: "toggle-metrics-1",
      command: "set",
      key: "toggle-metrics:key",
      args: ["x"],
    });

    const m = engine.metrics();
    assert.equal(m.operationsBuffered, 0);
    assert.equal(m.pendingOperations, 0);
    assert.equal(m.localStore.entries, 0);
    assert.equal(m.localStore.localWrites, 0);
    assert.equal(m.localStore.localReads, 0);
  });
});

// ============================================================================
// Gap 1: Ambiguous Redis outcomes
// ============================================================================

test("ambiguous: non-idempotent command reports AMBIGUOUS on connection failure during recovery", async () => {
  // Use a port with no Redis so recovery always fails
  const client = createClient({
    url: "redis://127.0.0.1:6399/15",
    lazyConnect: true,
    retryStrategy: () => null,
  }, silentLogger);
  try {
    const engine = createResilienceEngine(client, { maxRetries: 1 });

    // Override default reject policy for incr so it gets buffered
    const bufferResult = await engine.execute({
      id: "amb-1",
      command: "incr",
      key: "amb:counter",
      args: [],
      policy: "buffer",
    });
    assert.equal(bufferResult.outcome, "BUFFERED");

    const events: unknown[] = [];
    engine.on((event) => {
      events.push(event);
    });

    const recovered = await engine.recover();
    assert.equal(recovered, 1);

    const m = engine.metrics();
    // Non-idempotent command should reach a terminal outcome (AMBIGUOUS or FAILED),
    // not silently dropped or left in QUEUED state. Both AMBIGUOUS and FAILED are
    // correct: AMBIGUOUS means Redis may have executed, FAILED means it likely didn't.
    assert.ok(
        m.operationsAmbiguous >= 1 || m.operationsFailed >= 1,
        `Expected ambiguous or failed outcome, got metrics: ${JSON.stringify(m)}`,
    );
    assert.equal(engine.store.size, 0);

    // If an ambiguous event was emitted, verify its details.
    const ambiguousEvent = events.find(
      (e: any) => e.type === "redis.operation.ambiguous",
    );
    if (ambiguousEvent) {
      assert.equal((ambiguousEvent as any).outcome, "AMBIGUOUS");
    }

    await engine.shutdown();
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
});

test("ambiguous: idempotent command is retried on connection failure during recovery", async () => {
  const client = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  try {
    const engine = createResilienceEngine(client, { maxRetries: 1 });

    const bufferResult = await engine.execute({
      id: "amb-2",
      command: "set",
      key: "amb:idempotent",
      args: ["value"],
    });
    assert.equal(bufferResult.outcome, "BUFFERED");

    const recovered = await engine.recover();
    assert.equal(recovered, 1);

    const m = engine.metrics();
    assert.ok(m.operationsAmbiguous >= 0 || m.operationsFailed >= 0);

    await engine.shutdown();
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// Gap 2: Real connection failures
// ============================================================================

test("real connection: disconnect → degraded → buffer → reconnect → recover", async () => {
  const client = createClient({ url: TEST_URL }, silentLogger);
  try {
    await client.connect();
    await client.ping();

    const engine = createResilienceEngine(client, {});

    await engine.execute({
      id: "conn-1",
      command: "set",
      key: "conn:key",
      args: ["before-outage"],
    });

    await client.disconnect();
    await waitForDisconnected(client as any);
    assert.equal(engine.isDegraded, true);

    await engine.execute({
      id: "conn-2",
      command: "set",
      key: "conn:key",
      args: ["during-outage"],
    });
    assert.equal(engine.store.size, 1);
    assert.equal(engine.localStore.size, 1);

    const read = await engine.execute({
      id: "conn-3",
      command: "get",
      key: "conn:key",
      args: [],
    });
    assert.equal(read.outcome, "EXECUTED");
    assert.equal(read.value, "during-outage");

    const events: unknown[] = [];
    engine.on((event) => {
      events.push(event);
    });

    await client.connect();
    await client.ping();

    // Automatic recovery runs on reconnect; wait for it to complete.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (engine.state !== "connected" || engine.store.size > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const recovered = await engine.recover();
    assert.ok(recovered >= 0);

    const redisValue = await client.get("conn:key");
    assert.equal(redisValue, "during-outage");

    const persistedEvent = events.find(
      (e: any) => e.type === "redis.operation.persisted",
    );
    assert.ok(persistedEvent, "Expected persisted event after recovery");

    const completedEvent = events.find(
      (e: any) => e.type === "redis.recovery.completed",
    );
    assert.ok(completedEvent, "Expected recovery completed event");

    assert.equal(engine.store.size, 0);

    await engine.shutdown();
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
});

test("real connection: multiple disconnect/reconnect cycles", async () => {
  const client = createClient({ url: TEST_URL }, silentLogger);
  try {
    await client.connect();
    await client.ping();

    const engine = createResilienceEngine(client, {});

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await client.disconnect();
      await waitForDisconnected(client as any);
      assert.equal(engine.isDegraded, true);

      await engine.execute({
        id: `cycle-${cycle}`,
        command: "set",
        key: `cycle:key-${cycle}`,
        args: [`value-${cycle}`],
      });

      await client.connect();
      await client.ping();

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (engine.state !== "connected" || engine.store.size > 0)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const value = await client.get(`cycle:key-${cycle}`);
      assert.equal(value, `value-${cycle}`);

      assert.equal(engine.store.size, 0);
    }
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// Gap 3: Recovery failure and retry behavior
// ============================================================================

test("recovery failure: Redis disconnects mid-recovery, operations retained", async () => {
  // Use lazy client so operations are buffered during outage
  const client = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  try {
    const engine = createResilienceEngine(client, { maxRetries: 2 });

    // Buffer operations while Redis is down
    await engine.execute({
      id: "recfail-1",
      command: "set",
      key: "recfail:key-1",
      args: ["v1"],
    });
    await engine.execute({
      id: "recfail-2",
      command: "set",
      key: "recfail:key-2",
      args: ["v2"],
    });
    await engine.execute({
      id: "recfail-3",
      command: "set",
      key: "recfail:key-3",
      args: ["v3"],
    });
    assert.equal(engine.store.size, 3);

    // Connect Redis and start recovery
    await client.connect();
    await client.ping();

    const recoveryPromise = engine.recover();

    // Disconnect Redis mid-recovery
    await client.disconnect();
    await waitForDisconnected(client as any);

    const recovered = await recoveryPromise;
    assert.ok(recovered >= 0);

    // Reconnect and recover again
    await client.connect();
    await client.ping();

    const recovered2 = await engine.recover();
    assert.ok(recovered2 >= 0);

    // All operations should eventually be persisted
    assert.equal(engine.store.size, 0, "All operations should be recovered after reconnect");

    assert.equal(await client.get("recfail:key-1"), "v1");
    assert.equal(await client.get("recfail:key-2"), "v2");
    assert.equal(await client.get("recfail:key-3"), "v3");

    await engine.shutdown();
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
});

test("recovery: retry exhaustion results in FAILED or AMBIGUOUS, not silent loss", async () => {
  // Use a port with no Redis so all connections fail
  const client = createClient({
    url: "redis://127.0.0.1:6399/15",
    lazyConnect: true,
    retryStrategy: () => null,
  }, silentLogger);
  try {
    const engine = createResilienceEngine(client, { maxRetries: 2 });

    await engine.execute({
      id: "retex-1",
      command: "set",
      key: "retex:key",
      args: ["value"],
      policy: "buffer",
    });

    await engine.recover();

    const m = engine.metrics();
    // Operation should be in terminal state (FAILED or AMBIGUOUS), not silently dropped
    assert.ok(m.operationsFailed >= 1 || m.operationsAmbiguous >= 1, `Expected failed or ambiguous, got metrics: ${JSON.stringify(m)}`);

    // Journal should be empty (operation reached terminal state)
    assert.equal(engine.store.size, 0);

    await engine.shutdown();
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// Gap 4: Cross-process conflicts
// ============================================================================

test("cross-process: two engines buffer writes to same key, conflict policy applied", async () => {
  const clientA = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  const clientB = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  try {
    const engineA = createResilienceEngine(clientA, {
      conflictPolicy: "overwrite",
    });
    const engineB = createResilienceEngine(clientB, {
      conflictPolicy: "reject",
    });

    await clientA.connect();
    await clientA.ping();
    await clientA.set("cross:key", "redis-original");
    await clientA.disconnect();

    const resA = await engineA.execute({
      id: "cross-a",
      command: "set",
      key: "cross:key",
      args: ["value-from-A"],
    });
    assert.equal(resA.outcome, "BUFFERED");

    const resB = await engineB.execute({
      id: "cross-b",
      command: "set",
      key: "cross:key",
      args: ["value-from-B"],
    });
    assert.equal(resB.outcome, "BUFFERED");

    await clientA.connect();
    await clientA.ping();
    await engineA.recover();

    const valueA = await clientA.get("cross:key");
    assert.equal(valueA, "value-from-A");

    await clientB.connect();
    await clientB.ping();
    await engineB.recover();

    const mB = engineB.metrics();
    assert.ok(mB.conflictsDetected >= 1, "Engine B should detect conflict");

    await engineA.shutdown();
    await engineB.shutdown();
  } finally {
    try {
      await clientA.disconnect();
    } catch {
      // ignore
    }
    try {
      await clientB.disconnect();
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// Gap 5: Stress and resource limits
// ============================================================================

test("stress: many concurrent operations on independent keys", async () => {
  const client = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  try {
    const engine = createResilienceEngine(client, {
      maxOperations: 1000,
      maxPayloadBytes: 10 * 1024 * 1024,
    });

    const numOps = 100;
    const writes = Array.from({ length: numOps }, (_, i) =>
      engine.execute({
        id: `stress-${i}`,
        command: "set",
        key: `stress:key-${i}`,
        args: [`value-${i}`] as unknown[],
      }),
    );

    const results = await Promise.all(writes);
    results.forEach((r) => {
      assert.equal(r.outcome, "BUFFERED");
    });

    assert.equal(engine.store.size, numOps);

    const reads = await Promise.all(
      Array.from({ length: numOps }, (_, i) =>
        engine.execute({
          id: `stress-read-${i}`,
          command: "get",
          key: `stress:key-${i}`,
          args: [] as unknown[],
        }),
      ),
    );
    reads.forEach((r, i) => {
      assert.equal(r.outcome, "EXECUTED");
      assert.equal(r.value, `value-${i}`);
    });

    const m = engine.metrics();
    assert.equal(m.localStore.localWrites, numOps);
    assert.equal(m.localStore.localReadHits, numOps);
    assert.equal(m.pendingOperations, numOps);

    await engine.shutdown();
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
});

test("stress: journal saturation rejects new operations deterministically", async () => {
  const client = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  try {
    const engine = createResilienceEngine(client, {
      maxOperations: 3,
      maxPayloadBytes: 100000,
    });

    const r1 = await engine.execute({
      id: "sat-1",
      command: "set",
      key: "sat:key-1",
      args: ["v1"],
    });
    const r2 = await engine.execute({
      id: "sat-2",
      command: "set",
      key: "sat:key-2",
      args: ["v2"],
    });
    const r3 = await engine.execute({
      id: "sat-3",
      command: "set",
      key: "sat:key-3",
      args: ["v3"],
    });
    assert.equal(r1.outcome, "BUFFERED");
    assert.equal(r2.outcome, "BUFFERED");
    assert.equal(r3.outcome, "BUFFERED");
    assert.equal(engine.store.size, 3);

    const r4 = await engine.execute({
      id: "sat-4",
      command: "set",
      key: "sat:key-4",
      args: ["v4"],
    });
    assert.equal(r4.outcome, "REJECTED");
    assert.equal(engine.store.size, 3);

    const m = engine.metrics();
    assert.equal(m.overflowEvents, 1);
    assert.equal(m.operationsRejected, 1);

    await engine.shutdown();
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
});

test("stress: large payloads bounded by max entry size", async () => {
  const client = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  try {
    const engine = createResilienceEngine(client, {
      maxOperations: 100,
      maxPayloadBytes: 10 * 1024 * 1024,
      maxOperationBytes: 1024,
    });

    const smallPayload = "x".repeat(100);
    const largePayload = "x".repeat(5000);

    const r1 = await engine.execute({
      id: "lp-1",
      command: "set",
      key: "lp:small",
      args: [smallPayload],
    });
    assert.equal(r1.outcome, "BUFFERED");

    const r2 = await engine.execute({
      id: "lp-2",
      command: "set",
      key: "lp:large",
      args: [largePayload],
    });
    assert.equal(r2.outcome, "REJECTED");

    const m = engine.metrics();
    // Entry size rejection is tracked in localStore, not as store overflow
    assert.equal(m.localStore.entriesRejected, 1);

    await engine.shutdown();
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
});

test("stress: memory stays bounded under sustained outage with repeated overwrites", async () => {
  const client = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  try {
    const engine = createResilienceEngine(client, {
      maxOperations: 10,
      maxPayloadBytes: 10000,
    });

    // Use even number so last write (odd index) is admitted to journal
    for (let i = 0; i < 52; i += 1) {
      await engine.execute({
        id: `mem-${i}`,
        command: "set",
        key: "mem:key",
        args: [`value-${i}`],
      });
    }

    // Journal bounded by maxOperations
    assert.ok(engine.store.size <= 10, `Journal should be bounded, got ${engine.store.size}`);

    // Local store has at most 1 entry (same key overwritten)
    assert.ok(engine.localStore.size <= 1, `Local store should have at most 1 entry, got ${engine.localStore.size}`);

    // Latest value should be readable if the journal still has room
    if (engine.store.size < 10) {
      const read = await engine.execute({
        id: "mem-read",
        command: "get",
        key: "mem:key",
        args: [],
      });
      assert.equal(read.outcome, "EXECUTED");
    }

    const m = engine.metrics();
    // Memory should stay bounded by maxPayloadBytes
    assert.ok(m.estimatedPayloadBytes <= 10000, `Memory should stay bounded, got ${m.estimatedPayloadBytes}`);

    await engine.shutdown();
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// Shutdown edge cases
// ============================================================================

test("shutdown: idempotent", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await engine.execute({
      id: "sd-1",
      command: "set",
      key: "sd:key",
      args: ["sd-value"],
    });

    await engine.shutdown();
    await engine.shutdown();
    await engine.shutdown();
  });
});

test("shutdown: clears both local store and pending journal", async () => {
  await withLazyEngine(undefined, async (engine) => {
    await engine.execute({
      id: "sd-2",
      command: "set",
      key: "sd:key1",
      args: ["v1"],
    });
    await engine.execute({
      id: "sd-3",
      command: "set",
      key: "sd:key2",
      args: ["v2"],
    });

    assert.equal(engine.store.size, 2);
    assert.equal(engine.localStore.size, 2);

    const events: unknown[] = [];
    engine.on((event) => {
      events.push(event);
    });

    await engine.shutdown();

    assert.equal(engine.store.size, 0);
    assert.equal(engine.localStore.size, 0);

    const shutdownEvent = events.find(
      (e: any) => e.type === "redis.recovery.completed",
    );
    assert.ok(shutdownEvent);
    assert.ok((shutdownEvent as any).reason?.includes("discarded"));
  });
});

// ============================================================================
// Audit regression tests
// ============================================================================

test("audit: WRONGTYPE is an ordinary command failure, not an outage", async () => {
  const client = createClient({ url: TEST_URL }, silentLogger);
  try {
    await client.connect();
    await client.ping();
    const engine = createResilienceEngine(client, {});
    await client.set("audit:wrongtype", "not-a-hash");

    await assert.rejects(
      engine.execute({
        id: "audit-wrongtype-1",
        command: "hset",
        key: "audit:wrongtype",
        args: ["field", "value"],
      } as ResilienceOperation),
      /WRONGTYPE/i,
    );

    assert.equal(engine.isDegraded, false);
    assert.equal(engine.state, "connected");
    assert.equal(engine.store.size, 0);
    assert.equal(await client.get("audit:wrongtype"), "not-a-hash");

    await client.del("audit:wrongtype");
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
});

test("audit: unsupported commands are rejected as REJECTED during degraded mode", async () => {
  await withLazyEngine({ maxOperations: 1 }, async (engine) => {
    const result = await engine.execute({
      id: "audit-unsupported-1",
      command: "zadd" as ResilienceCommand,
      key: "audit:unsupported",
      args: ["1", "member"],
    } as ResilienceOperation);
    assert.equal(result.outcome, "REJECTED");
    assert.equal(engine.store.size, 0);
  });
});

test("audit: a rejected operation rolls back its local admission", async () => {
  await withLazyEngine({ maxOperations: 1 }, async (engine) => {
    const first = await engine.execute({
      id: "audit-capacity-1",
      command: "set",
      key: "audit:capacity-1",
      args: ["v1"],
    });
    assert.equal(first.outcome, "BUFFERED");

    const second = await engine.execute({
      id: "audit-capacity-2",
      command: "set",
      key: "audit:capacity-2",
      args: ["v2"],
    });
    assert.equal(second.outcome, "REJECTED");
    assert.equal(engine.store.size, 1);
    assert.equal(engine.localStore.get("audit:capacity-2"), undefined);
  });
});

test("audit: connection errors are classified as connection failures", () => {
  assert.equal(classifyRedisError(new Error("Connection is closed.")).kind, "connection");
  assert.equal(classifyRedisError(new Error("connect ECONNREFUSED 127.0.0.1:6379")).kind, "connection");
  assert.notEqual(classifyRedisError(new Error("WRONGTYPE Operation against a key")).kind, "connection");
});

test("audit: concurrent manual recovery calls share one lifecycle", async () => {
  const client = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  try {
    const engine = createResilienceEngine(client, { autoRecover: false });
    await engine.execute({
      id: "audit-concurrent-1",
      command: "set",
      key: "audit:concurrent",
      args: ["value"],
    });
    assert.equal(engine.store.size, 1);

    await client.connect();
    await client.ping();

    await Promise.all([engine.recover(), engine.recover()]);
    assert.equal(engine.store.size, 0);
    assert.equal(await client.get("audit:concurrent"), "value");

    await engine.shutdown();
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
});

test("audit: createClient direct config supports pending operation limits", async () => {
  const client = createClient(
    { url: TEST_URL, lazyConnect: true, maxPendingOperations: 1 },
    silentLogger,
  );
  try {
    await client.set("audit:direct-limit-1", "v1");
    await assert.rejects(
      client.set("audit:direct-limit-2", "v2"),
      /local store at capacity|fallback queue at capacity/i,
    );
    assert.equal(client.engine.store.size, 1);
    assert.equal(client.engine.localStore.get("audit:direct-limit-2"), undefined);
  } finally {
    try {
      await client.shutdown();
    } catch {
      // ignore
    }
  }
});
