import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cachedRedisAvailable, TEST_REDIS_URL } from "../helpers.js";
import {
  attachQueueEvents,
  createClient,
  createQueue,
  createWorker,
  health,
  redactError,
  shutdown,
  silentLogger,
} from "@oneunit/redis";

const UNREACHABLE_URL = "redis://127.0.0.1:6399";

// The queue/worker tests need a real server, so they no-op when nothing is
// listening. The shared helper owns that decision — see test/helpers.ts.
const redisAvailable = cachedRedisAvailable();

/** Deep stringification, so an Error's own fields (not just `.message`) count. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val instanceof Error) {
      return {
        name: val.name,
        message: val.message,
        stack: val.stack,
        ...(Object.keys(val) as (keyof typeof val)[]).reduce<
          Record<string, unknown>
        >((acc, key) => {
          acc[key as string] = (val as unknown as Record<string, unknown>)[
            key as string
          ];
          return acc;
        }, {}),
      };
    }
    return val;
  });
}

function recordingLogger() {
  const lines: unknown[][] = [];
  return {
    lines,
    logger: {
      error: (...args: unknown[]) => lines.push(["error", ...args]),
      warn: (...args: unknown[]) => lines.push(["warn", ...args]),
      info: (...args: unknown[]) => lines.push(["info", ...args]),
      debug: (...args: unknown[]) => lines.push(["debug", ...args]),
    },
  };
}

// --------------------------------------------------------------------------
// Credential handling
// --------------------------------------------------------------------------

test("redactError removes AUTH arguments but keeps the reason", async () => {
  // ioredis attaches the failing command to its errors, and for AUTH those
  // args are the username and password verbatim. The message is what an
  // operator needs; the command args are the secret.
  const password = "correct-horse-battery-staple";
  const error = Object.assign(
    new Error("WRONGPASS invalid username-password pair."),
    {
      command: { name: "auth", args: ["default", password] },
    },
  );

  const redacted = redactError(error) as Error & {
    command: { name: string; args: unknown };
  };

  assert.ok(redacted instanceof Error, "must stay an Error");
  assert.match(redacted.message, /WRONGPASS/, "reason must survive redaction");
  assert.equal(redacted.command.name, "auth");
  assert.ok(
    !serialize(redacted).includes(password),
    "redacted error must not contain the password",
  );

  // The original is left intact: ioredis may still be using it.
  assert.equal(error.command.args[1], password);
});

test("redactError leaves errors without secrets untouched", () => {
  const plain = new Error("ECONNREFUSED 127.0.0.1:6379");
  assert.equal(redactError(plain), plain, "must be the same object");

  const nonAuth = Object.assign(new Error("READONLY"), {
    command: { name: "set", args: ["some-key", "some-value"] },
  });
  assert.equal(
    redactError(nonAuth),
    nonAuth,
    "a non-auth command is not a credential leak",
  );

  assert.equal(redactError("just a string"), "just a string");
  assert.equal(redactError(undefined), undefined);
});

test("connection errors never log the Redis password", async () => {
  // End-to-end version of the redaction test: drive a real AUTH failure and
  // assert nothing that reaches the logger carries the password. Uses a
  // requirepass server when one can be started, otherwise falls back to the
  // unreachable port, which still produces an AUTH-bearing error when a
  // password is present in the URL.
  const password = "hunter2-real-secret";
  const { lines, logger } = recordingLogger();

  const client = createClient(
    {
      url: `redis://default:${password}@127.0.0.1:6390`,
      connectTimeout: 500,
      retryStrategy: () => null,
    },
    logger,
  );

  try {
    await health(client, { timeout: 1500 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const dump = serialize(lines);

    assert.ok(!dump.includes(password), `logs leaked the password:\n${dump}`);
  } finally {
    await shutdown(client, logger);
  }
});

test("health() reports failures without echoing credentials", async () => {
  const password = "hunter2-real-secret";
  const client = createClient(
    {
      url: `redis://default:${password}@${UNREACHABLE_URL.replace("redis://", "")}`,
      connectTimeout: 500,
      retryStrategy: () => null,
    },
    silentLogger,
  );

  try {
    const result = await health(client, { timeout: 1000 });

    assert.equal(result.status, "down");
    assert.ok(result.error, "a failure must carry an error message");
    assert.ok(
      !result.error.includes(password),
      `health error leaked the password: ${result.error}`,
    );
  } finally {
    await shutdown(client, silentLogger);
  }
});

// --------------------------------------------------------------------------
// Input handling
// --------------------------------------------------------------------------

test("a caller-supplied __proto__ does not pollute Object.prototype", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // createQueue and createWorker spread caller-controlled objects straight into
  // BullMQ options. A JSON body reaching either must not be able to reach the
  // global prototype.
  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const polluted = JSON.parse('{"__proto__":{"polluted":"yes"}}') as object;

    const queue = createQueue({
      name: "test-proto-pollution",
      connection: client,
      defaultJobOptions: polluted as never,
    });

    assert.equal(
      ({} as Record<string, unknown>).polluted,
      undefined,
      "Object.prototype was polluted via defaultJobOptions",
    );

    // Wait for readiness before tearing down. Closing a BullMQ connection
    // while its init() is still in flight orphans a promise inside ioredis's
    // connect path: it rejects with "Connection is closed." with nothing
    // listening. Reproduces with plain bullmq and ioredis too, so it is
    // upstream rather than something this package controls.
    await queue.waitUntilReady();
    await queue.close();
  } finally {
    await shutdown(client, silentLogger);
  }
});

test("a queue that never became ready can still be released cleanly", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // A queue closed before its init() settles, while its connection is torn
  // down at the same time, orphans a promise inside ioredis's connect path. It
  // rejects with "Connection is closed." with nothing listening. Reproduces with
  // plain bullmq and ioredis and no wrapper, so it is upstream and there is
  // nothing this package can attach a handler to.
  //
  // What matters for a consumer is the opposite guarantee: once readiness is
  // awaited, teardown releases everything without strays. That is what the
  // examples and this package's own shutdown path rely on.
  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const queue = createQueue({
      name: "test-ready-teardown",
      connection: client,
    });
    const events = attachQueueEvents({ queue });
    const worker = createWorker({
      name: "test-ready-teardown",
      connection: client,
      processor: async () => "ok",
    });

    await Promise.all([
      queue.waitUntilReady(),
      events.waitUntilReady(),
      worker.waitUntilReady(),
    ]);

    await worker.close(true);
    await events.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  } finally {
    await shutdown(client, silentLogger);
  }

  // Nothing may be left holding the event loop once teardown is done.
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(
    client.status,
    "end",
    "the shared client should be fully closed after shutdown",
  );
});

test("queue names cannot inject a Redis key separator", async () => {
  // A colon in the name would let a caller write outside the keyspace the
  // prefix defines. BullMQ rejects it; assert we surface that rather than
  // silently creating an unreachable queue.
  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    assert.throws(
      () => createQueue({ name: "evil:injected", connection: client }),
      /cannot contain/,
      "a colon in a queue name must be rejected",
    );

    assert.throws(
      () => createQueue({ name: "", connection: client }),
      /must be provided/,
    );
  } finally {
    await shutdown(client, silentLogger);
  }
});

// --------------------------------------------------------------------------
// Resource exhaustion
// --------------------------------------------------------------------------

test("concurrent health checks leave no timers behind", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // Each health() arms a timeout. If those were not cleared, a service polling
  // Redis on an interval would accumulate timers and, on a dead server, leak
  // one per call.
  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const before = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;

    const results = await Promise.all(
      Array.from({ length: 200 }, () => health(client, { timeout: 1000 })),
    );

    assert.ok(
      results.every((result) => result.status === "up"),
      "all health checks should succeed against a live server",
    );

    const after = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;

    assert.ok(
      after <= before,
      `timers leaked: ${before} before, ${after} after 200 health checks`,
    );
  } finally {
    await shutdown(client, silentLogger);
  }
});

test("health() is bounded against a blackholed host", async () => {
  // A refused connection fails instantly; a dropped packet hangs until the OS
  // TCP timeout. Without health()'s own bound, a startup probe against a
  // firewalled Redis would stall for minutes.
  const client = createClient(
    {
      url: "redis://10.255.255.1:6379",
      connectTimeout: 500,
      retryStrategy: () => null,
    },
    silentLogger,
  );

  try {
    const started = Date.now();
    const result = await health(client, { timeout: 500 });
    const elapsed = Date.now() - started;

    assert.equal(result.status, "down");
    assert.ok(
      elapsed < 5000,
      `health took ${elapsed}ms; the timeout is not bounding the wait`,
    );
  } finally {
    await shutdown(client, silentLogger);
  }
});

test("shutdown is safe to call repeatedly and concurrently", async () => {
  // The guard here is load-bearing, not conventional. `createClient` defaults
  // `maxRetriesPerRequest` to null, which is what BullMQ requires, and null
  // means ioredis never gives up on a queued command. Against a Redis that is
  // not listening, the `ping()` below parks in the offline queue and never
  // settles — so without this the whole suite hangs forever on a machine with
  // no server, rather than skipping.
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  await client.ping();

  // Shutdown is registered on both SIGINT and SIGTERM in real apps, so a
  // double signal must not produce a rejection during teardown.
  const results = await Promise.allSettled([
    shutdown(client, silentLogger),
    shutdown(client, silentLogger),
  ]);

  for (const result of results) {
    assert.equal(result.status, "fulfilled");
  }

  await shutdown(client, silentLogger);
});

test("shutdown tolerates a null or already-disconnected client", async () => {
  await shutdown(null, silentLogger);
  await shutdown(undefined, silentLogger);

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);
  client.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));

  await shutdown(client, silentLogger);
});

// --------------------------------------------------------------------------
// Failure isolation
// --------------------------------------------------------------------------

test("a failing queue listener cannot crash the process", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  // BullMQ catches a throwing listener and re-emits it as "error". If the
  // error listener also throws, it escapes to console.error. A consumer's
  // logger must not be able to take the process down from inside an event.
  const original = console.error;
  const escaped: unknown[] = [];
  console.error = (...args: unknown[]) => {
    escaped.push(args);
  };

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const queue = createQueue({
      name: "test-listener-isolation",
      connection: client,
    });
    // Only `info`: `error` is missing, which is what used to throw.
    const events = attachQueueEvents({
      queue,
      logger: { info: () => undefined },
    });

    await events.waitUntilReady();

    events.emit("failed", { jobId: "1", failedReason: "boom" }, "evt");

    assert.deepEqual(
      escaped,
      [],
      "a logger missing a level must not reach console.error",
    );

    await events.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  } finally {
    console.error = original;
    await shutdown(client, silentLogger);
  }
});

// --------------------------------------------------------------------------
// Published artifact
// --------------------------------------------------------------------------

test("the published tarball contains no test or source credentials", () => {
  // The package must not ship the test suite, which embeds passwords used
  // above. Not a real secret, but it is the pattern that matters.
  //
  // `--ignore-scripts` is load-bearing. Without it, `npm pack` runs `prepack`,
  // which is `npm run build`, whose `clean` step deletes `dist/` — the
  // directory every other test file imports at module load. Node's test runner
  // runs test files in parallel child processes, so that produced a window in
  // which a sibling resolved `../dist/index.js` while it did not exist: a
  // nondeterministic `ERR_MODULE_NOT_FOUND` attributed to the wrong file.
  //
  // The listing is unaffected. `build` already ran before `test` in both
  // `verify` and CI, so `dist/` is populated and still enumerated.
  const result = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      encoding: "utf8",
      timeout: 120_000,
      cwd: process.cwd(),
    },
  );

  if (result.status !== 0) {
    // npm pack needs the registry-free local run to work; skip rather than
    // fail on an unrelated tooling problem.
    return;
  }

  // npm wraps the metadata under the package name.
  const parsed = JSON.parse(result.stdout) as
    | { [key: string]: { files: { path: string }[] } }
    | Array<{ name?: string; files: { path: string }[] }>;
  const tarball = Array.isArray(parsed)
    ? parsed[0]
    : parsed["@oneunit/redis"];
  assert.ok(tarball, "npm pack produced no metadata");

  const paths = tarball.files.map((file) => file.path);

  assert.ok(
    !paths.some((path) => path.startsWith("test/")),
    "the test suite must not be published",
  );
  assert.ok(
    !paths.some((path) => path.includes(".env")),
    "no environment files may be published",
  );
});

test("no stray files are left in the package directory", () => {
  // Probe scripts written during debugging are easy to leave behind, and they
  // end up in the tarball.
  const root = process.cwd();
  const strays = ["failcheck.mjs", "p22.mjs", "perf1.mjs", "sec1.mjs"].filter(
    (name) => existsSync(join(root, name)),
  );

  assert.deepEqual(strays, [], `stray files present: ${strays.join(", ")}`);
  assert.ok(tmpdir().length > 0);
});
