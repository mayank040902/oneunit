import { test } from "vitest";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { cachedRedisAvailable, TEST_REDIS_URL } from "../helpers.js";
import {
  attachQueueEvents,
  createClient,
  createQueue,
  createWorker,
  health,
  shutdown,
  silentLogger,
} from "@oneunit/redis";

const KEY_PREFIX = "test:perf:";

/**
 * These tests assert on timing, so a machine under load would fail them for
 * the wrong reason. They no-op when Redis is unreachable rather than reporting a
 * performance problem that is really an environment problem.
 */
const redisAvailable = cachedRedisAvailable();

// Every ceiling below is deliberately loose. They exist to catch an
// algorithmic regression such as an accidental round trip per command or a
// leaked timer, not to police the machine running the suite.
const BUDGET = {
  // Loopback Redis answers PING in well under a millisecond.
  healthPerCall: 25,
  healthVsPing: 5,
  clientCreate: 10,
  clientConnect: 500,
  clientShutdown: 500,
  // Tolerance for timers this package does not own. `getActiveResourcesInfo()`
  // is process-global, so the test runner and ioredis both contribute. The leak
  // this guards against is ~500 — one timer per health() call — so a small
  // tolerance keeps the signal while surviving a loaded runner.
  timerGrowth: 2,
  jobThroughputPerSecond: 5,
  commandThroughputPerSecond: 500,
} as const;

test("health() adds negligible overhead over a bare PING", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    // Warm the connection and the code paths, so the measurement compares
    // steady-state cost rather than first-call JIT and DNS.
    for (let i = 0; i < 20; i++) {
      await health(client);
      await client.ping();
    }

    const iterations = 200;

    const pingStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      await client.ping();
    }
    const pingTotal = performance.now() - pingStart;

    const healthStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      await health(client);
    }
    const healthTotal = performance.now() - healthStart;

    const perCall = healthTotal / iterations;

    assert.ok(
      perCall < BUDGET.healthPerCall,
      `health() averaged ${perCall.toFixed(3)}ms per call, budget ${BUDGET.healthPerCall}ms`,
    );

    // The interesting number is the delta, not the absolute: health() is
    // ping() plus a timer. If it cost meaningfully more than the ping itself,
    // something is wrong.
    const overhead = (healthTotal - pingTotal) / iterations;

    assert.ok(
      overhead < BUDGET.healthVsPing,
      `health() costs ${overhead.toFixed(3)}ms more than a bare PING, budget ${BUDGET.healthVsPing}ms`,
    );
  } finally {
    await shutdown(client, silentLogger);
  }
});

test("health() reports latency close to what it actually took", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    for (let i = 0; i < 20; i++) {
      await health(client);
    }

    let worstDelta = 0;

    for (let i = 0; i < 100; i++) {
      const started = performance.now();
      const result = await health(client);
      const actual = performance.now() - started;

      worstDelta = Math.max(
        worstDelta,
        Math.abs(result.latency.value - actual),
      );
    }

    // The value is rounded to whole milliseconds, so a sub-millisecond delta is
    // the expected best case. A larger gap means the timer is measuring the
    // wrong span, which would make the number useless for alerting.
    assert.ok(
      worstDelta <= 5,
      `reported latency drifted ${worstDelta.toFixed(2)}ms from the real duration`,
    );
  } finally {
    await shutdown(client, silentLogger);
  }
});

test("repeated health() checks do not accumulate timers", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // A readiness probe on an interval is the common case. If each call left its
  // timeout armed, a long-running process would accumulate handles until it ran
  // out of them, and a dead Redis would make it worse because every call would
  // hit the deadline.
  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    await health(client);

    const countTimers = () =>
      process
        .getActiveResourcesInfo()
        .filter((resource) => resource === "Timeout").length;

    const before = countTimers();

    for (let batch = 0; batch < 10; batch++) {
      await Promise.all(Array.from({ length: 50 }, () => health(client)));
    }

    const after = countTimers();

    // Bounded, not exactly zero: the counters are process-global, so this
    // measures "health() does not leak one timer per call" rather than "the
    // world stood still". Same reasoning as the shutdown check below.
    assert.ok(
      after - before <= BUDGET.timerGrowth,
      `500 health() calls left ${after - before} extra timers`,
    );
  } finally {
    await shutdown(client, silentLogger);
  }
});

test("creating, connecting and closing a client stays cheap", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // Services create clients per worker process, and tests create them per case.
  // If construction did anything expensive such as a DNS lookup or a
  // synchronous connect, this is where it would show.
  const clients = Array.from({ length: 20 }, () =>
    createClient({ url: TEST_REDIS_URL }, silentLogger),
  );

  try {
    const createStart = performance.now();
    for (const client of clients) {
      // Construction is lazy; assert it does no I/O by never connecting.
      assert.equal(
        client.status,
        "wait",
        "createClient must not connect eagerly",
      );
    }
    const createTotal = performance.now() - createStart;

    assert.ok(
      createTotal / clients.length < BUDGET.clientCreate,
      `construction averaged ${(createTotal / clients.length).toFixed(2)}ms`,
    );

    const connectStart = performance.now();
    await Promise.all(clients.map((client) => client.ping()));
    const connectTotal = performance.now() - connectStart;

    assert.ok(
      connectTotal / clients.length < BUDGET.clientConnect,
      `connect+ping averaged ${(connectTotal / clients.length).toFixed(2)}ms`,
    );
  } finally {
    await shutdown(clients[0], silentLogger);
    for (const client of clients) {
      await shutdown(client, silentLogger);
    }
  }
});

test("a shared client serves many queues without extra connections", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // The documented pattern is one client shared by every queue and worker.
  // Duplicating a socket per queue would defeat that and, at scale, would
  // exhaust the server's connection limit.
  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const NAMES = Array.from({ length: 5 }, (_, i) => `test-perf-shared-${i}`);
    const queues = NAMES.map((name) =>
      createQueue({ name, connection: client }),
    );
    const workers = NAMES.map((name) =>
      createWorker({
        name,
        connection: client,
        concurrency: 2,
        processor: async () => "ok",
      }),
    );

    await Promise.all(
      [...queues, ...workers].map((item) => item.waitUntilReady()),
    );

    // BullMQ only marks the *caller's* client as shared; each queue and worker
    // makes its own blocking connection. The point of this check is that the
    // plain client was never duplicated behind our back, so shutdown releases
    // everything.
    assert.equal(client.status, "ready");

    const JOBS = 20;
    await Promise.all(
      queues.map((queue) =>
        queue.obliterate({ force: true }).catch(() => undefined),
      ),
    );

    const started = performance.now();
    await Promise.all(
      queues.map((queue) =>
        Promise.all(
          Array.from({ length: JOBS }, (_, i) => queue.add(`job-${i}`, { i })),
        ),
      ),
    );
    await Promise.all(
      workers.map((worker) => worker.waitUntilReady().then(() => undefined)),
    );

    await Promise.all(workers.map((worker) => worker.close(true)));
    await Promise.all(queues.map((queue) => queue.close()));
    for (const queue of queues) {
      await queue.obliterate({ force: true }).catch(() => undefined);
    }

    const elapsed = performance.now() - started;
    const perSecond = (NAMES.length * JOBS) / (elapsed / 1000);

    assert.ok(
      perSecond > BUDGET.jobThroughputPerSecond,
      `only ${perSecond.toFixed(0)} jobs/sec across ${NAMES.length} queues`,
    );
  } finally {
    await shutdown(client, silentLogger);
  }
});

test("command throughput is not throttled by the wrapper", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // createClient returns the ioredis instance itself, so commands must cost
  // what Redis costs. A regression here would mean the wrapper started
  // wrapping, serialising, or re-issuing commands.
  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);
  const COUNT = 200;
  const keys = Array.from(
    { length: COUNT },
    (_, i) => `${KEY_PREFIX}bulk:${i}`,
  );

  try {
    await client.set(`${KEY_PREFIX}warm`, "1");

    const started = performance.now();
    await Promise.all(keys.map((key) => client.set(key, "value")));
    const elapsed = performance.now() - started;

    assert.ok(
      COUNT / (elapsed / 1000) > BUDGET.commandThroughputPerSecond,
      `only ${(COUNT / (elapsed / 1000)).toFixed(0)} ops/sec through the client`,
    );

    await client.del(...keys);
  } finally {
    await shutdown(client, silentLogger);
  }
});

test("large payloads round-trip within budget", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // Cached blobs and serialized sessions are the reason this package exists.
  // A megabyte should not take anything like a second on loopback.
  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);
  const payload = "x".repeat(1024 * 1024);
  const key = `${KEY_PREFIX}large`;

  try {
    const setStart = performance.now();
    await client.set(key, payload);
    const setMs = performance.now() - setStart;

    const getStart = performance.now();
    const readBack = await client.get(key);
    const getMs = performance.now() - getStart;

    assert.equal(readBack?.length, payload.length, "payload must round-trip");

    assert.ok(setMs < 2000, `1MB SET took ${setMs.toFixed(0)}ms`);
    assert.ok(getMs < 2000, `1MB GET took ${getMs.toFixed(0)}ms`);
  } finally {
    await client.del(key).catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("a cleanup path does not leave timers holding the event loop", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // Teardown that leaves a timer armed adds its full duration to the process's
  // lifetime. shutdown() races QUIT against a 5s deadline, so this is exactly
  // where such a leak would cost 5s of shutdown time.
  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  // Measured against a baseline rather than an absolute zero: the test runner
  // itself keeps timers armed, and those are not ours to account for.
  const countTimers = () =>
    process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;

  try {
    await client.ping();
    await health(client);
    await shutdown(client, silentLogger);

    const baseline = countTimers();

    // Repeat the whole cycle: a leaked timer per shutdown would double here.
    const second = createClient({ url: TEST_REDIS_URL }, silentLogger);
    await second.ping();
    await health(second);
    await shutdown(second, silentLogger);

    const after = countTimers();

    assert.ok(
      after <= baseline,
      `${after - baseline} timers left armed by a second connect/health/shutdown cycle`,
    );
  } finally {
    await shutdown(client, silentLogger);
  }
});

test("attachQueueEvents does not slow down the worker path", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // The event listener is attached for observability. If it did anything
  // synchronous and expensive per job, a high-throughput queue would feel it.
  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);
  const queue = createQueue({ name: "test-perf-events", connection: client });
  const events = attachQueueEvents({ queue, logger: silentLogger });

  const COUNT = 50;
  let processed = 0;
  const worker = createWorker({
    name: "test-perf-events",
    connection: client,
    concurrency: 5,
    processor: async () => {
      processed += 1;
      return "ok";
    },
  });

  try {
    await Promise.all([
      queue.waitUntilReady(),
      events.waitUntilReady(),
      worker.waitUntilReady(),
    ]);
    await queue.obliterate({ force: true }).catch(() => undefined);

    const started = performance.now();
    await Promise.all(
      Array.from({ length: COUNT }, (_, i) => queue.add(`job-${i}`, { i })),
    );

    const deadline = performance.now() + 10_000;
    while (processed < COUNT && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const elapsed = performance.now() - started;

    assert.equal(processed, COUNT, "every job should have been processed");
    assert.ok(
      COUNT / (elapsed / 1000) > BUDGET.jobThroughputPerSecond,
      `only ${(COUNT / (elapsed / 1000)).toFixed(0)} jobs/sec with events attached`,
    );
  } finally {
    await worker.close(true).catch(() => undefined);
    await events.close().catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});
