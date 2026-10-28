import { test } from "vitest";
import assert from "node:assert/strict";
import { ConnectionClosedError } from "bullmq";

import { cachedRedisAvailable, TEST_REDIS_URL } from "../helpers.js";
import {
  attachQueueEvents,
  createClient,
  createQueue,
  createWorker,
  health,
  shutdown,
  silentLogger,
  createLogger,
  attachEvents,
} from "@oneunit/redis";

test("health reports up when ping succeeds", async () => {
  const client = {
    async ping() {
      return "PONG";
    },
  };

  const result = await health(client);

  assert.equal(result.status, "up");
  assert.equal(result.latency.unit, "ms");
  assert.ok(result.latency.value >= 0);
});

test("health reports down when ping fails", async () => {
  const client = {
    async ping() {
      throw new Error("ECONNREFUSED");
    },
  };

  const result = await health(client);

  assert.equal(result.status, "down");
  assert.match(result.error, /ECONNREFUSED/);
});

test("shutdown quits a connected client", async () => {
  let quitCalled = false;
  const client = {
    async quit() {
      quitCalled = true;
    },
  };

  await shutdown(client);
  assert.equal(quitCalled, true);
});

test("shutdown is a no-op for a missing client", async () => {
  await shutdown(null);
  await shutdown(undefined);
});

test("shutdown propagates quit failures", async () => {
  const client = {
    async quit() {
      throw new Error("quit failed");
    },
  };

  await assert.rejects(() => shutdown(client), /quit failed/);
});

test("silentLogger has no output", () => {
  silentLogger.info("test");
  silentLogger.error("test");
  silentLogger.warn("test");
  silentLogger.debug("test");
  assert.ok(true);
});

test("a partial logger does not break connection events", async () => {
  // Only `error` is implemented. createClient passed this straight to
  // attachEvents, where `logger?.info` threw `is not a function` from inside
  // a connection-event handler, and shutdown threw on the way out. Real
  // consumers wire in pino/winston/console wrappers that rarely implement all
  // four levels, so this has to be safe rather than merely documented.
  const seen: string[] = [];
  const partial = {
    error(message: unknown) {
      seen.push(String(message));
    },
  };

  const client = createClient(
    { url: "redis://127.0.0.1:1", retryStrategy: () => null },
    partial,
  );

  // Drives connect/error/close, all of which log at other levels.
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.ok(Array.isArray(seen));

  // shutdown logs at info on the happy path, which the partial logger lacks.
  await shutdown(client, partial);
});

test("attachQueueEvents tolerates a partial logger", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // Only info. A missing level made the handler throw, which BullMQ caught
  // and re-emitted as "error", whose own handler threw again and escaped onto
  // console.error. The emit itself still looked successful, so this has to
  // assert on console.error to catch the regression.
  const partial = {
    info() {
      // no-op
    },
  };

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const queue = createQueue({
      name: "test-partial-logger",
      connection: client,
    });
    const events = attachQueueEvents({ queue, logger: partial });

    await events.waitUntilReady();

    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };

    try {
      events.emit("completed", { jobId: "1", returnvalue: "x" }, "evt");
      events.emit("failed", { jobId: "1", failedReason: "boom" }, "evt");
    } finally {
      console.error = original;
    }

    assert.deepEqual(logged, []);

    await events.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  } finally {
    await shutdown(client);
  }
});

test("createLogger wraps custom logger", () => {
  const custom = {
    info(msg: unknown, extra?: unknown) {
      return { msg, extra };
    },
    error(msg: unknown, extra?: unknown) {
      return { msg, extra };
    },
    warn(msg: unknown, extra?: unknown) {
      return { msg, extra };
    },
    debug(msg: unknown, extra?: unknown) {
      return { msg, extra };
    },
  };
  const logger = createLogger(custom);
  assert.ok(typeof logger.info === "function");
  assert.ok(typeof logger.error === "function");
});

test("createClient accepts a URL string the way ioredis does", () => {
  // ioredis's own constructor takes `new Redis("redis://host:port")`. Passing
  // that string to `createClient` used to destructure it as an options object,
  // which yielded no `url`, so the client silently connected to
  // localhost:6379 instead — the wrong server, with no error anywhere.
  const client = createClient(
    TEST_REDIS_URL as unknown as Record<string, never>,
    silentLogger,
  );

  try {
    const expected = new URL(TEST_REDIS_URL);

    assert.equal(client.options.host, expected.hostname);
    assert.equal(client.options.port, Number(expected.port || 6379));
  } finally {
    shutdown(client);
  }
});

test("createLogger keeps (message, extra) order for a logger with child()", () => {
  const calls: Array<[string, unknown, unknown]> = [];
  const record = (level: string) => (msg: unknown, extra?: unknown) => {
    calls.push([level, msg, extra]);
  };

  // A logger that follows the documented `Logger` interface and also exposes
  // `child()`. `child()` alone must not be read as "this is pino".
  const custom = {
    error: record("error"),
    warn: record("warn"),
    info: record("info"),
    debug: record("debug"),
    child() {
      return custom;
    },
  };

  const logger = createLogger(custom);

  logger.info("plain message");
  logger.info("with extra", { attempt: 1 });

  assert.deepEqual(calls, [
    ["info", "plain message", undefined],
    ["info", "with extra", { attempt: 1 }],
  ]);
});

test("createLogger uses (bindings, message) order for a pino logger", () => {
  const calls: Array<[string, unknown, unknown]> = [];
  const record = (level: string) => (bindings?: unknown, msg?: unknown) => {
    calls.push([level, bindings, msg]);
  };

  // The two markers a real pino instance carries: `bindings()` and `levels`.
  // `child()` is deliberately absent so this cannot pass by accident.
  const pinoLike = {
    error: record("error"),
    warn: record("warn"),
    info: record("info"),
    debug: record("debug"),
    levels: { info: 30, error: 50 },
    bindings() {
      return {};
    },
  };

  const logger = createLogger(pinoLike);

  logger.info("pino message", { requestId: "abc" });
  logger.error("pino failure");

  // With no bindings, pino reads a lone string first argument as the message,
  // so the message is passed on its own rather than as `(undefined, message)`.
  assert.deepEqual(calls, [
    ["info", { requestId: "abc" }, "pino message"],
    ["error", "pino failure", undefined],
  ]);
});

test("createLogger falls back to info when a level is missing", () => {
  const calls: Array<[string, unknown, unknown]> = [];
  const custom = {
    info(msg: unknown, extra?: unknown) {
      calls.push(["info", msg, extra]);
    },
  };

  const logger = createLogger(custom);
  logger.warn("no warn level", { attempt: 2 });

  assert.deepEqual(calls, [["info", "no warn level", { attempt: 2 }]]);
});
// The queue/worker tests need a real server, so they no-op when nothing is
// listening. The shared helper owns that decision — see test/helpers.ts.
const redisAvailable = cachedRedisAvailable();

test("createClient applies the url positionally so ioredis actually uses it", () => {
  const client = createClient(
    { url: "redis://198.51.100.7:6380/2" },
    silentLogger,
  );

  assert.equal(client.options.host, "198.51.100.7");
  assert.equal(client.options.port, 6380);
  assert.equal(client.options.db, 2);
});

test("createClient falls back to REDIS_URL", () => {
  const previous = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://198.51.100.9:6390";

  try {
    const client = createClient({}, silentLogger);
    assert.equal(client.options.host, "198.51.100.9");
    assert.equal(client.options.port, 6390);
  } finally {
    if (previous === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previous;
    }
  }
});

test("createClient defaults maxRetriesPerRequest to null for BullMQ", () => {
  const client = createClient({ url: "redis://127.0.0.1:6379" }, silentLogger);
  assert.equal(client.options.maxRetriesPerRequest, null);
});

test("createClient honours an explicit maxRetriesPerRequest", () => {
  const client = createClient(
    { url: "redis://127.0.0.1:6379", maxRetriesPerRequest: 5 },
    silentLogger,
  );
  assert.equal(client.options.maxRetriesPerRequest, 5);
});

test("health times out instead of hanging when ping never settles", async () => {
  const client = {
    ping: () => new Promise(() => {}),
  };

  const result = await health(client, { timeout: 50 });

  assert.equal(result.status, "down");
  assert.match(result.error, /timed out after 50ms/);
});

test("health defaults to a bounded timeout", async () => {
  const client = {
    ping: () => new Promise(() => {}),
  };

  const start = Date.now();
  const result = await health(client);

  assert.equal(result.status, "down");
  assert.ok(
    Date.now() - start < 5000,
    "health should not hang past its default timeout",
  );
});

test("shutdown is idempotent once the client has ended", async () => {
  let quitCalls = 0;
  const client = {
    status: "end",
    async quit() {
      quitCalls++;
      throw new Error("Connection is closed.");
    },
  };

  await shutdown(client);
  assert.equal(quitCalls, 0);
});

test("shutdown is idempotent after forcing a stalled connection closed", async () => {
  const REDUCED_QUIT_DEADLINE = 60;

  // A connection stuck in `reconnecting`: QUIT is queued behind the reconnect
  // attempt and never settles, so shutdown forces it closed.
  const client = {
    status: "reconnecting",
    quitCalls: 0,
    async quit() {
      this.quitCalls++;
      return new Promise<never>(() => {});
    },
    disconnect() {},
  };

  const started = process.hrtime.bigint();
  await shutdown(client);
  const forced = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(forced >= REDUCED_QUIT_DEADLINE, "first call waited for QUIT");

  const secondStarted = process.hrtime.bigint();
  await shutdown(client);
  const second = Number(process.hrtime.bigint() - secondStarted) / 1e6;

  // `disconnect()` on a client in `reconnecting` never runs ioredis's
  // `closeHandler`, so the status stays `reconnecting` even though the retry
  // loop has been cleared and the connection can never come back. Without
  // remembering that this function already tore it down, a second call waits
  // out the whole QUIT deadline again, so a process with handlers on both
  // SIGINT and SIGTERM pays the timeout twice.
  assert.equal(client.quitCalls, 1);
  assert.ok(second < REDUCED_QUIT_DEADLINE, `second call took ${second}ms`);
});

test("shutdown tolerates a connection that closes mid-quit", async () => {
  const client = {
    status: "ready",
    async quit() {
      this.status = "end";
      throw new Error("Connection is closed.");
    },
  };

  await shutdown(client);
  assert.equal(client.status, "end");
});

test("shutdown never logs the Redis password on a failed disconnect", async () => {
  // Shutdown can fail with the AUTH error: ioredis decorates it with the failing
  // command, and for AUTH that command's args are the password in plaintext.
  // Logging it as-is would write the credential out during teardown, which is
  // exactly when a crash report is being assembled.
  const PASSWORD = "shutdown-password-marker";
  const authError = Object.assign(
    new Error("WRONGPASS invalid username-password pair"),
    {
      name: "ReplyError",
      command: { name: "auth", args: [PASSWORD, ""] },
    },
  );

  const logged: Array<{ message: unknown; extra: unknown }> = [];
  const logger = createLogger({
    warn(message: unknown, extra?: unknown) {
      logged.push({ message, extra });
    },
    error(message: unknown, extra?: unknown) {
      logged.push({ message, extra });
    },
    info() {},
    debug() {},
  });

  // A still-live connection whose QUIT rejects, so shutdown takes the
  // log-and-rethrow path rather than treating it as already disconnected.
  const client = {
    status: "ready",
    async quit() {
      throw authError;
    },
  } as unknown as Parameters<typeof shutdown>[0];

  await assert.rejects(() => shutdown(client, logger));

  assert.equal(logged.length, 1, "the failure must still be reported");
  assert.equal(logged[0].message, "Failed to disconnect Redis");

  const serialised = JSON.stringify(logged[0].extra, (key, value) =>
    value instanceof Error
      ? { message: value.message, command: value.command }
      : value,
  );

  assert.ok(
    !serialised.includes(PASSWORD),
    `shutdown log leaked the password: ${serialised}`,
  );
});

test("createWorker leaves concurrency unset so BullMQ applies its default", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const worker = createWorker({
      name: "test-default-concurrency",
      connection: client,
      processor: async () => {},
    });
    await worker.waitUntilReady();

    assert.equal(worker.concurrency, 1);

    await worker.close();
  } finally {
    await shutdown(client);
  }
});

test("createWorker honours an explicit concurrency", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const worker = createWorker({
      name: "test-explicit-concurrency",
      connection: client,
      concurrency: 4,
      processor: async () => {},
    });
    await worker.waitUntilReady();

    assert.equal(worker.concurrency, 4);

    await worker.close();
  } finally {
    await shutdown(client);
  }
});

test("createQueue applies the prefix and leaves settings to BullMQ", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const queue = createQueue({
      name: "test-default-settings",
      connection: client,
    });
    await queue.waitUntilReady();

    assert.equal(queue.opts.prefix, "queue");
    assert.equal(queue.opts.settings, undefined);

    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  } finally {
    await shutdown(client);
  }
});

test("createQueue merges partial defaultJobOptions over the defaults", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const queue = createQueue({
      name: "test-job-options",
      connection: client,
      defaultJobOptions: { attempts: 9 },
    });
    await queue.waitUntilReady();

    const options = queue.opts.defaultJobOptions;
    assert.equal(options?.attempts, 9);
    assert.equal(options?.removeOnComplete, 100);
    assert.equal(options?.removeOnFail, 1000);
    assert.deepEqual(options?.backoff, { type: "exponential", delay: 1000 });

    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  } finally {
    await shutdown(client);
  }
});

test("createQueue keeps its default when a job option is explicitly undefined", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    // The worker factories already drop keys the caller left undefined, so
    // BullMQ applies its own default instead of receiving an explicit
    // `undefined`. The queue's defaultJobOptions spread did not, so a config
    // assembled by spreading another object (`{ ...base, attempts: maybeValue }`)
    // silently erased the package default rather than falling through to it.
    const queue = createQueue({
      name: "test-undefined-job-options",
      connection: client,
      defaultJobOptions: {
        attempts: undefined,
        backoff: undefined,
        removeOnComplete: undefined,
      },
    });
    await queue.waitUntilReady();

    const options = queue.opts.defaultJobOptions;

    assert.equal(options?.attempts, 3);
    assert.deepEqual(options?.backoff, { type: "exponential", delay: 1000 });
    assert.equal(options?.removeOnComplete, 100);

    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  } finally {
    await shutdown(client);
  }
});

test("createQueue still lets a caller set a job option to null", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    // `null` is a deliberate value, not a missing one: `removeOnComplete: null`
    // is how BullMQ is told to keep the job forever. Only `undefined` falls
    // through to the default.
    const queue = createQueue({
      name: "test-null-job-options",
      connection: client,
      defaultJobOptions: { removeOnComplete: null },
    });
    await queue.waitUntilReady();

    assert.equal(queue.opts.defaultJobOptions?.removeOnComplete, null);

    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  } finally {
    await shutdown(client);
  }
});

test("health settles even when nothing else keeps the event loop alive", async () => {
  // The deadline timer must stay ref'd: if it were unref'd, a health check
  // whose PING never settles would leave Node with no work and exit before
  // the promise ever resolved. Assert on a child process so this is real.
  const script = `
        import { health } from ${JSON.stringify(new URL("../../dist/index.js", import.meta.url).href)};
        const result = await health({ ping: () => new Promise(() => {}) }, { timeout: 300 });
        process.stdout.write(JSON.stringify(result));
    `;

  const { execFileSync } = await import("node:child_process");
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      encoding: "utf8",
      timeout: 15000,
    },
  );

  const result = JSON.parse(output) as { status: string; error?: string };
  assert.equal(result.status, "down");
  assert.match(result.error ?? "", /timed out after 300ms/);
});

test("health clamps an invalid timeout instead of emitting a Node warning", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.name);
  process.on("warning", onWarning);

  try {
    const client = { ping: async () => "PONG" };

    assert.equal((await health(client, { timeout: -1 })).status, "up");
    assert.equal((await health(client, { timeout: NaN })).status, "up");

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(warnings, []);
  } finally {
    process.off("warning", onWarning);
  }
});

test("attachQueueEvents inherits the queue prefix so events actually arrive", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const queue = createQueue({
      name: "test-prefix-events",
      connection: client,
      prefix: "testapp",
    });
    const worker = createWorker({
      name: "test-prefix-events",
      connection: client,
      prefix: "testapp",
      processor: async () => "ok",
    });
    const events = attachQueueEvents({ queue, logger: silentLogger });

    await worker.waitUntilReady();
    await events.waitUntilReady();

    assert.equal(queue.opts.prefix, "testapp");
    assert.equal(events.opts.prefix, "testapp");

    const completed = new Promise<{ jobId: string }>((resolve) =>
      events.once("completed", resolve),
    );
    await queue.add("work", {});
    const event = await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("no completed event")), 5000),
      ),
    ]);

    assert.ok(event.jobId);

    await events.close();
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  } finally {
    await shutdown(client);
  }
});

test("attachQueueEvents honours an explicit prefix over the queue default", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const queue = createQueue({
      name: "test-explicit-prefix",
      connection: client,
    });
    const events = attachQueueEvents({
      queue,
      logger: silentLogger,
      prefix: "explicit",
    });

    await events.waitUntilReady();
    assert.equal(events.opts.prefix, "explicit");

    await events.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  } finally {
    await shutdown(client);
  }
});

test("attachQueueEvents never logs the Redis password", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const logged: Array<{ message: unknown; extra: unknown }> = [];
  const logger = createLogger({
    error(message: unknown, extra?: unknown) {
      logged.push({ message, extra });
    },
    warn() {},
    info() {},
    debug() {},
  });

  // A password-protected server. QueueEvents duplicates the caller's client,
  // inheriting the password, and BullMQ re-emits the resulting ioredis error on
  // the QueueEvents emitter. That error carries the failing command, and for
  // AUTH the command's args are the password in plaintext.
  const PASSWORD = "unreachable-password-marker";
  const client = createClient(
    { url: `redis://:${PASSWORD}@127.0.0.1:6390`, retryStrategy: () => null },
    logger,
  );

  try {
    await client.connect().catch(() => undefined);

    const queue = createQueue({
      name: "test-queue-redaction",
      connection: client,
    });
    const events = attachQueueEvents({ queue, logger });

    // QueueEvents duplicates the caller's client, inheriting the password, and
    // BullMQ re-emits any AUTH failure on the emitter. Emitting one directly
    // keeps this deterministic: against an unreachable port the failure is
    // ECONNREFUSED, which carries no command and so never reaches redaction.
    events.emit(
      "error",
      Object.assign(new Error("WRONGPASS invalid username-password pair"), {
        name: "ReplyError",
        command: { name: "auth", args: [PASSWORD, ""] },
      }),
    );

    // And let a real attempt land too, in case the server is there.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const queueErrors = logged.filter((entry) =>
      String(entry.message).includes("events error"),
    );

    assert.ok(
      queueErrors.length > 0,
      "expected the queue event error handler to have been called",
    );

    for (const entry of queueErrors) {
      const serialised = JSON.stringify(entry.extra, (key, value) =>
        value instanceof Error
          ? { message: value.message, command: value.command }
          : value,
      );

      assert.ok(
        !serialised.includes(PASSWORD),
        `queue error log leaked the password: ${serialised}`,
      );
    }

    await events.close().catch(() => undefined);
    await queue.close().catch(() => undefined);
  } finally {
    await shutdown(client);
  }
});

test("attachQueueEvents tolerates a missing logger on event dispatch", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const queue = createQueue({ name: "test-no-logger", connection: client });
    const events = attachQueueEvents({ queue });

    await events.waitUntilReady();

    // BullMQ swallows a throwing listener and retries the event as "error",
    // which also throws and ends up on console.error. A missing logger must
    // not produce that noise, so assert nothing reaches console.error.
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };

    try {
      events.emit("completed", { jobId: "1", returnvalue: "x" }, "evt");
      events.emit("failed", { jobId: "1", failedReason: "boom" }, "evt");
      events.emit("progress", { jobId: "1", data: 1 }, "evt");
      events.emit("error", new Error("boom"));
    } finally {
      console.error = original;
    }

    assert.deepEqual(logged, []);

    await events.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  } finally {
    await shutdown(client);
  }
});

test("close releases the QueueEvents connection when startup never succeeded", async () => {
  // BullMQ's `QueueEvents.close()` awaits its connection's `initializing`
  // promise before disconnecting. Against an unreachable server that promise
  // rejects with "Connection is closed.", so close() threw and left the
  // duplicated ioredis client in its reconnect loop. Nothing in the caller
  // holds a reference to that duplicate, so the process could never exit.
  // Assert the connection actually reached "closed" rather than relying on
  // the test run finishing, which is exactly what was not guaranteed before.
  const unreachable = "redis://127.0.0.1:1";

  const client = createClient(
    { url: unreachable, retryStrategy: () => null, connectTimeout: 200 },
    silentLogger,
  );

  try {
    const queue = createQueue({
      name: "test-events-dead-server",
      connection: client,
    });
    const events = attachQueueEvents({ queue, logger: silentLogger });

    // Readiness rejects rather than hanging when the server is absent.
    await queue.waitUntilReady().catch(() => undefined);

    await events.close();
    await queue.close();

    assert.equal(
      (events as unknown as { connection: { status: string } }).connection
        .status,
      "closed",
    );
  } finally {
    await shutdown(client);
  }
});

test("close absorbs a ConnectionClosedError that has no trailing period", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // BullMQ introduced `ConnectionClosedError` so callers could stop matching on
  // message text, and its no-arg default message is "Connection is closed" —
  // no period. Only some of its construction sites pass ioredis's
  // "Connection is closed." wording, so an equality check against that string
  // rethrows exactly the errors teardown is supposed to absorb.
  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const queue = createQueue({
      name: "test-close-error-class",
      connection: client,
    });
    const events = attachQueueEvents({ queue, logger: silentLogger });

    await events.waitUntilReady();

    // Stand in for a BullMQ version whose `close()` rejects with a variant the
    // message check does not recognise. `ManagedQueueEvents` must still treat
    // it as "already closed" rather than surfacing it from teardown.
    const connection = (
      events as unknown as {
        connection: { close(force?: boolean): Promise<void> };
      }
    ).connection;

    // Standing in for the connection means BullMQ's own `close()` never runs, so
    // the connection status is not asserted here — only the behaviour this
    // wrapper owns: teardown reports success instead of throwing.
    connection.close = () => Promise.reject(new ConnectionClosedError());

    await events.close();

    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  } finally {
    await shutdown(client);
  }
});

test("close still surfaces a failure that is not about the connection", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // The counterpart to the test above. Absorbing connection-gone errors is only
  // correct while genuinely unrelated failures still propagate, otherwise
  // teardown would swallow real problems.
  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const queue = createQueue({
      name: "test-close-real-error",
      connection: client,
    });
    const events = attachQueueEvents({ queue, logger: silentLogger });

    await events.waitUntilReady();

    const connection = (
      events as unknown as {
        connection: { close(force?: boolean): Promise<void> };
      }
    ).connection;

    connection.close = () => Promise.reject(new Error("disk on fire"));

    await assert.rejects(
      () => events.close(),
      /disk on fire/,
      "a real teardown failure must not be absorbed",
    );

    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  } finally {
    await shutdown(client);
  }
});

test("attachEvents does not double-register on an already wired client", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // createClient already calls attachEvents, and attachEvents is exported. A
  // caller that also wired the client by hand got a second full set of
  // listeners, so every connection event was logged twice. Repeated calls
  // also crossed Node's default limit of 10 and emitted
  // MaxListenersExceededWarning, which is noise pointing at a memory leak
  // that does not exist.
  const lines: string[] = [];
  const logger = {
    info: (message: unknown) => lines.push(String(message)),
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };

  const client = createClient({ url: TEST_REDIS_URL }, logger);

  try {
    attachEvents(client, logger);
    attachEvents(client, logger);

    assert.equal(
      client.listenerCount("connect"),
      1,
      "attachEvents registered duplicate connect listeners",
    );

    await client.ping();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const connects = lines.filter((line) => line === "redis connect").length;
    const readies = lines.filter((line) => line === "redis ready").length;

    assert.equal(connects, 1, `one connection produced ${connects} log lines`);
    assert.equal(readies, 1, `one ready event produced ${readies} log lines`);
  } finally {
    await shutdown(client, logger);
  }
});

test("attachEvents still wires a bare client exactly once", () => {
  // A client built directly from ioredis has never been seen by this package,
  // so the first call must do the work and the second must be a no-op.
  const client = {
    on() {
      return this;
    },
    listenerCount() {
      return 1;
    },
  } as unknown as Parameters<typeof attachEvents>[0];

  attachEvents(client, silentLogger);
  attachEvents(client, silentLogger);

  assert.equal(
    (
      client as unknown as { listenerCount(event: string): number }
    ).listenerCount("error"),
    1,
  );
});
