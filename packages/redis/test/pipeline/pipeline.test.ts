import { test } from "vitest";
import assert from "node:assert/strict";

import {
  createClient,
  health,
  runPipeline,
  pipelineValues,
  PipelineCommandError,
  PipelineStepError,
  PipelineTimeoutError,
  silentLogger,
} from "@oneunit/redis";
import type { ChainableCommander } from "ioredis";

// A stand-in for the subset of ioredis that `runPipeline` uses. Lets the result
// and error handling be tested without a server, which is where the interesting
// behaviour lives: a failing command is resolved, not rejected.
//
// `length` is part of the contract, not a convenience: `runPipeline` reads it
// before and after each step to check the step queued exactly one command, so
// it has to track `queued` live. A constant would make that check pass or fail
// for reasons unrelated to the batch.
function fakeClient(exec: () => Promise<Array<[Error | null, unknown]>>) {
  const queued: string[] = [];

  return {
    queued,
    pipeline(): ChainableCommander {
      const command =
        (name: string) =>
        (..._args: unknown[]) => {
          queued.push(name);
          return command;
        };

      return {
        get: command("get"),
        set: command("set"),
        incr: command("incr"),
        get length() {
          return queued.length;
        },
        exec,
      } as unknown as ChainableCommander;
    },
    exec,
  } as unknown as Parameters<typeof runPipeline>[0];
}

test("a failed command is reported, not silently dropped", async () => {
  // The core trap. ioredis resolves EXEC with `[error, null]` for the command
  // that failed, so the batch looks successful unless each tuple is inspected.
  const failure = Object.assign(new Error("ERR value is not an integer"), {
    command: { name: "incr", args: ["counter"] },
  });

  const result = await runPipeline(
    fakeClient(async () => [
      [null, "OK"],
      [failure, null],
      [null, "1"],
    ]),
    [
      { label: "set", run: (p) => void p.set("k", "1") },
      { label: "incr", run: (p) => void p.get("k") },
      { label: "get", run: (p) => void p.get("k") },
    ],
  );

  assert.equal(result.failed, 1);
  assert.equal(result.results.length, 3);
  assert.equal(result.results[1].label, "incr");
  assert.ok(result.results[1].error instanceof Error);
  assert.equal(result.results[1].error?.message, "ERR value is not an integer");
  // Succeeding results are unaffected by the failure in the middle.
  assert.equal(result.results[0].value, "OK");
  assert.equal(result.results[2].value, "1");
});

test("results carry labels so a failure is identifiable", async () => {
  const result = await runPipeline(
    fakeClient(async () => [
      [null, "OK"],
      [null, null],
    ]),
    [
      { label: "cache:set", run: (p) => void p.set("k", "1") },
      { label: "cache:get", run: (p) => void p.get("k") },
    ],
  );

  assert.deepEqual(
    result.results.map((r) => r.label),
    ["cache:set", "cache:get"],
  );
});

test("an empty batch does not make a round trip", async () => {
  let called = false;
  const result = await runPipeline(
    fakeClient(async () => {
      called = true;
      return [];
    }),
    [],
  );

  assert.equal(called, false);
  assert.deepEqual(result.results, []);
  assert.equal(result.durationMs, 0);
  assert.equal(result.failed, 0);
});

test("a step that throws to queue fails the whole batch", async () => {
  // Dropping the command would shift every later result by one, so the caller
  // would get a value against the wrong label.
  let execCalled = false;
  const boom = new Error("bad command");

  await assert.rejects(
    runPipeline(
      fakeClient(async () => {
        execCalled = true;
        return [];
      }),
      [
        { label: "ok", run: (p) => void p.set("k", "1") },
        {
          label: "broken",
          run: () => {
            throw boom;
          },
        },
      ],
    ),
    /bad command/,
  );

  assert.equal(execCalled, false);
});

test("a step that queues two commands fails the whole batch", async () => {
  // Results are paired with steps by position. A second command shifts every
  // later result by one, so the caller gets a real value against the wrong
  // label — a wrong answer rather than a visible failure.
  let execCalled = false;

  await assert.rejects(
    runPipeline(
      fakeClient(async () => {
        execCalled = true;
        return [];
      }),
      [
        { label: "ok", run: (p) => void p.set("a", "1") },
        {
          label: "seed",
          run: (p) => {
            p.set("b", "2");
            p.set("c", "3");
          },
        },
        { label: "get", run: (p) => void p.get("a") },
      ],
    ),
    (error: unknown) => {
      assert.ok(error instanceof PipelineStepError);
      // The label is the only thing that tells an operator which step is
      // wrong, so it has to be in the message.
      assert.equal(error.label, "seed");
      assert.equal(error.queued, 2);
      assert.match(error.message, /seed/);
      assert.match(error.message, /2 commands, expected exactly 1/);
      return true;
    },
  );

  assert.equal(execCalled, false);
});

test("an async step fails rather than dropping its command", async () => {
  // `run` is typed as returning void, and TypeScript allows a promise to be
  // returned from a void signature, so this compiles. Nothing is queued before
  // `exec()` runs, so the command is lost with no error anywhere.
  let execCalled = false;

  await assert.rejects(
    runPipeline(
      fakeClient(async () => {
        execCalled = true;
        return [];
      }),
      [
        { label: "ok", run: (p) => void p.set("k", "1") },
        {
          label: "deferred",
          run: async (p) => {
            await Promise.resolve();
            void p.get("k");
          },
        },
      ],
    ),
    (error: unknown) => {
      assert.ok(error instanceof PipelineStepError);
      assert.equal(error.label, "deferred");
      return true;
    },
  );

  assert.equal(execCalled, false);
});

test("an async step that rejects does not crash the process", async () => {
  // The step's promise is abandoned the moment the guard fires, so nothing is
  // left to handle its rejection. An unhandled rejection kills a Node 20
  // process outright, which would replace a precise error with a crash.
  await assert.rejects(
    runPipeline(
      fakeClient(async () => []),
      [
        {
          label: "rejects",
          run: async () => {
            throw new Error("late failure in the step");
          },
        },
      ],
    ),
    PipelineStepError,
  );

  // Give the abandoned promise a turn to reject. If nothing is attached to
  // it, node:test fails the file with an unhandled rejection instead.
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("a well-formed batch is not disturbed by the step guard", async () => {
  // The guard must not over-trigger: one command per step is the ordinary
  // case, and the labels still have to line up with the values.
  const result = await runPipeline(
    fakeClient(async () => [
      [null, "OK"],
      [null, "1"],
      [null, "2"],
    ]),
    [
      { label: "set", run: (p) => void p.set("a", "1") },
      { label: "get:a", run: (p) => void p.get("a") },
      { label: "get:b", run: (p) => void p.get("b") },
    ],
  );

  assert.deepEqual(
    result.results.map((r) => [r.label, r.value]),
    [
      ["set", "OK"],
      ["get:a", "1"],
      ["get:b", "2"],
    ],
  );
});

test("a rejected exec is redacted too", async () => {
  // The per-tuple redaction only covers a resolved EXEC. A rejection is the
  // connection-level path, and an AUTH failure surfaces there — with the
  // password in `command.args` if it is passed through as ioredis built it.
  const authFailure = Object.assign(
    new Error("WRONGPASS invalid username-password pair"),
    { command: { name: "AUTH", args: ["default", "hunter2-real-secret"] } },
  );

  await assert.rejects(
    runPipeline(
      fakeClient(async () => {
        throw authFailure;
      }),
      [{ label: "auth", run: (p) => void p.get("k") }],
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const command = (error as Error & { command?: { args?: unknown } })
        .command;
      assert.equal(command?.args, "[redacted]");
      assert.ok(
        !JSON.stringify(error).includes("hunter2-real-secret"),
        "password must not survive the rejection",
      );
      // The message is what tells an operator why auth failed, so it stays.
      assert.match(error.message, /WRONGPASS/);
      return true;
    },
  );
});

test("pipeline errors are redacted before they surface", async () => {
  // ioredis attaches the failing command to its errors, and for AUTH those args
  // are the password. A result array is a natural thing to log wholesale.
  const authFailure = Object.assign(
    new Error("WRONGPASS invalid username-password pair"),
    { command: { name: "AUTH", args: ["default", "hunter2-real-secret"] } },
  );

  const result = await runPipeline(
    fakeClient(async () => [[authFailure, null]]),
    [{ label: "auth", run: (p) => void p.set("k", "1") }],
  );

  const serialised = JSON.stringify(
    result,
    Object.getOwnPropertyNames(result.results[0].error as object),
  );
  assert.ok(
    !JSON.stringify(result).includes("hunter2-real-secret"),
    "password must not survive in the result",
  );
  assert.ok(!serialised.includes("hunter2-real-secret"));
  // The message is the operator's only clue why auth failed, so it stays.
  assert.match(result.results[0].error?.message ?? "", /WRONGPASS/);
});

test("throwOnError raises with the per-step results attached", async () => {
  const failure = new Error("ERR no such key");

  await assert.rejects(
    runPipeline(
      fakeClient(async () => [
        [null, "OK"],
        [failure, null],
      ]),
      [
        { label: "set", run: (p) => void p.set("k", "1") },
        { label: "incr", run: (p) => void p.get("k") },
      ],
      { throwOnError: true },
    ),
    (error: unknown) => {
      assert.ok(error instanceof PipelineCommandError);
      assert.equal(error.results.length, 2);
      assert.match(error.message, /1 of 2 commands failed/);
      // Labels only: ioredis errors carry command args, and this message can
      // end up in a log line.
      assert.match(error.message, /incr/);
      return true;
    },
  );
});

test("throwOnError leaves a fully successful batch alone", async () => {
  const result = await runPipeline(
    fakeClient(async () => [
      [null, "OK"],
      [null, "1"],
    ]),
    [
      { label: "set", run: (p) => void p.set("k", "1") },
      { label: "get", run: (p) => void p.get("k") },
    ],
    { throwOnError: true },
  );

  assert.equal(result.failed, 0);
});

test("pipelineValues returns values in order", () => {
  const values = pipelineValues([
    { label: "set", value: "OK" },
    { label: "get", value: "payload" },
  ]);

  assert.deepEqual(values, ["OK", "payload"]);
});

test("pipelineValues refuses to return a partially failed batch", () => {
  // Returning a sparse array that looks complete is how a failed write gets
  // treated as a successful one.
  assert.throws(
    () =>
      pipelineValues([
        { label: "set", value: "OK" },
        { label: "get", value: undefined, error: new Error("ERR no such key") },
      ]),
    PipelineCommandError,
  );
});

test("an unreachable server is bounded by the timeout", async () => {
  // ioredis parks queued commands while reconnecting, so EXEC never settles.
  // Without the bound this test hangs instead of failing.
  const client = createClient(
    {
      url: "redis://127.0.0.1:6399",
      connectTimeout: 200,
      retryStrategy: () => null,
    },
    silentLogger,
  );

  try {
    const result = await runPipeline(
      client,
      [{ label: "ping", run: (p) => void p.ping() }],
      { timeout: 300 },
    );

    // The connection dropped fast, so EXEC rejected or resolved with the
    // failure rather than hanging. Either way the call returned, which is the
    // behaviour under test.
    assert.ok(Array.isArray(result.results));
  } catch (error) {
    assert.ok(
      error instanceof PipelineTimeoutError,
      `expected a pipeline timeout, got ${String(error)}`,
    );
    assert.equal(error.steps, 1);
  } finally {
    client.disconnect();
  }
});

test("a hung EXEC raises PipelineTimeoutError", { timeout: 5000 }, async () => {
  // Same guarantee as above, but with an EXEC that never settles, so the test
  // covers the deadline rather than the connection failing.
  //
  // The `timeout` on the test case is what makes the regression detectable.
  // Without a deadline in `runPipeline` this await never settles, so without
  // this option the test would hang instead of failing — and a hang in CI is a
  // far worse failure signal than a red assertion.
  const never = new Promise<Array<[Error | null, unknown]>>(() => {});

  await assert.rejects(
    runPipeline(
      fakeClient(() => never),
      [
        { label: "set", run: (p) => void p.set("k", "1") },
        { label: "get", run: (p) => void p.get("k") },
      ],
      { timeout: 150 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof PipelineTimeoutError);
      assert.equal(error.steps, 2);
      assert.match(error.message, /2 commands did not complete within 150ms/);
      return true;
    },
  );
});

test("an invalid timeout is treated as no configured bound", async () => {
  // A zero or negative budget would become 1ms, turning every slow-but-healthy
  // server into a spurious timeout.
  const result = await runPipeline(
    fakeClient(async () => [[null, "OK"]]),
    [{ label: "ping", run: (p) => void p.get("k") }],
    { timeout: -5 },
  );

  assert.equal(result.results[0].value, "OK");
});

test("runPipeline batches against a real server", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    const result = await runPipeline(
      client,
      [
        { label: "set:a", run: (p) => void p.set("pipe:a", "1") },
        { label: "set:b", run: (p) => void p.set("pipe:b", "2") },
        { label: "get:a", run: (p) => void p.get("pipe:a") },
        { label: "get:b", run: (p) => void p.get("pipe:b") },
      ],
      { timeout: 5000 },
    );

    assert.equal(result.failed, 0);
    assert.deepEqual(pipelineValues(result.results), ["OK", "OK", "1", "2"]);
    assert.ok(result.durationMs >= 0);
  } finally {
    await shutdownQuietly(client);
  }
});

test("a real batch reports a failing command without rejecting", async () => {
  if (!(await redisAvailable())) {
    return;
  }

  const client = createClient({ url: TEST_REDIS_URL }, silentLogger);

  try {
    // INCR on a string key is a genuine Redis error, not a connection problem.
    await client.set("pipe:str", "not-a-number");

    const result = await runPipeline(
      client,
      [
        { label: "set", run: (p) => void p.set("pipe:ok", "1") },
        { label: "incr", run: (p) => void p.incr("pipe:str") },
        { label: "get", run: (p) => void p.get("pipe:ok") },
      ],
      { timeout: 5000 },
    );

    assert.equal(result.failed, 1);
    assert.equal(result.results[1].label, "incr");
    assert.match(result.results[1].error?.message ?? "", /not an integer/);
    // The commands around the failure still ran.
    assert.equal(result.results[2].value, "1");
  } finally {
    await shutdownQuietly(client);
  }
});

// --- shared helpers -------------------------------------------------------

const TEST_REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

let redisReachable: boolean | undefined;

async function redisAvailable(): Promise<boolean> {
  if (redisReachable !== undefined) {
    return redisReachable;
  }

  const probe = createClient(
    { url: TEST_REDIS_URL, connectTimeout: 500, retryStrategy: () => null },
    silentLogger,
  );

  try {
    redisReachable = (await Promise.race([
      health(probe, { timeout: 1000 }).then((r) => r.status === "up"),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
    ])) as boolean;
  } catch {
    redisReachable = false;
  } finally {
    probe.disconnect();
  }

  return redisReachable;
}

async function shutdownQuietly(client: ReturnType<typeof createClient>) {
  const { shutdown } = await import("../../dist/index.js");
  await shutdown(client, silentLogger).catch(() => undefined);
  client.disconnect();
}
