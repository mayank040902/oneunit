import { test } from "vitest";
import assert from "node:assert/strict";
import { cachedRedisAvailable, TEST_REDIS_URL } from "../helpers.js";
import {
  createClient,
  createQueue,
  createWorker,
  addJob,
  addBulkJobs,
  scheduleJob,
  removeJobScheduler,
  getJobSchedulers,
  pauseQueue,
  resumeQueue,
  isQueuePaused,
  getQueueCounts,
  drainQueue,
  closeQueue,
  shutdown,
  silentLogger,
  createJobRegistry,
  validateJobData,
  createErrorClassifier,
  createTracingMiddleware,
  createPerQueuePolicyRegistry,
  registerQueuePolicy,
  getQueuePolicy,
  createDlqQueue,
  getDlqEntries,
  createFlowProducer,
  addFlow,
  addBulkFlows,
} from "@oneunit/redis";

const redisUp = cachedRedisAvailable();
const TEST_DB = TEST_REDIS_URL.endsWith("/") ? TEST_REDIS_URL + "1" : `${TEST_REDIS_URL}/1`;

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test("queue: addJob enqueues a job", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("queue-add");
  const queue = createQueue({ name: queueName, connection: client });

  try {
    const job = await addJob(queue, "test-job", { value: 42 });
    assert.ok(job.id);
    assert.equal(job.name, "test-job");
    assert.deepEqual(job.data, { value: 42 });
  } finally {
    await queue.obliterate({ force: true }).catch(() => {});
    await closeQueue(queue);
    await shutdown(client);
  }
});

test("queue: addBulkJobs enqueues multiple jobs", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("queue-bulk");
  const queue = createQueue({ name: queueName, connection: client });

  try {
    const jobs = await addBulkJobs(queue, [
      { name: "bulk-1", data: { idx: 1 } },
      { name: "bulk-2", data: { idx: 2 } },
      { name: "bulk-3", data: { idx: 3 } },
    ]);
    assert.equal(jobs.length, 3);
    assert.ok(jobs.every((j) => j.id));
  } finally {
    await queue.obliterate({ force: true }).catch(() => {});
    await closeQueue(queue);
    await shutdown(client);
  }
});

test("queue: scheduleJob creates recurring job", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("queue-schedule");
  const queue = createQueue({ name: queueName, connection: client });

  try {
    const job = await scheduleJob(queue, "recurring-job", { data: "test" }, {
      pattern: "*/1 * * * *", // every minute
    });
    assert.ok(job?.id);
    assert.equal(job?.name, "recurring-job");

    const schedulers = await getJobSchedulers(queue);
    assert.equal(schedulers.length, 1);
    assert.equal(schedulers[0].name, "recurring-job");

    await removeJobScheduler(queue, schedulers[0].id ?? schedulers[0].key);
    const afterRemove = await getJobSchedulers(queue);
    assert.equal(afterRemove.length, 0);
  } finally {
    await queue.obliterate({ force: true }).catch(() => {});
    await closeQueue(queue);
    await shutdown(client);
  }
});

test("queue: pause and resume queue", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("queue-pause");
  const queue = createQueue({ name: queueName, connection: client });

  try {
    assert.equal(await isQueuePaused(queue), false);
    await pauseQueue(queue);
    assert.equal(await isQueuePaused(queue), true);
    await resumeQueue(queue);
    assert.equal(await isQueuePaused(queue), false);
  } finally {
    await queue.obliterate({ force: true }).catch(() => {});
    await closeQueue(queue);
    await shutdown(client);
  }
});

test("queue: getQueueCounts returns counts", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("queue-counts");
  const queue = createQueue({ name: queueName, connection: client });

  try {
    await addJob(queue, "count-job", { value: 1 });
    await addJob(queue, "count-job", { value: 2 });

    const counts = await getQueueCounts(queue);
    assert.ok(counts.waiting >= 2);
  } finally {
    await queue.obliterate({ force: true }).catch(() => {});
    await closeQueue(queue);
    await shutdown(client);
  }
});

test("queue: drainQueue removes waiting jobs", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("queue-drain");
  const queue = createQueue({ name: queueName, connection: client });

  try {
    await addJob(queue, "drain-job", { value: 1 });
    await addJob(queue, "drain-job", { value: 2 });

    let counts = await getQueueCounts(queue);
    assert.ok(counts.waiting >= 2);

    await drainQueue(queue);
    counts = await getQueueCounts(queue);
    assert.equal(counts.waiting, 0);
  } finally {
    await queue.obliterate({ force: true }).catch(() => {});
    await closeQueue(queue);
    await shutdown(client);
  }
});

test("queue: closeQueue closes queue", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("queue-close");
  const queue = createQueue({ name: queueName, connection: client });

  await closeQueue(queue);
  // Should not throw on double close
  await closeQueue(queue);

  await shutdown(client);
});

test("queue: worker middleware executes in order", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("worker-middleware");
  const queue = createQueue({ name: queueName, connection: client });

  const executionOrder: string[] = [];

  const worker = createWorker({
    name: queueName,
    connection: client,
    concurrency: 1,
    processor: async (_job) => {
      executionOrder.push("processor");
      return "done";
    },
    middleware: [
      async (_job, _token, _signal, next) => {
        executionOrder.push("middleware-1-before");
        const result = await next();
        executionOrder.push("middleware-1-after");
        return result;
      },
      async (_job, _token, _signal, next) => {
        executionOrder.push("middleware-2-before");
        const result = await next();
        executionOrder.push("middleware-2-after");
        return result;
      },
    ],
  });

  try {
    await worker.waitUntilReady();

    const completed = new Promise<void>((resolve) => {
      worker.on("completed", () => resolve());
    });

    await addJob(queue, "middleware-test", { value: 1 });
    await completed;

    assert.deepEqual(executionOrder, [
      "middleware-1-before",
      "middleware-2-before",
      "processor",
      "middleware-2-after",
      "middleware-1-after",
    ]);
  } finally {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await closeQueue(queue);
    await shutdown(client);
  }
});

test("queue: worker.use adds middleware dynamically", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("worker-use");
  const queue = createQueue({ name: queueName, connection: client });

  const executionOrder: string[] = [];

  const worker = createWorker({
    name: queueName,
    connection: client,
    concurrency: 1,
    processor: async (_job) => {
      executionOrder.push("processor");
      return "done";
    },
  });

  worker.use(async (_job, _token, _signal, next) => {
    executionOrder.push("dynamic-middleware-before");
    const result = await next();
    executionOrder.push("dynamic-middleware-after");
    return result;
  });

  try {
    await worker.waitUntilReady();

    const completed = new Promise<void>((resolve) => {
      worker.on("completed", () => resolve());
    });

    await addJob(queue, "dynamic-test", { value: 1 });
    await completed;

    assert.deepEqual(executionOrder, [
      "dynamic-middleware-before",
      "processor",
      "dynamic-middleware-after",
    ]);
  } finally {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await closeQueue(queue);
    await shutdown(client);
  }
});

test("queue: worker pause and resume", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("worker-pause");
  const queue = createQueue({ name: queueName, connection: client });

  const worker = createWorker({
    name: queueName,
    connection: client,
    concurrency: 1,
    processor: async () => "done",
  });

  try {
    await worker.waitUntilReady();
    assert.equal(worker.isPaused(), false);
    assert.equal(worker.isRunning(), true);

    await pauseQueue(queue);
    assert.equal(worker.isPaused(), false); // worker pause is separate from queue pause

    worker.pause(true);
    assert.equal(worker.isPaused(), true);

    worker.resume();
    assert.equal(worker.isPaused(), false);
  } finally {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await closeQueue(queue);
    await shutdown(client);
  }
});

test("queue: cancelWorkerJob cancels active job", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("worker-cancel");
  const queue = createQueue({ name: queueName, connection: client });

  let jobId: string | undefined;
  let jobStarted = false;
  // Use a regular function to ensure processor.length >= 3
  function processor(job: any, token: string, signal: AbortSignal) {
    jobId = job.id;
    jobStarted = true;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, 5000);
      signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new Error("Job cancelled"));
      });
    });
  }

  const worker = createWorker({
    name: queueName,
    connection: client,
    concurrency: 1,
    processor,
  });

  try {
    await worker.waitUntilReady();

    await addJob(queue, "cancel-test", { value: 1 });

    // Wait for job to become active
    while (!jobStarted) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(jobId);
    const cancelled = await worker.cancelJob(jobId!);
    assert.equal(cancelled, true);
  } finally {
    await worker.close(true);
    await queue.obliterate({ force: true }).catch(() => {});
    await closeQueue(queue);
    await shutdown(client);
  }
});

test("queue: createJobRegistry creates typed registry", async () => {
  const registry = createJobRegistry({
    "send-email": {
      data: { to: "string", subject: "string", body: "string" },
      result: { messageId: "string" },
    },
    "process-payment": {
      data: { amount: "number", currency: "string" },
      result: { transactionId: "string" },
    },
  });

  assert.ok("send-email" in registry);
  assert.ok("process-payment" in registry);
  assert.deepEqual(registry["send-email"].data, { to: "string", subject: "string", body: "string" });
});

test("queue: validateJobData validates job name exists in registry", async () => {
  const registry = createJobRegistry({
    "send-email": {
      data: { to: "string", subject: "string" },
      result: { messageId: "string" },
    },
  });

  // validateJobData is a type guard that checks if jobName exists in registry
  // It doesn't validate the data structure at runtime
  assert.equal(validateJobData(registry, "send-email", { to: "test@test.com", subject: "Hello" }), true);
  assert.equal(validateJobData(registry, "send-email", { to: "test@test.com" }), true); // Still true because jobName exists
  assert.equal(validateJobData(registry, "unknown-job", { to: "test@test.com" }), false);
});

test("queue: createErrorClassifier classifies errors", async () => {
  const classifier = createErrorClassifier();

  const validationError = new Error("Validation failed: invalid input");
  assert.equal(classifier(validationError).retryable, false);
  assert.equal(classifier(validationError).category, "validation");

  const timeoutError = new Error("ETIMEDOUT: connection timed out");
  assert.equal(classifier(timeoutError).retryable, true);
  assert.equal(classifier(timeoutError).category, "transient");

  const rateLimitError = new Error("Rate limit exceeded: 429");
  assert.equal(classifier(rateLimitError).retryable, true);
  assert.equal(classifier(rateLimitError).category, "transient");

  const unknownError = new Error("Something went wrong");
  assert.equal(classifier(unknownError).retryable, true);
  assert.equal(classifier(unknownError).category, "unknown");
});

test("queue: custom error classifier overrides defaults", async () => {
  const customClassifier = (error: Error) => ({
    retryable: error.message === "please retry this",
    category: "custom",
  });

  const classifier = createErrorClassifier(customClassifier);

  assert.equal(classifier(new Error("please retry this")).retryable, true);
  assert.equal(classifier(new Error("please retry this")).category, "custom");
  assert.equal(classifier(new Error("do not retry this")).retryable, false);
  assert.equal(classifier(new Error("do not retry this")).category, "custom");
});

test("queue: createTracingMiddleware creates no-op when disabled", async () => {
  const middleware = createTracingMiddleware({ enabled: false });
  const result = await middleware(
    { job: {} as any, queueName: "test", attemptNumber: 1, isRetry: false },
    async () => "result"
  );
  assert.equal(result, "result");
});

test("queue: createTracingMiddleware traces when enabled", async () => {
  const spans: any[] = [];
  const tracer = {
    startSpan: (name: string, _options?: any) => ({
      setStatus: (status: any) => spans.push({ name, status }),
      recordException: (error: Error) => spans.push({ name, error }),
      end: () => spans.push({ name, ended: true }),
    }),
  };

  const middleware = createTracingMiddleware({ enabled: true, tracer });

  await middleware(
    { job: { name: "test-job", id: "1" } as any, queueName: "test", attemptNumber: 1, isRetry: false },
    async () => "result"
  );

  assert.ok(spans.some((s) => s.name === "job.test-job" && s.status?.code === 1));
  assert.ok(spans.some((s) => s.ended));
});

test("queue: createTracingMiddleware records exceptions", async () => {
  const spans: any[] = [];
  const tracer = {
    startSpan: (name: string) => ({
      setStatus: (status: any) => spans.push({ name, status }),
      recordException: (error: Error) => spans.push({ name, error: error.message }),
      end: () => spans.push({ name, ended: true }),
    }),
  };

  const middleware = createTracingMiddleware({ enabled: true, tracer });

  try {
    await middleware(
      { job: { name: "failing-job", id: "1" } as any, queueName: "test", attemptNumber: 1, isRetry: false },
      async () => {
        throw new Error("processing failed");
      }
    );
  } catch {
    // expected
  }

  assert.ok(spans.some((s) => s.error === "processing failed"));
  assert.ok(spans.some((s) => s.status?.code === 2));
});

test("queue: per-queue policy registry", async () => {
  const registry = createPerQueuePolicyRegistry();

  registerQueuePolicy(registry, "high-priority", {
    defaultJobOptions: { priority: 1 },
    retry: { attempts: 5, backoff: { type: "exponential", delay: 2000 } },
    concurrency: 10,
  });

  registerQueuePolicy(registry, "low-priority", {
    defaultJobOptions: { priority: 10 },
    retry: { attempts: 2, backoff: { type: "fixed", delay: 5000 } },
    concurrency: 1,
  });

  const highPolicy = getQueuePolicy(registry, "high-priority");
  const lowPolicy = getQueuePolicy(registry, "low-priority");

  assert.ok(highPolicy);
  assert.equal(highPolicy?.retry?.attempts, 5);
  assert.equal(highPolicy?.concurrency, 10);

  assert.ok(lowPolicy);
  assert.equal(lowPolicy?.retry?.attempts, 2);
  assert.equal(lowPolicy?.concurrency, 1);

  assert.equal(getQueuePolicy(registry, "unknown"), undefined);
});

test("queue: DLQ creation and operations", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = "dlq-test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const queue = createQueue({ name: queueName, connection: client });

  const dlqQueue = createDlqQueue(client, { queueName });

  try {
    await addJob(queue, "fail-job", { value: "will fail" });

    const dlqEntry = await dlqQueue.add("dead-letter", {
      originalQueueName: queueName,
      originalJobId: "test-id",
      jobName: "fail-job",
      payload: { value: "will fail" },
      failedReason: "test error",
      attemptsMade: 3,
      failedAt: Date.now(),
      originalAttempts: 3,
    });

    assert.ok(dlqEntry.id);

    const entries = await getDlqEntries(dlqQueue, 0, 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].originalQueueName, queueName);
    assert.equal(entries[0].jobName, "fail-job");
  } finally {
    await dlqQueue.obliterate({ force: true }).catch(() => {});
    await closeQueue(dlqQueue);
    await queue.obliterate({ force: true }).catch(() => {});
    await closeQueue(queue);
    await shutdown(client);
  }
});

test("queue: FlowProducer adds flow", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("flow-producer");

  const flowProducer = createFlowProducer({ connection: client, prefix: "queue" });

  try {
    await flowProducer.waitUntilReady();

    const flow = await addFlow(flowProducer, {
      name: "parent",
      queueName: queueName,
      data: { parent: true },
      children: [
        { name: "child1", queueName: queueName, data: { child: 1 } },
        { name: "child2", queueName: queueName, data: { child: 2 } },
      ],
    });

    assert.ok(flow.job);
    assert.equal(flow.job.name, "parent");
    assert.equal(flow.children?.length, 2);
  } finally {
    await flowProducer.close();
    await shutdown(client);
  }
});

test("queue: FlowProducer addBulkFlows adds multiple flows", async () => {
  if (!(await redisUp())) return;

  const client = createClient({ url: TEST_DB }, silentLogger);
  const queueName = uniqueName("flow-bulk");

  const flowProducer = createFlowProducer({ connection: client, prefix: "queue" });

  try {
    await flowProducer.waitUntilReady();

    const flows = await addBulkFlows(flowProducer, [
      { name: "parent1", queueName: queueName, data: { idx: 1 }, children: [{ name: "child1", queueName: queueName, data: { idx: 1 } }] },
      { name: "parent2", queueName: queueName, data: { idx: 2 }, children: [{ name: "child2", queueName: queueName, data: { idx: 2 } }] },
    ]);

    assert.equal(flows.length, 2);
  } finally {
    await flowProducer.close();
    await shutdown(client);
  }
});