# BullMQ Queues & Workers (`@oneunit/redis/queue`)

BullMQ-backed queue and worker factories with production defaults, shared connections, dead-letter queues, flow producers, bulk operations, and typed middleware.

## Table of Contents

1. [Quick Start](#quick-start)
2. [createQueue](#createqueue)
3. [createWorker](#createworker)
4. [Job Operations](#job-operations)
5. [Worker Lifecycle](#worker-lifecycle)
6. [Queue Events](#queue-events)
7. [Dead Letter Queue](#dead-letter-queue)
8. [Scheduled & Recurring Jobs](#scheduled--recurring-jobs)
9. [Queue Management](#queue-management)
10. [Middleware](#middleware)
11. [Production Defaults](#production-defaults)
12. [API Reference](#api-reference)
13. [Operational Notes](#operational-notes)

---

## Quick Start

```typescript
import { createClient, createQueue, createWorker, shutdown } from '@oneunit/redis';

const redis = createClient({ url: process.env.REDIS_URL });

const queue = createQueue({
  name: 'emails',
  connection: redis,
  prefix: 'queue',
});

const worker = createWorker({
  name: 'emails',
  connection: redis,
  processor: async (job) => {
    await sendEmail(job.data.to, job.data.body);
    return { sent: true };
  },
});

await queue.add('send-email', { to: 'user@example.com', body: 'Hello' });

await shutdown(redis);
```

---

## createQueue

Creates a BullMQ `Queue` with production-safe defaults and a shared connection.

### Signature

```typescript
createQueue(config: QueueConfig): Queue;
```

### QueueConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | — | Queue name |
| `connection` | `Redis` | — | Shared ioredis client |
| `prefix` | `string` | `'queue'` | Redis key prefix |
| `defaultJobOptions` | `JobsOptions` | see below | Default options for all jobs |
| `settings` | `QueueOptions["settings"]` | — | BullMQ queue settings |

### Default job options

| Field | Default |
|-------|---------|
| `removeOnComplete` | `100` |
| `removeOnFail` | `1000` |
| `attempts` | `3` |
| `backoff` | `{ type: 'exponential', delay: 1000 }` |

```typescript
const queue = createQueue({
  name: 'emails',
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 500,
    removeOnFail: 2000,
  },
});
```

---

## createWorker

Creates a BullMQ `Worker` with optional middleware chaining.

### Signature

```typescript
createWorker<TData, TResult>(config: WorkerConfig<TData, TResult>): WorkerWithMiddleware<TData, TResult>;
```

### WorkerConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | — | Worker name (matches queue) |
| `processor` | `Processor` | — | Job processing function |
| `connection` | `Redis` | — | Shared ioredis client |
| `prefix` | `string` | `'queue'` | Redis key prefix |
| `concurrency` | `number` | — | Max concurrent jobs |
| `limiter` | `WorkerOptions["limiter"]` | — | Rate limit jobs |
| `settings` | `WorkerOptions["settings"]` | — | BullMQ worker settings |
| `middleware` | `JobMiddleware[]` | `[]` | Middleware chain |

### Usage

```typescript
import { createWorker } from '@oneunit/redis/queue';

const worker = createWorker({
  name: 'emails',
  connection: redis,
  concurrency: 10,
  processor: async (job) => {
    await processJob(job.data);
    return { success: true };
  },
});
```

### WorkerWithMiddleware

`createWorker` returns a `WorkerWithMiddleware` that supports chaining:

```typescript
const worker = createWorker({ ... })
  .use((job, token, signal, next) => {
    console.log(`Starting job ${job.id}`);
    return next();
  })
  .use((job, token, signal, next) => {
    return next();
  });
```

---

## Job Operations

```typescript
import { addJob, addBulkJobs, scheduleJob, getJobSchedulers, removeJobScheduler } from '@oneunit/redis/queue';

// Single job
const job = await addJob(queue, 'send-email', { to: 'a@b.com' }, { attempts: 3 });

// Bulk jobs
const jobs = await addBulkJobs(queue, [
  { name: 'send-email', data: { to: 'a@b.com' } },
  { name: 'send-email', data: { to: 'c@d.com' } },
]);

// Scheduled (recurring) job
await scheduleJob(queue, 'daily-report', {}, { pattern: '0 9 * * *' });

// List schedulers
const schedulers = await getJobSchedulers(queue);

// Remove a scheduler
await removeJobScheduler(queue, schedulerId);
```

---

## Worker Lifecycle

```typescript
import { pauseWorker, resumeWorker, isWorkerPaused, isWorkerRunning, closeWorker, cancelWorkerJob, cancelAllWorkerJobs } from '@oneunit/redis/queue';

await pauseWorker(worker);
await resumeWorker(worker);

const paused = isWorkerPaused(worker);
const running = isWorkerRunning(worker);

await closeWorker(worker);          // graceful
await closeWorker(worker, true);    // force

await cancelWorkerJob(worker, jobId, 'cancelled by user');
await cancelAllWorkerJobs(worker, 'shutdown');
```

---

## Queue Events

```typescript
import { attachQueueEvents } from '@oneunit/redis/queue';

attachQueueEvents({
  queue,
  logger,
  prefix: 'queue',
  connection: redis,
});
```

Automatically inherits the queue's prefix. Listens for BullMQ queue events (completed, failed, stalled, etc.).

---

## Dead Letter Queue

```typescript
import { createDlqQueue, moveToDlq, replayDlqJob, getDlqEntries } from '@oneunit/redis/queue';

const dlqQueue = createDlqQueue(connection, {
  queueName: 'emails',
  preservePayload: true,
  sanitizeFields: ['password', 'token'],
});

// Move a failed job to DLQ
await moveToDlq(queue, dlqQueue, jobId, {
  queueName: 'emails',
  preservePayload: true,
  sanitizeFields: ['password', 'token'],
});

// Replay a DLQ job
await replayDlqJob(dlqQueue, queue, jobId);

// List DLQ entries
const entries = await getDlqEntries(dlqQueue, 0, 100);
```

DLQ config (`DLQConfig`):

| Field | Type | Description |
|-------|------|-------------|
| `queueName` | `string` | Base queue name (creates `${queueName}-dlq`) |
| `maxRetries` | `number` | Optional maximum retries before DLQ |
| `preservePayload` | `boolean` | When true, preserves sanitized job data |
| `sanitizeFields` | `string[]` | List of payload fields to redact as `"[redacted]"` |

---

## Scheduled & Recurring Jobs

```typescript
import { scheduleJob, removeJobScheduler, getJobSchedulers } from '@oneunit/redis/queue';

// Recurring job with cron pattern
await scheduleJob(queue, 'daily-cleanup', {}, {
  pattern: '0 3 * * *',
  tz: 'UTC',
  limit: 100,
});

// Remove a scheduled job
await removeJobScheduler(queue, schedulerId);

// List all scheduled jobs
const schedulers = await getJobSchedulers(queue);
```

---

## Queue Management

```typescript
import { pauseQueue, resumeQueue, isQueuePaused, getQueueCounts, drainQueue, cleanQueue, closeQueue, obliterateQueue } from '@oneunit/redis/queue';

await pauseQueue(queue);
await resumeQueue(queue);
const paused = await isQueuePaused(queue);

const counts = await getQueueCounts(queue);
// { waiting: 5, active: 2, completed: 100, failed: 3, ... }

await drainQueue(queue);           // removes all waiting jobs from queue
await drainQueue(queue, true);     // removes delayed jobs as well

await cleanQueue(queue, 3600, 100, 'completed');  // clean jobs older than 1h

await closeQueue(queue);
await obliterateQueue(queue);      // destroy queue and all jobs
await obliterateQueue(queue, true); // force
```

---

## Middleware

Job middleware wraps the processor with a chainable `next` pattern:

```typescript
interface JobMiddleware<TData, TResult> {
  (job: Job<TData, TResult>, token: string | undefined, signal: AbortSignal | undefined, next: () => Promise<TResult>): Promise<TResult>;
}
```

Example — logging + timing middleware:

```typescript
const loggingMiddleware = (job, token, signal, next) => {
  const start = Date.now();
  return next().then((result) => {
    console.log(`Job ${job.id} completed in ${Date.now() - start}ms`);
    return result;
  });
};

const worker = createWorker({
  name: 'emails',
  connection: redis,
  processor: async (job) => { ... },
  middleware: [loggingMiddleware],
});
```

---

## Production Defaults

| Setting | Value | Rationale |
|---------|-------|-----------|
| `removeOnComplete` | `100` | Retain last 100 completed jobs |
| `removeOnFail` | `1000` | Retain last 1000 failed jobs |
| `attempts` | `3` | Retry failed jobs 3 times |
| `backoff` | `{ type: 'exponential', delay: 1000 }` | Exponential backoff starting at 1s |
| `maxRetriesPerRequest` | `null` | No infinite command retries |

Defaults can be overridden per-queue via `defaultJobOptions` or per-job via `JobsOptions`.

---

## API Reference

### Exports

```typescript
import {
  Queue, Worker, QueueEvents,
  createQueue, addJob, addBulkJobs, scheduleJob,
  removeJobScheduler, getJobSchedulers, pauseQueue, resumeQueue,
  isQueuePaused, getQueueCounts, drainQueue, cleanQueue,
  closeQueue, obliterateQueue,
  createWorker, pauseWorker, resumeWorker, isWorkerPaused,
  isWorkerRunning, closeWorker, cancelWorkerJob, cancelAllWorkerJobs,
  attachQueueEvents,
  createDlqQueue, moveToDlq, replayDlqJob, getDlqEntries,
  createQueueWithPolicy, mergePolicyIntoQueueOptions,
  enqueueJob, enqueueBulkJobs, cancelJob, getJobProgress, getJobResult,
  getQueueHealth, getWorkerHealth, gracefulDrainWorker,
  createFlowProducer, addFlow, addBulkFlows,
  createJobRegistry, validateJobData, validateJobResult,
  createErrorClassifier, createTracingMiddleware,
  createPerQueuePolicyRegistry, registerQueuePolicy, getQueuePolicy,
} from '@oneunit/redis/queue';
```

### Types

```typescript
import type {
  QueueConfig, WorkerConfig, JobMiddleware,
  QueueEventsConfig, QueuePolicy, PerQueuePolicies,
  DLQConfig, DLQEntry, TypedJobRegistry, JobProcessor,
  WorkerWithMiddleware, QueueLifecycleConfig, JobScheduleOptions,
  JobEnqueueOptions, BulkEnqueueOptions, JobCancellationResult,
  JobProgressUpdate, JobResult, JobState, QueueHealthSnapshot,
  WorkerHealthSnapshot, JobMiddlewareContext, FlowProducerConfig,
  TracerInterface, SpanInterface, TracingConfig,
} from '@oneunit/redis/queue';
```

Re-exported from BullMQ: `QueueOptions`, `JobsOptions`, `WorkerOptions`, `Job`, `Processor`.

---

## Operational Notes

| Concern | Behavior |
|---------|----------|
| Shared connection | Single ioredis client for client, queues, workers, rate limiters |
| Graceful shutdown | `closeWorker()` / `closeQueue()` disconnect underlying clients safely |
| DLQ | Failed jobs can be moved to and replayed from a dead-letter queue |
| Concurrency | `WorkerConfig.concurrency` limits parallel job execution |
| Rate limiting | `WorkerConfig.limiter` applies BullMQ job rate limiting |
| Prefix isolation | Per-queue `prefix` prevents key collisions |
| Events | `attachQueueEvents` with automatic prefix inheritance |
| Connection ownership | Queues/workers close owned connections on shutdown |
