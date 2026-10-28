import { test } from "vitest";
import assert from "node:assert/strict";
import { createClient, createQueue, createWorker, addJob, closeQueue, shutdown, silentLogger } from "@oneunit/redis";
import { cachedRedisAvailable, TEST_REDIS_URL } from "../helpers.js";

const redisUp = cachedRedisAvailable();
const TEST_DB = TEST_REDIS_URL.endsWith("/") ? TEST_REDIS_URL + "1" : `${TEST_REDIS_URL}/1`;

function uniqueName(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test("repro middleware", async () => {
  if (!(await redisUp())) return;
  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("worker-middleware");
  const queue = createQueue({ name: queueName, connection: client });
  const executionOrder: string[] = [];
  const worker = createWorker({
    name: queueName,
    connection: client,
    concurrency: 1,
    processor: async (_job) => { executionOrder.push("processor"); return "done"; },
    middleware: [
      async (_job, _token, _signal, next) => { executionOrder.push("middleware-1-before"); const result = await next(); executionOrder.push("middleware-1-after"); return result; },
      async (_job, _token, _signal, next) => { executionOrder.push("middleware-2-before"); const result = await next(); executionOrder.push("middleware-2-after"); return result; },
    ],
  });
  try {
    await worker.waitUntilReady();
    const completed = new Promise<void>((resolve) => { worker.on("completed", () => resolve()); });
    await addJob(queue, "middleware-test", { value: 1 });
    await completed;
    assert.deepEqual(executionOrder, ["middleware-1-before","middleware-2-before","processor","middleware-2-after","middleware-1-after"]);
  } finally {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await closeQueue(queue);
    await shutdown(client);
  }
});
