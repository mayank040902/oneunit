# At-Least-Once Job Processing

BullMQ-backed at-least-once job queues with retries, exponential backoff, dead-letter queues, graceful shutdown, and shared connections. Zero overhead when disabled.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Configuration](#configuration)
3. [Adding Jobs](#adding-jobs)
4. [Creating Workers](#creating-workers)
5. [Scheduled Jobs](#scheduled-jobs)
6. [Queue Lifecycle](#queue-lifecycle)
7. [Dead Letter Queue](#dead-letter-queue)
8. [JobAtLeastOnce Interface](#jobatleastonce-interface)
9. [Subpath Imports](#subpath-imports)
10. [API Reference](#api-reference)
11. [Operational Notes](#operational-notes)

---

## Quick Start

### Via createClient (recommended)

```typescript
import { createClient, shutdown } from '@oneunit/redis';

const redis = createClient({
  url: process.env.REDIS_URL,
  jobAtLeastOnce: {
    enabled: true,
    queueName: 'app-jobs',
    concurrency: 10,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    dlq: { queueName: 'app-jobs-dlq', preservePayload: true },
  },
});

const worker = redis.jobAtLeastOnce.createWorker(async (job) => {
  await doWork(job.data);
  return { success: true };
});

await redis.jobAtLeastOnce.add('send-email', { to: 'user@example.com' });

// Graceful shutdown
await redis.jobAtLeastOnce.close();
await shutdown(redis);
```

### Standalone

```typescript
import { createJobAtLeastOnce } from '@oneunit/redis';

const jobs = createJobAtLeastOnce({
  enabled: true,
  queueName: 'app-jobs',
  connection: redis,
  concurrency: 5,
  attempts: 3,
});

const worker = jobs.createWorker(async (job) => {
  await process(job.data);
});

await jobs.add('send-email', { to: 'a@b.com' });
```

---

## Configuration

### JobAtLeastOnceOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable job processing |
| `queueName` | `string` | `'application-jobs'` | BullMQ queue name |
| `prefix` | `string` | `'queue'` | Redis key prefix |
| `connection` | `Redis` | — | Shared ioredis client (required when enabled) |
| `concurrency` | `number` | `5` | Max concurrent jobs |
| `attempts` | `number` | `3` | Retry attempts |
| `backoff` | `JobAtLeastOnceBackoff` | `{ type: 'exponential', delay: 1000 }` | Backoff strategy |
| `removeOnComplete` | `number \| boolean` | `100` | Completed job retention |
| `removeOnFail` | `number \| boolean` | `1000` | Failed job retention |
| `ownsConnection` | `boolean` | `false` | Whether to close connection on close |
| `logger` | `Logger` | — | Optional logger |
| `dlq` | `DLQConfig` | — | Dead letter queue config |
| `defaultJobOptions` | `JobsOptions` | — | Per-job default overrides |

### JobAtLeastOnceBackoff

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'fixed' \| 'exponential'` | Backoff type |
| `delay` | `number` | Base delay in ms |

---

## Adding Jobs

```typescript
// Single job
const job = await redis.jobAtLeastOnce.add('send-email', {
  to: 'user@example.com',
  body: 'Hello',
}, { attempts: 3, delay: 5000 });

// Bulk jobs
const jobs = await redis.jobAtLeastOnce.addBulk([
  { name: 'send-email', data: { to: 'a@b.com' } },
  { name: 'send-email', data: { to: 'c@d.com' } },
]);
```

---

## Creating Workers

```typescript
const worker = redis.jobAtLeastOnce.createWorker(
  async (job) => {
    await sendEmail(job.data.to, job.data.body);
    return { sent: true };
  },
  {
    concurrency: 10,
    middleware: [
      (job, token, signal, next) => {
        console.log(`Processing ${job.id}`);
        return next();
      },
    ],
  },
);
```

Failed jobs are automatically moved to the DLQ if configured.

---

## Scheduled Jobs

```typescript
// Recurring job
await redis.jobAtLeastOnce.schedule(
  'daily-report',
  {},
  { pattern: '0 9 * * *' },
  { attempts: 3 },
);

// List schedules
const schedules = await redis.jobAtLeastOnce.getSchedules();

// Remove a schedule
await redis.jobAtLeastOnce.removeSchedule(schedulerId);
```

---

## Queue Lifecycle

```typescript
// Get queue counts
const counts = await redis.jobAtLeastOnce.getCounts();
// { waiting: 5, active: 2, completed: 100, failed: 3, ... }

// Pause queue
await redis.jobAtLeastOnce.pause();

// Resume queue
await redis.jobAtLeastOnce.resume();

// Check if paused
const paused = await redis.jobAtLeastOnce.isPaused();

// Drain queue (wait for all jobs)
await redis.jobAtLeastOnce.drain();
await redis.jobAtLeastOnce.drain(true); // include delayed

// Obliterate queue (destroy all jobs)
await redis.jobAtLeastOnce.obliterate();
await redis.jobAtLeastOnce.obliterate(true); // force

// Close queue and workers
await redis.jobAtLeastOnce.close();

// Status
const status = redis.jobAtLeastOnce.status();
// { enabled: true, queueName: 'app-jobs', isClosed: false }
```

---

## Dead Letter Queue

```typescript
const dlq = redis.jobAtLeastOnce.getDlq();
// { queue, entries, replay } | null

if (dlq) {
  const entries = await dlq.entries(0, 100);
  await dlq.replay('job-id-123');
}
```

DLQ config (`DLQConfig`):

| Field | Type | Description |
|-------|------|-------------|
| `queueName` | `string` | Base queue name (creates `${queueName}-dlq`) |
| `maxRetries` | `number` | Optional maximum retries before DLQ |
| `preservePayload` | `boolean` | Retain payload in DLQ (default false) |
| `sanitizeFields` | `string[]` | Sensitive fields to redact as `"[redacted]"` |

Failed jobs are moved to DLQ when retries are exhausted.

---

## JobAtLeastOnce Interface

```typescript
interface JobAtLeastOnce {
  readonly enabled: boolean;
  readonly queueName: string;

  add<TData = unknown>(name: string, data: TData, options?: JobsOptions): Promise<Job<TData>>;
  addBulk<TData = unknown>(jobs: Array<{ name: string; data: TData; options?: JobsOptions }>): Promise<Job<TData>[]>;
  schedule<TData = unknown>(
    name: string,
    data: TData,
    repeatOptions: { pattern: string; tz?: string; limit?: number; startDate?: Date | string; endDate?: Date | string },
    options?: JobsOptions,
  ): Promise<Job<TData> | undefined>;
  removeSchedule(schedulerId: string): Promise<boolean>;
  getSchedules(start?: number, end?: number, asc?: boolean): Promise<ScheduledJobInfo[]>;
  createWorker<TData = unknown, TResult = unknown>(
    processor: Processor<TData, TResult>,
    options?: {
      concurrency?: number;
      middleware?: Array<(job: Job<TData, TResult>, token: string | undefined, signal: AbortSignal | undefined, next: () => Promise<TResult>) => Promise<TResult>>;
    },
  ): Worker<TData, TResult>;
  getCounts(): Promise<Record<string, number>>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  isPaused(): Promise<boolean>;
  drain(delayed?: boolean): Promise<void>;
  obliterate(force?: boolean): Promise<void>;
  close(): Promise<void>;
  status(): JobAtLeastOnceStatus;
  getDlq(): {
    queue: Queue;
    entries: (start?: number, end?: number) => Promise<DLQEntry[]>;
    replay: (jobId: string) => Promise<Job | null>;
  } | null;
}
```

When disabled, all methods throw `"At-least-once job processing is disabled"`.

---

## Subpath Imports

```typescript
// Via client (recommended — shares connection)
import { createClient } from '@oneunit/redis';

// Standalone (exported from root package)
import { createJobAtLeastOnce } from '@oneunit/redis';
```

---

## API Reference

```typescript
import {
  createJobAtLeastOnce,
  DisabledJobAtLeastOnce,
  JobAtLeastOnceImpl,
} from '@oneunit/redis';

import type {
  JobAtLeastOnce,
  JobAtLeastOnceOptions,
  JobAtLeastOnceBackoff,
  JobAtLeastOnceStatus,
  ScheduledJobInfo,
} from '@oneunit/redis';
```

Re-exported from BullMQ: `Queue`, `Worker`, `Job`, `Processor`.

---

## Operational Notes

| Concern | Behavior |
|---------|----------|
| Shared connection | Uses the same ioredis client as the main Redis client |
| Zero overhead when disabled | Disabled facade throws on all operations, no BullMQ loaded |
| Retries | Exponential backoff by default, configurable attempts |
| DLQ | Failed jobs moved to dead-letter queue after exhaustion |
| Graceful shutdown | `close()` stops workers, closes queue/events, optionally quits connection |
| Concurrency | `concurrency` limits parallel job execution |
| Prefix isolation | Per-queue `prefix` prevents key collisions |
