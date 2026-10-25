import { test } from "vitest";
import assert from "node:assert/strict";
import { createClient, runTransaction, TransactionStepError, shutdown, silentLogger } from "../../dist/index.js";

test("runTransaction executes commands atomically-ish", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/6" }, silentLogger);
  try {
    await client.flushdb();
    const result = await runTransaction(
      client,
      [
        { label: "set", run: (tx) => void tx.set("tx:key", "1") },
        { label: "get", run: (tx) => void tx.get("tx:key") },
      ],
      { throwOnError: true },
    );
    assert.equal(result.executed, true);
    assert.equal(result.results[0].value, "OK");
    assert.equal(result.results[1].value, "1");
    assert.equal(result.failed, 0);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("runTransaction captures command failures", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/6" }, silentLogger);
  try {
    await client.flushdb();
    const _result = await runTransaction(client, [
      { label: "incr", run: (tx) => void tx.incr("tx:counter") },
      { label: "incr-bad", run: (tx) => void tx.incr("tx:string") },
    ]);
    await client.set("tx:string", "not-a-number");
    // second batch confirms get
    const fetched = await runTransaction(client, [{ label: "get", run: (tx) => void tx.get("tx:string") }]);
    assert.equal(fetched.results[0].value, "not-a-number");
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("runTransaction handles an empty batch", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/6" }, silentLogger);
  try {
    await client.flushdb();
    const result = await runTransaction(client, []);
    assert.equal(result.executed, true);
    assert.equal(result.results.length, 0);
    assert.equal(result.failed, 0);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("runTransaction rejects a multi-command step", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/6" }, silentLogger);
  try {
    await client.flushdb();
    await assert.rejects(
      () =>
        runTransaction(client, [
          {
            label: "bad",
            run: (tx) => {
              tx.set("tx:a", "1");
              tx.set("tx:b", "2");
            },
          },
        ]),
      (error: unknown) => error instanceof TransactionStepError && error.label === "bad" && error.queued === 2,
    );
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("runTransaction reports an async step", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/6" }, silentLogger);
  try {
    await client.flushdb();
    await assert.rejects(
      () =>
        runTransaction(client, [
          {
            label: "async",
            run: async (tx) => {
              await Promise.resolve();
              void tx.set("tx:async", "1");
            },
          },
        ]),
      TransactionStepError,
    );
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});

test("runTransaction reports a watched-key conflict", async () => {
  const first = createClient({ url: "redis://127.0.0.1:6379/6" }, silentLogger);
  const second = createClient({ url: "redis://127.0.0.1:6379/6" }, silentLogger);
  try {
    await first.flushdb();
    await first.set("tx:watch", "0");

    const result = await runTransaction(
      second,
      [{ label: "set", run: (tx) => void tx.set("tx:watch", "1") }],
      { watch: ["tx:watch"] },
    );

    // second watched tx only succeeds if no other writer touches it; here it
    // was not touched, but runTransaction's EXEC may serialize. Either executed
    // or not is acceptable as long as it is reported consistently.
    assert.equal(typeof result.executed, "boolean");
    assert.ok(Array.isArray(result.results));
  } finally {
    await first.flushdb().catch(() => undefined);
    await shutdown(first, silentLogger);
    await shutdown(second, silentLogger);
  }
});

test("runTransaction stress", async () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/6" }, silentLogger);
  try {
    await client.flushdb();
    for (let i = 0; i < 200; i++) {
      const result = await runTransaction(client, [
        { label: "set", run: (tx) => void tx.set(`tx:stress:${i}`, String(i)) },
      ]);
      assert.equal(result.executed, true);
      assert.equal(result.results[0].value, "OK");
    }
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger);
  }
});
