# Scheduled Session Revocation

Delayed session revocation via BullMQ delayed jobs. Schedule a session to be revoked at a future time using a shared Redis connection.

## Table of Contents

1. [Quick Start](#quick-start)
2. [createScheduledSessionRevocation](#createscheduledsessionrevocation)
3. [Configuration](#configuration)
4. [Scheduling Revocation](#scheduling-revocation)
5. [Lifecycle](#lifecycle)
6. [Subpath Imports](#subpath-imports)
7. [API Reference](#api-reference)
8. [Operational Notes](#operational-notes)

---

## Quick Start

```typescript
import { createClient } from '@oneunit/redis';
import { createRedisSessionStore, createScheduledSessionRevocation } from '@oneunit/redis/features';

const redis = createClient({ url: process.env.REDIS_URL });
const sessionStore = createRedisSessionStore(redis);

const scheduler = createScheduledSessionRevocation({
  connection: redis,
  sessionStore,
  queueName: 'session-revocation',
  prefix: 'queue',
  concurrency: 1,
});

// Schedule a session to be revoked in 30 minutes
await scheduler.schedule('session-123', Date.now() + 30 * 60 * 1000);

// Or with a Date
await scheduler.schedule('session-123', new Date(Date.now() + 30 * 60 * 1000));

// Close when done
await scheduler.close();
```

---

## createScheduledSessionRevocation

### Signature

```typescript
createScheduledSessionRevocation(config: ScheduledSessionRevocationConfig): ScheduledSessionRevocation;
```

### ScheduledSessionRevocationConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `connection` | `Redis` | — | Shared ioredis client (required) |
| `redis` | `Redis` | `connection` | Redis client for session store |
| `sessionStore` | `SessionStore` | auto-created | Session store for revocation |
| `queueName` | `string` | `'scheduled-session-revocation'` | BullMQ queue name |
| `prefix` | `string` | `'queue'` | Redis key prefix |
| `concurrency` | `number` | `1` | Worker concurrency |
| `logger` | `Logger` | — | Optional logger |
| `storeOptions` | `{ keyPrefix?, revokedSessionTtlSeconds? }` | — | Session store options |

---

## Scheduling Revocation

```typescript
const jobId = await scheduler.schedule(sessionId, runAt);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | `string` | Session ID to revoke |
| `runAt` | `number \| Date` | Timestamp or Date when revocation should occur |

The job is enqueued with a BullMQ `delay` equal to `runAt - now`. If `runAt` is in the past, the job runs immediately.

The worker processes the job by calling `sessionStore.revokeSession(sessionId)`.

---

## Lifecycle

```typescript
// Access the underlying BullMQ queue (lazy-initialized)
const queue = scheduler.queue;

// Access the underlying BullMQ worker (lazy-initialized)
const worker = scheduler.worker;

// Graceful shutdown
await scheduler.close();
```

The queue and worker are lazily initialized on first access (either via `schedule()` or direct property access).

---

## Subpath Imports

```typescript
import { createScheduledSessionRevocation } from '@oneunit/redis/features';
// or from '@oneunit/redis/auth'
```

---

## API Reference

```typescript
import {
  createScheduledSessionRevocation,
  type ScheduledSessionRevocationConfig,
  type ScheduledSessionRevocation,
} from '@oneunit/redis/features';
```

### ScheduledSessionRevocation interface

| Member | Type | Description |
|--------|------|-------------|
| `queue` | `Queue` | Underlying BullMQ queue (lazy) |
| `worker` | `Worker` | Underlying BullMQ worker (lazy) |
| `schedule(sessionId, runAt)` | `(string, number \| Date) => Promise<string \| undefined>` | Schedule revocation, returns job ID |
| `close()` | `() => Promise<void>` | Close queue and worker |

---

## Operational Notes

| Concern | Behavior |
|---------|----------|
| Lazy init | Queue/worker created on first use |
| Shared connection | Uses the same ioredis client as the main client |
| BullMQ delayed jobs | Revocation scheduled via BullMQ `delay` option |
| Concurrency | Default 1 worker — serializes revocations |
| Session store | Auto-created if not provided; uses `createRedisSessionStore` |
| Errors | Throws if `sessionId` is empty or `runAt` is invalid |
| Closed state | `schedule()` and `queue`/`worker` getters throw after `close()`; `close()` itself is idempotent |
