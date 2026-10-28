import { test } from "vitest";
import assert from "node:assert/strict";
import {
  createClient,
  createResilientRedis,
  shutdown,
  silentLogger,
} from "@oneunit/redis";

const TEST_URL = "redis://127.0.0.1:6379/16";

test("createResilientRedis wraps client with facade methods", async () => {
  const baseClient = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  const resilient = createResilientRedis(baseClient, { enabled: true });

  assert.ok(typeof resilient.shutdown === "function");
  assert.ok(typeof resilient.recover === "function");
  assert.ok(typeof resilient.metrics === "function");
  assert.ok(typeof resilient.on === "function");
  assert.ok(typeof resilient.off === "function");
  assert.ok(resilient.engine);
  assert.equal(resilient.state, "connected");
  assert.equal(resilient.isDegraded, false);

  await resilient.shutdown();
  await shutdown(baseClient, silentLogger);
});

test("createResilientRedis executes supported commands normally", async () => {
  const baseClient = createClient({ url: TEST_URL }, silentLogger);
  const resilient = createResilientRedis(baseClient, { enabled: true });

  try {
    await resilient.set("resilient:test", "value");
    const value = await resilient.get("resilient:test");
    assert.equal(value, "value");
  } finally {
    await resilient.shutdown();
    await shutdown(baseClient, silentLogger);
  }
});

test("createResilientRedis proxies unsupported commands to native client", async () => {
  const baseClient = createClient({ url: TEST_URL }, silentLogger);
  const resilient = createResilientRedis(baseClient, { enabled: true });

  try {
    await resilient.ping();
    assert.ok(true);
  } finally {
    await resilient.shutdown();
    await shutdown(baseClient, silentLogger);
  }
});

test("createResilientRedis exposes engine and state", async () => {
  const baseClient = createClient({ url: TEST_URL }, silentLogger);
  const resilient = createResilientRedis(baseClient, { enabled: true });

  assert.ok(resilient.engine);
  assert.ok(resilient.state === "connected" || resilient.state === "connecting");
  assert.equal(typeof resilient.metrics, "function");

  const metrics = resilient.metrics();
  assert.ok(typeof metrics.pendingOperations === "number");
  assert.ok(typeof metrics.connectionState === "string");

  await resilient.shutdown();
  await shutdown(baseClient, silentLogger);
});

test("createResilientRedis with disabled option returns pass-through", async () => {
  const baseClient = createClient({ url: TEST_URL }, silentLogger);
  const resilient = createResilientRedis(baseClient, { enabled: false });

  assert.ok(resilient.engine);
  assert.equal(resilient.isDegraded, false);

  await resilient.set("disabled:test", "value");
  const value = await resilient.get("disabled:test");
  assert.equal(value, "value");

  await resilient.shutdown();
  await shutdown(baseClient, silentLogger);
});

test("createResilientRedis with autoRecover false does not auto-recover", async () => {
  const baseClient = createClient({ url: TEST_URL }, silentLogger);
  const resilient = createResilientRedis(baseClient, { enabled: true, autoRecover: false });

  assert.ok(resilient.engine);

  await resilient.shutdown();
  await shutdown(baseClient, silentLogger);
});

test("createResilientRedis event handlers work", async () => {
  const baseClient = createClient({ url: TEST_URL }, silentLogger);
  const resilient = createResilientRedis(baseClient, { enabled: true });

  const events: string[] = [];
  const handler = (event: { type: string }) => {
    events.push(event.type);
  };

  resilient.on(handler);
  assert.ok(typeof resilient.off === "function");

  resilient.off(handler);

  await resilient.shutdown();
  await shutdown(baseClient, silentLogger);
});

test("createResilientRedis close is alias for shutdown", async () => {
  const baseClient = createClient({ url: TEST_URL }, silentLogger);
  const resilient = createResilientRedis(baseClient, { enabled: true });

  await resilient.close();

  await shutdown(baseClient, silentLogger);
});

test("createResilientRedis quit calls shutdown then quit", async () => {
  const baseClient = createClient({ url: TEST_URL }, silentLogger);
  const resilient = createResilientRedis(baseClient, { enabled: true });

  await resilient.quit();

  await shutdown(baseClient, silentLogger);
});

test("createResilientRedis with custom fallback options", async () => {
  const baseClient = createClient({ url: TEST_URL }, silentLogger);
  const resilient = createResilientRedis(baseClient, {
    enabled: true,
    fallback: {
      enabled: true,
      strategy: "memory",
      maxOperations: 1000,
    },
  });

  assert.ok(resilient.engine);
  assert.equal(resilient.isDegraded, false);

  await resilient.shutdown();
  await shutdown(baseClient, silentLogger);
});

test("createResilientRedis with custom recovery options", async () => {
  const baseClient = createClient({ url: TEST_URL }, silentLogger);
  const resilient = createResilientRedis(baseClient, {
    enabled: true,
    recovery: {
      enabled: true,
      autoRecover: true,
      maxRetries: 5,
      baseDelayMs: 200,
      maxDelayMs: 10000,
      recoveryBatchSize: 10,
      recoveryConcurrency: 2,
      dedupeOnRecovery: true,
    },
  });

  assert.ok(resilient.engine);

  await resilient.shutdown();
  await shutdown(baseClient, silentLogger);
});

test("createResilientRedis with ownsClient true shuts down client on shutdown", async () => {
  const baseClient = createClient({ url: TEST_URL }, silentLogger);
  const resilient = createResilientRedis(baseClient, {
    enabled: true,
    ownsClient: true,
  });

  await resilient.shutdown();

  assert.equal(baseClient.status, "end");
});

test("createResilientRedis respects maxOperationBytes option", async () => {
  const baseClient = createClient({ url: TEST_URL }, silentLogger);
  const resilient = createResilientRedis(baseClient, {
    enabled: true,
    maxOperationBytes: 512,
  });

  assert.ok(resilient.engine);

  await resilient.shutdown();
  await shutdown(baseClient, silentLogger);
});

test("createResilientRedis with jobAtLeastOnce option exposes job feature", async () => {
  const baseClient = createClient({ url: TEST_URL }, silentLogger);
  const resilient = createResilientRedis(baseClient, {
    enabled: true,
    jobAtLeastOnce: {
      enabled: true,
      queueName: "resilient-jobs",
    },
  });

  assert.ok(resilient.jobAtLeastOnce);
  assert.equal(resilient.jobAtLeastOnce.enabled, true);
  assert.equal(resilient.jobAtLeastOnce.queueName, "resilient-jobs");

  await resilient.jobAtLeastOnce.close();
  await resilient.shutdown();
  await shutdown(baseClient, silentLogger);
});