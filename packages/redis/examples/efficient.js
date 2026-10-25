/**
 * Efficient, end-to-end usage of @oneunit/redis.
 *
 *   npm run example:efficient
 *
 * Demonstrates, in one process, the pieces that matter for real workloads:
 *   - one shared client for Redis, cache, pipeline, queue, worker and jobs
 *   - read-through cache with L1 caching and metrics
 *   - labelled pipeline for batching
 *   - BullMQ queue + worker with retries/backoff
 *   - scheduled and recurring jobs
 *   - job middleware and tracing
 *   - dead-letter queue handling
 *   - optional at-least-once job processing on the same client
 *   - deterministic, bounded teardown
 *
 * Environment:
 *   REDIS_URL    connection URL (default redis://localhost:6379)
 *   REDIS_SILENT set to "true" to suppress connection-event logging
 */
import {
  createClient,
  createRedisCache,
  createQueue,
  createWorker,
  attachQueueEvents,
  runPipeline,
  health,
  shutdown,
  addJob,
  addBulkJobs,
  scheduleJob,
  removeJobScheduler,
  getJobSchedulers,
  pauseQueue,
  resumeQueue,
  isQueuePaused,
  getQueueCounts,
  createDlqQueue,
  moveToDlq,
  getDlqEntries,
  createJobRegistry,
  validateJobData,
  createErrorClassifier,
  createTracingMiddleware,
  createPerQueuePolicyRegistry,
  registerQueuePolicy,
  getQueuePolicy,
  getQueueHealth,
  createFlowProducer,
  addFlow,
} from "@oneunit/redis";
import {
  REDIS_URL,
  exampleLogger,
  isReady,
  onFailure,
  release,
  run,
  within,
} from "./_setup.js";

await run("efficient", async () => {
  const redis = createClient(
    {
      url: REDIS_URL,
      jobAtLeastOnce: {
        enabled: true,
        queueName: "efficient-jobs",
        attempts: 3,
        backoff: { type: "exponential", delay: 500 },
        concurrency: 2,
        dlq: { queueName: "efficient-jobs", preservePayload: true, sanitizeFields: ["password", "token"] },
      },
    },
    exampleLogger,
  );
  onFailure(() => shutdown(redis, exampleLogger));
  onFailure(() => redis.jobAtLeastOnce.close());

  const healthResult = await health(redis);
  if (healthResult.status === "down") {
    console.log("Redis is not reachable, stopping here.");
    console.log("Health:", healthResult);
    await release();
    return;
  }

  // --- Read-through cache with L1 ---
  const cache = createRedisCache(redis, {
    defaultTtlSeconds: 60,
    localL1: { enabled: true, ttlSeconds: 30 },
    metrics: true,
  });
  onFailure(() => cache.shutdown());

  await cache.set("user:1", { name: "Ada" });
  const cached = await cache.get("user:1");
  console.log("cache get:", cached);
  const loaded = await cache.getOrLoad("user:2", async () => ({ name: "Grace" }));
  console.log("cache getOrLoad:", loaded, "metrics:", cache.metrics());

  // --- Pipeline batching ---
  const pipe = await runPipeline(redis, [
    { label: "set:a", run: (p) => void p.set("counter:a", "1") },
    { label: "set:b", run: (p) => void p.set("counter:b", "2") },
    { label: "get:a", run: (p) => void p.get("counter:a") },
  ]);
  console.log("pipeline:", pipe.failed, "failed,", pipe.results.length, "results");

  // --- BullMQ queue + worker with middleware ---
  const queue = createQueue({ name: "efficient-queue", connection: redis });
  onFailure(() => queue.close());
  const events = attachQueueEvents({ queue, logger: exampleLogger });
  onFailure(() => events.close());

  const tracingMiddleware = createTracingMiddleware({
    enabled: true,
    tracer: {
      startSpan: (name, options) => ({
        setStatus: (status) => console.log(`Span ${name} status:`, status),
        recordException: (error) => console.log(`Span ${name} error:`, error.message),
        end: () => console.log(`Span ${name} ended`),
      }),
    },
  });

  const worker = createWorker({
    name: "efficient-queue",
    connection: redis,
    concurrency: 2,
    processor: async (job) => {
      await new Promise((r) => setTimeout(r, 20));
      return { processed: true, id: job.id };
    },
    middleware: [
      tracingMiddleware,
      async (job, token, signal, next) => {
        console.log(`[middleware] Job ${job.id} starting`);
        const result = await next();
        console.log(`[middleware] Job ${job.id} completed`);
        return result;
      },
    ],
  });
  onFailure(() => worker.close(true));

  if (!(await isReady(queue.waitUntilReady(), "Queue"))) return;
  if (!(await isReady(events.waitUntilReady(), "Queue events"))) return;
  if (!(await isReady(worker.waitUntilReady(), "Worker"))) return;

  const done = new Promise((resolve) => {
    events.on("completed", ({ jobId }) => resolve(jobId));
  });
  const job = await addJob(queue, "work", { hello: "world" });
  console.log("enqueued job", job.id);
  await within(done, 10000);

  // --- Scheduled and recurring jobs ---
  console.log("\n--- Scheduling jobs ---");
  // One-time delayed job
  const delayedJob = await addJob(queue, "delayed-task", { data: "run after 1s" }, { delay: 1000 });
  console.log("delayed job:", delayedJob.id);

  // Recurring job (every minute)
  const recurringJob = await scheduleJob(queue, "recurring-task", { data: "recurring" }, {
    pattern: "* * * * *", // Every minute
  });
  console.log("recurring job scheduled:", recurringJob?.id);

  const schedulers = await getJobSchedulers(queue);
  console.log("active schedulers:", schedulers.length);

  // Clean up recurring job
  if (recurringJob) {
    await removeJobScheduler(queue, recurringJob.id ?? recurringJob.key);
  }

  // --- Queue pause/resume ---
  console.log("\n--- Queue pause/resume ---");
  console.log("queue paused:", await isQueuePaused(queue));
  await pauseQueue(queue);
  console.log("queue paused after pause:", await isQueuePaused(queue));
  await resumeQueue(queue);
  console.log("queue paused after resume:", await isQueuePaused(queue));

  // --- Queue health ---
  const queueHealth = await getQueueHealth(queue);
  console.log("queue health:", queueHealth);

  // --- Bulk enqueue ---
  console.log("\n--- Bulk enqueue ---");
  const bulkJobs = await addBulkJobs(queue, [
    { name: "bulk-1", data: { idx: 1 } },
    { name: "bulk-2", data: { idx: 2 } },
    { name: "bulk-3", data: { idx: 3 } },
  ]);
  console.log("bulk enqueued:", bulkJobs.length, "jobs");

  const counts = await getQueueCounts(queue);
  console.log("queue counts:", counts);

  // --- Dead Letter Queue ---
  console.log("\n--- Dead Letter Queue ---");
  const dlqQueue = createDlqQueue(redis, { queueName: "efficient-queue", preservePayload: true });
  onFailure(() => dlqQueue.close());

  // Simulate a failed job moving to DLQ
  await dlqQueue.add("dead-letter", {
    originalQueueName: queue.name,
    originalJobId: "failed-job-1",
    jobName: "fail-task",
    payload: { data: "will fail", password: "secret" },
    failedReason: "Simulated failure",
    attemptsMade: 3,
    failedAt: Date.now(),
    originalAttempts: 3,
  });

  const dlqEntries = await getDlqEntries(dlqQueue, 0, 10);
  console.log("DLQ entries:", dlqEntries.length);
  if (dlqEntries.length > 0) {
    console.log("First DLQ entry:", {
      jobName: dlqEntries[0].jobName,
      failedReason: dlqEntries[0].failedReason,
      payloadKeys: Object.keys(dlqEntries[0].payload),
      hasPassword: "password" in dlqEntries[0].payload,
    });
  }

  // --- Typed Job Registry ---
  console.log("\n--- Typed Job Registry ---");
  const jobRegistry = createJobRegistry({
    "send-email": {
      data: { to: "string", subject: "string", body: "string" },
      result: { messageId: "string" },
    },
    "process-payment": {
      data: { amount: "number", currency: "string" },
      result: { transactionId: "string" },
    },
  });

  const emailData = { to: "user@example.com", subject: "Hello", body: "World" };
  console.log("validate send-email:", validateJobData(jobRegistry, "send-email", emailData));
  console.log("validate unknown:", validateJobData(jobRegistry, "unknown-job", emailData));

  // --- Error Classification ---
  console.log("\n--- Error Classification ---");
  const classifier = createErrorClassifier();
  console.log("validation error:", classifier(new Error("Validation failed: invalid email")));
  console.log("timeout error:", classifier(new Error("ETIMEDOUT: connection timed out")));
  console.log("rate limit error:", classifier(new Error("Rate limit exceeded: 429")));
  console.log("unknown error:", classifier(new Error("Something went wrong")));

  // --- Per-Queue Policies ---
  console.log("\n--- Per-Queue Policies ---");
  const policyRegistry = createPerQueuePolicyRegistry();
  registerQueuePolicy(policyRegistry, "high-priority", {
    defaultJobOptions: { priority: 1 },
    retry: { attempts: 5, backoff: { type: "exponential", delay: 2000 } },
    concurrency: 10,
  });
  registerQueuePolicy(policyRegistry, "low-priority", {
    defaultJobOptions: { priority: 10 },
    retry: { attempts: 2, backoff: { type: "fixed", delay: 5000 } },
    concurrency: 1,
  });
  console.log("high-priority policy:", getQueuePolicy(policyRegistry, "high-priority"));
  console.log("low-priority policy:", getQueuePolicy(policyRegistry, "low-priority"));

  // --- Flow Producer (Dependency Workflows) ---
  console.log("\n--- Flow Producer ---");
  const flowProducer = createFlowProducer({ connection: redis, prefix: "queue" });
  onFailure(() => flowProducer.close());
  await flowProducer.waitUntilReady();

  const flow = await addFlow(flowProducer, {
    name: "parent-task",
    queueName: "efficient-queue",
    data: { parent: true },
    children: [
      { name: "child-1", queueName: "efficient-queue", data: { child: 1 } },
      { name: "child-2", queueName: "efficient-queue", data: { child: 2 } },
    ],
  });
  console.log("flow created:", flow.job.name, "with", flow.children?.length, "children");

  // --- Optional at-least-once jobs ---
  console.log("\n--- At-least-once jobs ---");
  const aj = await redis.jobAtLeastOnce.add("task", { x: 1 });
  console.log("at-least-once job", aj.id);
  const jobWorker = redis.jobAtLeastOnce.createWorker(async (j) => ({ ok: true, data: j.data }));
  if (!(await isReady(jobWorker.waitUntilReady(), "job worker"))) return;
  console.log("queue counts:", await queue.getJobCounts(), "job counts:", await redis.jobAtLeastOnce.getCounts());

  // DLQ inspection for at-least-once
  const dlq = redis.jobAtLeastOnce.getDlq();
  if (dlq) {
    const entries = await dlq.entries(0, 5);
    console.log("at-least-once DLQ entries:", entries.length);
  }

  await release();
  console.log("\nAll done, disconnected cleanly.");
});