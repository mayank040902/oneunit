<p align="center">
  <strong>@oneunit/redis</strong>
  <br/>
  Redis client and BullMQ job queues for Node.js
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oneunit/redis"><img src="https://img.shields.io/npm/v/@oneunit/redis?color=0969da&label=npm" alt="npm version"></a>
  <a href="https://github.com/mayank040902/oneunit/blob/master/packages/redis/LICENSE"><img src="https://img.shields.io/npm/l/@oneunit/redis?color=22863a" alt="license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-417e38" alt="node version">
  <img src="https://img.shields.io/badge/types-included-3178c6" alt="types included">
</p>

<p align="center">
  Shared connections · Safe Redis URL handling · Credential redaction · Bounded health checks<br/>
  Idempotent graceful shutdown · Production BullMQ defaults · Safe pipeline batching · Universal logger support
</p>

---

Production-ready Redis client wrapper and BullMQ job queue integration for Node.js. Works standalone or with any logger that implements `error`, `warn`, `info`, and `debug`.

> **Monorepo** — [github.com/mayank040902/oneunit](https://github.com/mayank040902/oneunit)

## Table of Contents

- [Highlights](#highlights)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Subpath Imports](#subpath-imports)
- [Core API Reference](#core-api-reference)
  - [Client API (`@oneunit/redis/client` or `@oneunit/redis`)](#client-api-oneunitredisclient-or-oneunitredis)
    - [`createClient`](#createclientoptions-logger)
    - [`health`](#healthclient-options)
    - [`shutdown`](#shutdownclient-logger)
    - [`attachEvents`](#attacheventsclient-logger)
    - [`redactError`](#redacterrorerror)
  - [Queue API (`@oneunit/redis/queue` or `@oneunit/redis`)](#queue-api-oneunitredisqueue-or-oneunitredis)
    - [`createQueue`](#createqueueconfig)
    - [`createWorker`](#createworkerconfig)
    - [`attachQueueEvents`](#attachqueueeventsconfig)
    - [BullMQ Re-exports](#bullmq-re-exports)
  - [Logger API (`@oneunit/redis`)](#logger-api-oneunitredis)
    - [Adapters and Helpers](#adapters-and-helpers)
    - [Automatic Pino Detection](#automatic-pino-detection)
  - [Pipeline API (`@oneunit/redis/pipeline` or `@oneunit/redis`)](#pipeline-api-oneunitredispipeline-or-oneunitredis)
    - [`runPipeline`](#runpipelineclient-steps-options)
    - [`pipelineValues`](#pipelinevaluesresults)
    - [Errors](#errors)
- [Common Patterns](#common-patterns)
  - [1. Read-Through Caching with TTL](#1-read-through-caching-with-ttl)
  - [2. Session Store with Sliding Expiration](#2-session-store-with-sliding-expiration)
  - [3. Pub/Sub Messaging](#3-pubsub-messaging)
  - [4. Background Job Processing with Retries & Cleanup](#4-background-job-processing-with-retries--cleanup)
  - [5. Proper Teardown Order](#5-proper-teardown-order)
- [Runnable Examples](#runnable-examples)
- [Environment Variables](#environment-variables)
- [Development & Verification](#development--verification)
- [Architecture & Contributing](#architecture--contributing)
- [License](#license)

---

## Highlights

- **Shared Connection Architecture** — Default `maxRetriesPerRequest: null` allows a single `ioredis` client to be shared cleanly between standard Redis operations and BullMQ `Queue` / `Worker` instances.
- **Safe Redis URL Handling** — Passes URL positionally to `ioredis` or falls back to `process.env.REDIS_URL`. Prevents the silent fallback to `localhost:6379` caused by passing `{ url }` in an options object.
- **Credential Redaction** — `redactError` automatically strips sensitive plaintext passwords from `AUTH` and `HELLO` command failures across client events, `QueueEvents`, and `shutdown`.
- **Bounded Health Checks** — `health(client, { timeout: 1000 })` returns latency and status, preventing health probes from hanging indefinitely on disconnected sockets.
- **Robust Graceful Shutdown** — `shutdown(client)` issues an idempotent `QUIT` bounded by a 5-second deadline, falls back to forced `disconnect()` if unresponsive, and prevents crashes from duplicate `SIGINT` / `SIGTERM` signals.
- **Production BullMQ Presets** — `createQueue` defaults to exponential backoff (1s initial delay), 3 retry attempts, and automatic retention pruning (100 completed, 1,000 failed jobs).
- **Safe Pipeline Batching** — `runPipeline` sends many commands in one round trip and reports per-command failures explicitly, because a failed command inside a raw `client.pipeline()` resolves the batch and is otherwise invisible. Each step must queue exactly one command, enforced at runtime; errors are redacted and the batch is bounded by a timeout.
- **Prefix Inheritance** — `attachQueueEvents` automatically inherits the queue's custom prefix, preventing lost event subscriptions.
- **Universal Logger Adapter** — Duck-typed logger support for Console, Pino, Winston, etc. Automatically normalizes missing log levels and inverts argument ordering for Pino (`(bindings, message)` vs `(message, extra)`).
- **Subpath Exports** — Modular imports via `@oneunit/redis`, `@oneunit/redis/client`, `@oneunit/redis/queue`, `@oneunit/redis/pipeline`, and `@oneunit/redis/features`.
- **Strict TypeScript Types** — Fully typed ESM package targeting Node.js 20+ with re-exported BullMQ and ioredis types.

---

## Installation

```bash
npm install @oneunit/redis
```

Requires **Node.js 20+**. Ships as pure ESM.

> [!NOTE]
> `ioredis` and `bullmq` are direct dependencies. You do not need to install them separately.

---

## Quick Start

```typescript
import {
  createClient,
  createQueue,
  createWorker,
  attachQueueEvents,
  health,
  shutdown,
} from "@oneunit/redis";

// 1. Initialize Redis client (reads REDIS_URL from env by default)
const redis = createClient({ url: process.env.REDIS_URL });

// 2. Perform regular Redis operations
await redis.set(
  "user:session:123",
  JSON.stringify({ id: 123, role: "admin" }),
  "EX",
  3600,
);
const session = await redis.get("user:session:123");

// 3. Create a BullMQ Queue using the shared Redis client
const emailQueue = createQueue({
  name: "email",
  connection: redis,
});

// 4. Attach event listeners for job observability
const queueEvents = attachQueueEvents({ queue: emailQueue });

// 5. Create a Worker to process background jobs
const worker = createWorker({
  name: "email",
  connection: redis,
  concurrency: 5,
  processor: async (job) => {
    console.log(`Processing email job ${job.id}:`, job.data);
    await job.updateProgress(100);
    return { delivered: true };
  },
});

// 6. Enqueue a job (inherits 3 attempts + exponential backoff)
await emailQueue.add("welcome", {
  to: "developer@example.com",
  template: "welcome",
});

// 7. Check connectivity
const status = await health(redis);
console.log(`Redis status: ${status.status} (${status.latency.value}ms)`);

// 8. Graceful teardown
async function closeApp() {
  await queueEvents.close();
  await worker.close();
  await emailQueue.close();
  await shutdown(redis);
}

process.on("SIGTERM", closeApp);
process.on("SIGINT", closeApp);
```

---

## Subpath Imports

Import only what you need to optimize module loading and boundaries:

```typescript
// Everything (client, queue, worker, logger)
import { createClient, createQueue, createWorker } from "@oneunit/redis";

// Redis client only (zero BullMQ imports)
import {
  createClient,
  health,
  shutdown,
  attachEvents,
} from "@oneunit/redis/client";

// Queues & workers only
import {
  createQueue,
  createWorker,
  attachQueueEvents,
} from "@oneunit/redis/queue";

// Command batching only
import { runPipeline, pipelineValues } from "@oneunit/redis/pipeline";
```

---

## Core API Reference

### Client API (`@oneunit/redis/client` or `@oneunit/redis`)

#### `createClient(options?, logger?)`

Creates and returns a standard `ioredis` `Redis` instance configured with safe defaults and event logging.

```typescript
function createClient(
  options?: RedisClientOptions | string,
  logger?: Logger,
): Redis;
```

You can pass either a connection URL string or an options object:

```typescript
// From environment variable REDIS_URL
const client1 = createClient();

// From explicit URL string
const client2 = createClient("redis://127.0.0.1:6379");

// From options object
const client3 = createClient({
  url: "redis://127.0.0.1:6379",
  tls: { rejectUnauthorized: false },
});
```

**Default Settings:**

| Option                 | Default                 | Rationale                                                                                                                                                           |
| :--------------------- | :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `url`                  | `process.env.REDIS_URL` | ioredis constructor only parses URL from positional arguments; passing `{ url }` in options is silently ignored. `createClient` ensures URL is passed positionally. |
| `lazyConnect`          | `true`                  | Opens no socket on instantiation. First command initiates connection, keeping module imports free of network side effects.                                          |
| `maxRetriesPerRequest` | `null`                  | Required by BullMQ. BullMQ throws if this is not `null`. Defaulting to `null` allows the client to be shared with queues and workers.                               |

#### `health(client, options?)`

Performs an active `PING` bounded by a strict timeout to assess connectivity and measure round-trip latency.

```typescript
interface HealthOptions {
  timeout?: number; // Milliseconds to wait before reporting down (default: 1000)
}

interface HealthResult {
  status: "up" | "down";
  latency: {
    value: number;
    unit: "ms";
  };
  error?: string;
}

async function health(
  client: Redis,
  options?: HealthOptions,
): Promise<HealthResult>;
```

```typescript
const result = await health(redis, { timeout: 1500 });
if (result.status === "down") {
  console.error("Redis unreachable:", result.error);
}
```

> [!TIP]
> Why the timeout matters: When disconnected, `ioredis` queues commands indefinitely in its offline queue while reconnecting. Without a bounded timeout, an unbounded `PING` would hang forever instead of returning `"down"`.

#### `shutdown(client, logger?)`

Gracefully terminates a Redis connection with timeout protection and idempotency.

```typescript
async function shutdown(
  client: Redis | null | undefined,
  logger?: Logger,
): Promise<void>;
```

- Sends `QUIT` command to allow pending commands to finish.
- If the server does not acknowledge `QUIT` within **5,000ms**, forces the socket closed via `client.disconnect()`.
- Safe to call multiple times or bind across both `SIGINT` and `SIGTERM` without throwing `Connection is closed` errors.
- Automatically redacts credentials if a shutdown error is logged.

#### `attachEvents(client, logger?)`

Attaches listeners to the five core `ioredis` connection lifecycle events (`connect`, `ready`, `reconnecting`, `error`, `close`).

```typescript
function attachEvents(client: Redis, logger?: Logger): void;
```

- `createClient` calls this automatically.
- Guarded by an internal symbol (`Symbol.for("oneunit.redis.eventsAttached")`) so duplicate calls will not attach duplicate listeners or trigger `MaxListenersExceededWarning`.
- The `error` event listener is always registered, preventing unhandled `error` events from crashing the process even if no logger is provided.

#### `redactError(error)`

Sanitizes `ioredis` errors that include command payloads, replacing sensitive credentials with `"[redacted]"`.

```typescript
function redactError(error: unknown): unknown;
```

```typescript
try {
  await client.auth("default", "secret_pass");
} catch (err) {
  // Command arguments with plaintext password are safe to log
  logger.error("Authentication failed", redactError(err));
}
```

#### At-Least-Once Job Processing (`jobAtLeastOnce`)

`createClient` can optionally initialize an at-least-once job processing feature built on BullMQ. When enabled, the returned client exposes a `jobAtLeastOnce` property with a simplified API for enqueueing jobs and creating workers.

```typescript
interface JobAtLeastOnceOptions {
  enabled?: boolean; // Default: false
  queueName?: string; // Default: "application-jobs"
  prefix?: string; // Default: "queue"
  concurrency?: number; // Default: 5
  attempts?: number; // Default: 3
  backoff?: { type: "fixed" | "exponential"; delay: number }; // Default: exponential, 1000ms
  removeOnComplete?: number | boolean; // Default: 100
  removeOnFail?: number | boolean; // Default: 1000
  ownsConnection?: boolean; // Default: false
  logger?: Logger;
}

interface JobAtLeastOnce {
  readonly enabled: boolean;
  readonly queueName: string;
  add<TData>(name: string, data: TData, options?: JobsOptions): Promise<Job<TData>>;
  createWorker<TData, TResult>(processor: Processor<TData, TResult>, options?: { concurrency?: number }): Worker<TData, TResult>;
  getCounts(): Promise<Record<string, number>>;
  close(): Promise<void>;
  status(): { enabled: boolean; queueName: string; isClosed: boolean };
}
```

**Usage:**

```typescript
import { createClient, shutdown } from "@oneunit/redis";

const redis = createClient({
  url: process.env.REDIS_URL,
  jobAtLeastOnce: {
    enabled: true,
    queueName: "application-jobs",
    concurrency: 10,
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
  },
});

// Create a worker to process jobs
const worker = redis.jobAtLeastOnce.createWorker(async (job) => {
  console.log(`Processing ${job.name}`, job.data);
  await doWork(job.data);
  return { success: true };
});

// Enqueue jobs
await redis.jobAtLeastOnce.add("send-email", { to: "user@example.com", subject: "Hello" });
await redis.jobAtLeastOnce.add("generate-report", { reportId: "monthly-2026" });

// Graceful shutdown
await redis.jobAtLeastOnce.close();
await shutdown(redis);
```

**Key behaviors:**

- **At-least-once semantics** — Jobs are retried up to `attempts` times with the configured backoff. A job may execute more than once if the handler succeeds but completion persistence fails. Handlers should be idempotent or use application-level deduplication.
- **Stalled job recovery** — BullMQ's built-in stalled job detection automatically recovers jobs from workers that crash or lose connectivity.
- **Disabled by default** — When `enabled: false` (or omitted), `jobAtLeastOnce` is a no-op implementation that throws on API calls without allocating any queues, workers, or background resources.
- **Shared connection** — Uses the same Redis client as the rest of the application. The feature does not own the connection by default; set `ownsConnection: true` if the feature should close the client on shutdown.
- **QueueEvents included** — A managed `QueueEvents` listener is created automatically for lifecycle logging (completed, failed, progress, error with credential redaction).

**Configuration options:**

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `false` | Enable the feature. When `false`, API calls throw and no resources are allocated. |
| `queueName` | `"application-jobs"` | BullMQ queue name. |
| `prefix` | `"queue"` | BullMQ key prefix. Must match across queue, worker, and events. |
| `concurrency` | `5` | Worker concurrency (jobs processed in parallel). |
| `attempts` | `3` | Maximum job attempts including the first try. |
| `backoff` | `{ type: "exponential", delay: 1000 }` | Retry backoff strategy. |
| `removeOnComplete` | `100` | Number of completed jobs to retain in Redis. |
| `removeOnFail` | `1000` | Number of failed jobs to retain in Redis. |
| `ownsConnection` | `false` | If `true`, `close()` will `quit()` the Redis client. |

---

### Queue API (`@oneunit/redis/queue` or `@oneunit/redis`)

#### `createQueue(config)`

Creates and returns a BullMQ `Queue` pre-configured with production-ready retry and retention defaults.

```typescript
interface QueueConfig {
  name: string;
  connection: Redis;
  prefix?: string; // Default: "queue"
  defaultJobOptions?: JobsOptions; // Overrides merged key-by-key
  settings?: QueueOptions["settings"];
}

function createQueue(config: QueueConfig): Queue;
```

**Default Job Options:**

| Setting            | Value                                  | Behavior                                                              |
| :----------------- | :------------------------------------- | :-------------------------------------------------------------------- |
| `attempts`         | `3`                                    | Retries failed jobs up to 3 times before moving them to failed state. |
| `backoff`          | `{ type: "exponential", delay: 1000 }` | Exponential delay (1s, 2s, 4s...) between retries.                    |
| `removeOnComplete` | `100`                                  | Keeps the last 100 completed jobs in Redis for inspection.            |
| `removeOnFail`     | `1000`                                 | Keeps the last 1,000 failed jobs for debugging.                       |

> [!NOTE]
> Options are merged key-by-key. Passing `{ attempts: 5 }` keeps the default exponential backoff and retention settings intact. Explicit `null` values (such as `removeOnComplete: null`) pass through to indicate "keep forever".

#### `createWorker(config)`

Creates and returns a BullMQ `Worker` instance to process jobs from a queue.

```typescript
interface WorkerConfig<T = unknown> {
  name: string;
  processor: Processor<T>;
  connection: Redis;
  prefix?: string; // Default: "queue"
  concurrency?: number; // Default: 1 (BullMQ default)
  limiter?: WorkerOptions["limiter"];
  settings?: WorkerOptions["settings"];
}

function createWorker<T = unknown>(config: WorkerConfig<T>): Worker<T>;
```

```typescript
interface EmailPayload {
  to: string;
  body: string;
}

const worker = createWorker<EmailPayload>({
  name: "email",
  connection: redis,
  concurrency: 10,
  processor: async (job) => {
    await sendMail(job.data.to, job.data.body);
  },
});
```

#### `attachQueueEvents(config)`

Attaches a managed BullMQ `QueueEvents` listener to report job lifecycle transitions to a logger.

```typescript
interface QueueEventsConfig {
  queue: Queue;
  logger?: Logger;
  prefix?: string; // Inherits queue prefix if omitted
  connection?: QueueEventsOptions["connection"]; // Defaults to queue connection
}

function attachQueueEvents(config: QueueEventsConfig): QueueEvents;
```

- **Prefix Inheritance** — Automatically reads the prefix from `queue.opts.prefix`. Prevents issues where custom prefixes caused events to be silently dropped.
- **Lifecycle Logging** — Automatically logs `completed`, `failed` (with reason), `progress`, and `error` (with credential redaction).
- **Resilient Teardown** — Wraps BullMQ's `QueueEvents.close()` so it cannot throw when the background connection already failed during initialization, and so the duplicated connection is released. That duplicate is one the caller has no reference to, so a failure there would otherwise leave the process unable to exit. Errors unrelated to the connection being gone are still rethrown.

#### BullMQ Re-exports

For convenience and typing consistency, common BullMQ classes and types are re-exported:

- **Classes**: `Queue`, `Worker`, `QueueEvents`
- **Types**: `QueueOptions`, `JobsOptions`, `WorkerOptions`, `Job`, `Processor`, `QueueEventsOptions`

---

### Logger API (`@oneunit/redis`)

`@oneunit/redis` does not require any specific logging library. It accepts any object that implements the `Logger` interface:

```typescript
interface Logger {
  error(message: unknown, extra?: unknown): void;
  warn(message: unknown, extra?: unknown): void;
  info(message: unknown, extra?: unknown): void;
  debug(message: unknown, extra?: unknown): void;
  child?(bindings?: Record<string, unknown>): Logger;
}
```

#### Adapters and Helpers

- `consoleLogger` — Built-in logger that routes to `console.error`, `console.warn`, `console.info`, and `console.debug`.
- `silentLogger` — Built-in no-op logger that suppresses all log output.
- `createLogger(input?)` — Completes a partial logger by routing missing levels to `info` or no-op, preventing `logger.info is not a function` runtime crashes.
- `normalizeLogger(logger?)` — Normalizes a caller-supplied logger via `createLogger` when provided, or returns `undefined` when absent so unconfigured loggers stay silent.
- `isLogger(value)` — Type guard that verifies if an unknown object implements logger functions.

#### Automatic Pino Detection

Pino signatures use `(bindings, message)`, whereas standard loggers use `(message, extra)`.

`@oneunit/redis` detects Pino instances by checking for `bindings()` and `levels` properties, and automatically swaps argument positions so that metadata is merged into the structured JSON record rather than becoming the message string.

```typescript
import pino from "pino";
import { createClient } from "@oneunit/redis";

const logger = pino();
const client = createClient({}, logger); // Pino format handled automatically
```

### Job Processing (`@oneunit/redis`)

Optional at-least-once job processing reuses BullMQ and remains inactive unless explicitly
enabled.

```typescript
const redis = createClient({
  url: process.env.REDIS_URL,
  jobAtLeastOnce: {
    enabled: true,
    queueName: "application-jobs",
    concurrency: 10,
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
  },
});

await redis.jobAtLeastOnce.add("send-email", { userId: "user-123" });

const worker = redis.jobAtLeastOnce.createWorker(async (job) => {
  // Handler must be idempotent: at-least-once delivery may repeat work.
  return "processed";
});

await redis.jobAtLeastOnce.close();
```

Disabling it creates no queue, worker, timer, or background processing resources.

### Resilient Client (`@oneunit/redis`)

Configure resilience once at startup; application code uses ordinary Redis commands. When the
client or factory is configured with `resilience`, `fallback`, or `recovery` options,
`createClient` returns a resilient client automatically. `createResilientRedis` is also available
for wrapping an existing client.

```typescript
const redis = createClient({
  url: process.env.REDIS_URL,
  resilience: {
    fallback: { enabled: true, strategy: "memory" },
    recovery: { enabled: true },
  },
});

await redis.set("user:123", value);
const value = await redis.get("user:123");
await redis.shutdown(); // does not close caller-owned clients created separately
```

Limits and overflow behavior:

- `maxBufferSize` / `maxPayloadBytes`: maximum estimated bytes retained by fallback state and journal
- `maxPendingOperations` / `maxOperations`: maximum queued operations
- `maxPendingAge`: maximum age of an unrecovered operation, in milliseconds
- `onLimitExceeded`: only `"reject"` is supported; unsupported policies fail explicitly

When a limit is reached, new fallback writes are rejected, previously accepted operations remain
recoverable, and capacity becomes available again after recovery. During an outage the local store holds
only data needed for supported commands, and sensitive values that the application writes to Redis may
therefore exist in process memory. Treat the host and process accordingly.

### Pipeline API (`@oneunit/redis/pipeline` or `@oneunit/redis`)

#### `runPipeline(client, steps, options?)`

Runs a batch of commands in a single round trip. Use it when you already have
several independent commands in hand; a pipeline cannot help when each command
depends on the previous one's result.

```typescript
const result = await runPipeline(client, [
  { label: "set:a", run: (p) => void p.set("a", "1") },
  { label: "set:b", run: (p) => void p.set("b", "2") },
  { label: "get:a", run: (p) => void p.get("a") },
]);

result.failed; // how many commands failed
result.durationMs; // wall-clock duration of EXEC
pipelineValues(result.results); // ["OK", "OK", "1"] — throws if any failed
```

**Each step must queue exactly one command.** Results are matched to steps by
position, so a step that queues two commands would shift every later value onto
the wrong label, and an `async` step queues nothing before `EXEC` is sent and
loses its command silently. Neither is a compile error, so `runPipeline` checks
ioredis's own queue length around every step and raises `PipelineStepError`
naming the offending label:

```typescript
// Throws: Redis pipeline step "seed" queued 2 commands, expected exactly 1
await runPipeline(client, [
  {
    label: "seed",
    run: (p) => {
      p.set("a", "1");
      p.set("b", "2");
    },
  },
]);

// Also throws — and the commands after it are never sent
await runPipeline(client, [
  {
    label: "get",
    run: async (p) => {
      await something();
      void p.get("a");
    },
  },
]);
```

Write two steps instead of one step with two commands, and do not make a step
`async` — awaiting inside `run` queues the command too late.

| Option         | Default | Purpose                                                                                                         |
| :------------- | :------ | :-------------------------------------------------------------------------------------------------------------- |
| `timeout`      | `5000`  | Milliseconds to wait for `EXEC` before raising `PipelineTimeoutError`. Invalid values fall back to the default. |
| `logger`       | none    | Logger for batch-level warnings and the debug summary.                                                          |
| `throwOnError` | `false` | Raise `PipelineCommandError` if any command failed.                                                             |

#### Why this wraps `client.pipeline()`

A failed command does **not** fail a pipeline. ioredis resolves `EXEC` and
reports the failure per command:

```typescript
const raw = await client.pipeline().incr("a-string-key").exec();
// [[Error: ERR value is not an integer, null]] — resolved, not rejected
```

Reading only the values (`raw.map(([, value]) => value)`) yields `null` and the
batch looks successful while a write was dropped. Here every result carries an
explicit `error`, labelled with the step that produced it.

Two further gaps are closed: `EXEC` is bounded by `timeout`, since ioredis parks
queued commands while reconnecting and would otherwise never settle; and command
errors are passed through `redactError` before reaching a logger or an exception,
because ioredis attaches the failing command's arguments and those are the
password for `AUTH`. That redaction covers a rejected `EXEC` as well as the
resolved per-command results.

#### `pipelineValues(results)`

Returns the successful values in order, throwing `PipelineCommandError` if any
command failed. Use `result.results` directly when a partial batch is expected
and worth handling.

#### Errors

- `PipelineTimeoutError` — the batch did not complete within `timeout`. Carries `steps`, the number of commands queued.
- `PipelineCommandError` — a command failed and `throwOnError` was set, or `pipelineValues` was called on a failed batch. Carries `results`. The `message` lists step labels only, never command arguments.
- `PipelineStepError` — a step did not queue exactly one command, so results would be paired with the wrong labels. Carries `label` and `queued`. Raised before `EXEC` is sent, so the batch is never executed.

---

## Common Patterns

### 1. Read-Through Caching with TTL

```typescript
import { createClient } from "@oneunit/redis";

const redis = createClient();

async function getCachedUser(userId: string) {
  const cacheKey = `user:${userId}`;

  // 1. Try reading from Redis cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // 2. Fall back to primary database
  const user = await db.users.findById(userId);

  // 3. Cache with 1-hour expiration (3600 seconds)
  if (user) {
    await redis.set(cacheKey, JSON.stringify(user), "EX", 3600);
  }

  return user;
}

// Invalidation helper
async function invalidateUser(userId: string) {
  await redis.del(`user:${userId}`);
}
```

### 2. Session Store with Sliding Expiration

```typescript
import { createClient } from "@oneunit/redis";

const redis = createClient();
const SESSION_TTL = 1800; // 30 minutes

async function touchSession(sessionId: string) {
  // Reset the expiration timer without altering the session data
  const updated = await redis.expire(`session:${sessionId}`, SESSION_TTL);
  return updated === 1;
}

async function updateSession(sessionId: string, data: Record<string, unknown>) {
  await redis.set(
    `session:${sessionId}`,
    JSON.stringify(data),
    "EX",
    SESSION_TTL,
  );
}
```

### 3. Pub/Sub Messaging

> [!IMPORTANT]
> Redis connections in subscriber mode cannot issue standard commands. Use dedicated clients for publisher and subscriber.

```typescript
import { createClient } from "@oneunit/redis";

const publisher = createClient();
const subscriber = createClient();

// Listen on notifications channel
await subscriber.subscribe("notifications");

subscriber.on("message", (channel, message) => {
  console.log(`Received message on ${channel}:`, JSON.parse(message));
});

// Publish from the publisher client
await publisher.publish(
  "notifications",
  JSON.stringify({ type: "ALERT", text: "System update available" }),
);
```

### 4. Background Job Processing with Retries & Cleanup

```typescript
import {
  createClient,
  createQueue,
  createWorker,
  shutdown,
} from "@oneunit/redis";

const redis = createClient();

const reportQueue = createQueue({
  name: "reports",
  connection: redis,
  defaultJobOptions: {
    attempts: 5, // Override to 5 retries
    backoff: { type: "exponential", delay: 2000 },
  },
});

const reportWorker = createWorker({
  name: "reports",
  connection: redis,
  concurrency: 2,
  processor: async (job) => {
    console.log(
      `Generating report ${job.data.reportId} (attempt ${job.attemptsMade + 1})`,
    );

    // Simulate generation
    await generatePdfReport(job.data);

    return {
      fileUrl: `https://storage.example.com/reports/${job.data.reportId}.pdf`,
    };
  },
});

await reportQueue.add("monthly-summary", {
  reportId: "rep-2026-10",
  month: 10,
});
```

### 5. Proper Teardown Order

To prevent dropped jobs or connection errors during deployment and shutdown, tear down components in reverse order of creation:

```typescript
async function gracefulTeardown() {
  console.log("Shutting down workers and queues...");

  // 1. Close event listeners first
  if (queueEvents) await queueEvents.close();

  // 2. Stop workers to let active jobs finish
  if (worker) await worker.close();

  // 3. Close queues
  if (queue) await queue.close();

  // 4. Finally, disconnect the Redis client
  await shutdown(redis);

  console.log("Redis teardown complete.");
}
```

---

## Runnable Examples

The [`examples/`](./examples) directory contains working, standalone scripts demonstrating real-world patterns.

To run them, ensure a Redis instance is listening on `localhost:6379` (or specify `REDIS_URL`):

```bash
npm run example:efficient     # End-to-end: cache, pipeline, queue, worker, at-least-once jobs
```

---

## Environment Variables

| Variable             | Default                  | Description                                                                     |
| :------------------- | :----------------------- | :------------------------------------------------------------------------------ |
| `REDIS_URL`          | `redis://localhost:6379` | Default connection URL used when `url` option is not passed to `createClient`.  |
| `REDIS_SILENT`       | _unset_                  | Set to `true` to silence connection-event logging when running example scripts. |
| `EXAMPLE_TIMEOUT_MS` | `5000`                   | Subscription wait bound used in pub/sub example.                                |

---

## Auth Storage Adapter

This package also exports optional Redis-backed stores for `@oneunit/auth`:

```ts
import Redis from "ioredis";
import { createAuth } from "@oneunit/auth";
import { createRedisStores } from "@oneunit/redis/features";

const redis = new Redis(process.env.REDIS_URL);
const stores = createRedisStores(redis);

const auth = createAuth({
  secret: process.env.AUTH_SECRET!,
  refreshStore: stores.refreshStore,
  sessionStore: stores.sessionStore,
  // oauth: { stateStore: stores.stateStore }
});
```

The auth subpath is opt-in and requires `@oneunit/auth` as a peer dependency. The core package remains Redis-free.

## Development & Verification

```bash
# Build TypeScript to dist/
npm run build

# Typecheck without emitting files
npm run typecheck

# Run test suite
npm test

# Run ESLint
npm run lint

# Comprehensive verification (build, typecheck, lint, test, pack check)
npm run verify
```

Two things about `npm test` that are easy to trip over:

- **Build first.** The suite imports `../dist/index.js`, not `src`, and `dist/`
  is gitignored — so on a fresh checkout the tests cannot even load until
  `npm run build` has run. `npm run verify` orders this correctly; the
  individual scripts do not.
- **A Redis on `localhost:6379` gives real coverage.** The queue, worker,
  pipeline, and performance tests need a live server and return early without
  one, so the suite is green either way — but with no server those tests are
  no-ops. CI starts a `redis` service container for exactly this reason. An
  unguarded `await client.ping()` does not merely fail without a server, it
  never settles, because `maxRetriesPerRequest` defaults to `null`; see
  [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Optional feature helpers (`@oneunit/redis/features`)

The feature subtree ships dependency-free helpers and opt-in profiles on top of the base Redis/BullMQ wrappers. It is exposed via `@oneunit/redis/features` and does not change the default safe behavior of the base client.

### Session scheduling

```typescript
import { createClient, createRedisSessionStore, createScheduledSessionRevocation } from "@oneunit/redis/features";

const redis = createClient({ url: process.env.REDIS_URL });
const sessionStore = createRedisSessionStore(redis, { keyPrefix: "app:" });
const scheduler = createScheduledSessionRevocation({
  connection: redis,
  sessionStore,
  queueName: "session-revocation",
});

await scheduler.schedule("session-id", Date.now() + 60_000);
```

### Error-handling profile

```typescript
import { createClient, classifyError, isRetryable } from "@oneunit/redis";

const redis = createClient({
  url: process.env.REDIS_URL,
  errorHandling: {
    enabled: true,
    onError(error, classification) {
      console.log(classification.kind, classification.retryable, error);
    },
  },
});

console.log(classifyError(new Error("ECONNRESET")), isRetryable(new Error("ECONNRESET")));
```

### Retry, CAS, TTL, keys, serialization, capabilities

```typescript
import {
  buildKey,
  serialize,
  deserialize,
  jitterTtl,
  setIfAbsent,
  compareAndSwap,
  detectCapabilities,
  retryOperation,
} from "@oneunit/redis/features";

const key = buildKey("user", 42, "session");
const raw = serialize({ id: 1 });
const value = deserialize(raw);
const ttl = jitterTtl(300, 0.1);

await setIfAbsent(redisLikeClient, "idempotency-key", "created", { ttlSeconds: 60 });
await compareAndSwap(redisLikeClient, "counter", "0", "1");
const capabilities = await detectCapabilities(redisLikeClient);
const result = await retryOperation(async () => "ok", { attempts: 3, baseDelayMs: 25, jitter: false });
```

Optional helpers remain thin wrappers. They do not add a cache, repository, lock, rate limiter, or framework runtime. All redacted error behavior stays mandatory even when an advanced profile is enabled.

## Architecture & Contributing

- For deep-dives into design decisions, timeout guarantees, and BullMQ interoperability, read [ARCHITECTURE.md](./ARCHITECTURE.md).
- To contribute or run the regression test suites, see [CONTRIBUTING.md](./CONTRIBUTING.md).
- To see recent changes and bug fixes, see [CHANGELOG.md](./CHANGELOG.md).

---

## License

[MIT](./LICENSE) &copy; 2026 mayank
