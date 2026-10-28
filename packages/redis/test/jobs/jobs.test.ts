import { test } from "vitest";
import assert from "node:assert/strict";
import {
  createClient,
  silentLogger,
  createJobAtLeastOnce,
} from "@oneunit/redis";

const TEST_URL = "redis://127.0.0.1:6379/14";

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test("jobs: disabled feature exposes no active API", async () => {
  const feature = createJobAtLeastOnce({ enabled: false });

  assert.equal(feature.enabled, false);
  await assert.rejects(feature.add("any", { value: 1 }), /disabled/i);
  assert.throws(() => feature.createWorker(async () => "ok"), /disabled/i);
  await assert.rejects(feature.getCounts(), /disabled/i);
  await feature.close();
});

test("jobs: invalid configuration is rejected at creation", async () => {
  const connection = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  try {
    assert.throws(
      () => createJobAtLeastOnce({ enabled: true, connection, concurrency: 0 }),
      /positive finite/,
    );
    assert.throws(
      () => createJobAtLeastOnce({ enabled: true, connection, attempts: 0 }),
      /positive finite/,
    );
    assert.throws(
      () => createJobAtLeastOnce({ enabled: true, connection, queueName: "" }),
      /non-empty string/,
    );
    assert.throws(
      () =>
        createJobAtLeastOnce({
          enabled: true,
          connection,
          backoff: { type: "fixed", delay: -1 },
        }),
      /non-negative finite/,
    );
  } finally {
    try {
      await connection.disconnect();
    } catch {
      // ignore
    }
  }
});

test("jobs: successful enqueue and process", async () => {
  const connection = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  const queueName = uniqueName("jobs-success");
  const feature = createJobAtLeastOnce({
    enabled: true,
    connection,
    queueName,
    attempts: 1,
  });

  const received: unknown[] = [];
  const worker = feature.createWorker(async (job) => {
    received.push(job.data);
    return "processed";
  });

  const completed = new Promise<void>((resolve) => {
    worker.on("completed", () => resolve());
  });

  try {
    const job = await feature.add("task", { value: 42 });
    assert.ok(job.id);

    await completed;
    assert.deepEqual(received, [{ value: 42 }]);

    const counts = await feature.getCounts();
    assert.ok(typeof counts === "object");
    assert.equal(feature.status().enabled, true);
    assert.equal(feature.status().isClosed, false);
  } finally {
    await worker.close().catch(() => undefined);
    await feature.close().catch(() => undefined);
    try {
      await connection.disconnect();
    } catch {
      // ignore
    }
  }
});

test("jobs: exhausted retries report a failed job", async () => {
  const connection = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  const queueName = uniqueName("jobs-failed");
  const feature = createJobAtLeastOnce({
    enabled: true,
    connection,
    queueName,
    attempts: 2,
    backoff: { type: "fixed", delay: 10 },
  });

  const worker = feature.createWorker(async () => {
    throw new Error("handler exploded");
  });

  const failed = new Promise<Error>((resolve) => {
    worker.on("failed", (_job, err) => resolve(err));
  });

  try {
    await feature.add("task", { value: 1 });
    const error = await failed;

    assert.match(error.message, /handler exploded/);
  } finally {
    await worker.close().catch(() => undefined);
    await feature.close().catch(() => undefined);
    try {
      await connection.disconnect();
    } catch {
      // ignore
    }
  }
});

test("jobs: shutdown is idempotent", async () => {
  const connection = createClient({ url: TEST_URL, lazyConnect: true }, silentLogger);
  const queueName = uniqueName("jobs-shutdown");
  const feature = createJobAtLeastOnce({
    enabled: true,
    connection,
    queueName,
    attempts: 1,
  });

  try {
    await feature.close();
    await feature.close();
    assert.equal(feature.status().isClosed, true);
  } finally {
    // Give any background cleanup a moment to settle
    await new Promise((r) => setTimeout(r, 50));
    try {
      await connection.quit();
    } catch {
      // Connection may already be closed by queue/events teardown
      try {
        connection.disconnect();
      } catch {
        // ignore
      }
    }
  }
});

test("jobs: createClient disabled does not allocate processing resources", async () => {
  const client = createClient(
    { url: TEST_URL, jobAtLeastOnce: { enabled: false, queueName: "disabled-queue" } },
    silentLogger,
  ) as any;

  assert.equal(client.jobAtLeastOnce.enabled, false);
  assert.equal(client.jobAtLeastOnce.status().isClosed, true);
  await client.jobAtLeastOnce.close();
  try {
    await client.disconnect();
  } catch {
    // ignore
  }
});
