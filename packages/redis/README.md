<p align="center">
  <strong>@oneunit/redis</strong>
  <br/>
  Redis client, BullMQ job queues, distributed rate limiting, coordination, caching & resilience for Node.js
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oneunit/redis"><img src="https://img.shields.io/npm/v/@oneunit/redis?color=0969da&label=npm" alt="npm version"></a>
  <a href="https://github.com/mayank040902/oneunit/blob/master/packages/redis/LICENSE"><img src="https://img.shields.io/npm/l/@oneunit/redis?color=22863a" alt="license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-417e38" alt="node version">
  <img src="https://img.shields.io/badge/types-included-3178c6" alt="types included">
</p>

<p align="center">
  Shared connections · Safe Redis URL handling · Credential redaction · Bounded health checks<br/>
  Idempotent graceful shutdown · Production BullMQ defaults · Safe pipeline batching · Universal logger support<br/>
  Distributed rate limiting · Quotas · Concurrency · Burst protection · Fail-open/closed<br/>
  Distributed locks · Semaphores · Leader election · Barriers · Fencing tokens<br/>
  Redis caching · L1 local cache · Write-behind · Tag invalidation · Stale-while-revalidate<br/>
  Resilience engine · Local fallback · TTL-preserving recovery · Ambiguous outcome handling
</p>

---

## Quick Start

```bash
npm install @oneunit/redis
```

```typescript
import { createClient } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.set("hello", "world");
console.log(await redis.get("hello")); // "world"
await redis.shutdown();
```

---

## Subpath Imports (Tree-Shakable)

Import only what you need:

```typescript
// Everything
import { createClient, createQueue, createWorker } from "@oneunit/redis";

// Redis client only (zero BullMQ)
import { createClient, health, shutdown } from "@oneunit/redis/client";

// Queues & workers
import { createQueue, createWorker, attachQueueEvents } from "@oneunit/redis/queue";

// Pipeline batching
import { runPipeline, pipelineValues } from "@oneunit/redis/pipeline";

// Rate limiting & traffic control
import { createRateLimiter, createQuota, createConcurrencyLimiter, createBurstProtector, createMultiRateLimiter } from "@oneunit/redis/rate-limit";

// Distributed coordination
import { createCoordinationClient } from "@oneunit/redis/coordination";

// Redis caching
import { createRedisCache } from "@oneunit/redis/cache";

// Resilience engine
import { createResilientRedis } from "@oneunit/redis/resilience";

// At-least-once jobs (via createClient options)
import { createClient } from "@oneunit/redis";

// Core helpers & auth stores
import { createRedisStores, buildKey, serialize, deserialize, jitterTtl, setIfAbsent, compareAndSwap } from "@oneunit/redis/features";
```

---

## Features Overview

### 1. Redis Client (`@oneunit/redis/client`)
- **Safe URL handling** — `createClient("redis://...")` or `createClient({ url })`, no silent localhost fallback
- **Credential redaction** — Passwords stripped from `AUTH`/`HELLO` errors in all paths
- **Bounded health checks** — `health(client, { timeout: 1000 })` returns latency + status
- **Idempotent shutdown** — `shutdown(client)` with 5s deadline, forced disconnect fallback
- **Sentinel & Cluster** — `createSentinelClient()`, `createClusterClient()` (via `@oneunit/redis/features` or root)
- **Transactions** — `runTransaction` with labelled steps, timeout, typed results

### 2. BullMQ Queues & Workers (`@oneunit/redis/queue`)
- **Shared connection** — Single ioredis client for client, queues, workers, rate limiters
- **Production defaults** — Exponential backoff (1s→2s→4s), 3 retries, retention pruning
- **Queue events** — `attachQueueEvents` with automatic prefix inheritance
- **DLQ support** — Dead-letter queue with sanitized payloads
- **Flow producer** — `createFlowProducer` for job dependencies
- **Bulk operations** — `addBulkJobs`, `scheduleJob`, `pauseQueue`/`resumeQueue`

### 3. Pipeline Batching (`@oneunit/redis/pipeline`)
- **Safe batching** — `runPipeline` validates exactly one command per step
- **Per-command errors** — Failed commands reported individually, batch continues
- **Redaction** — Errors redacted before returning
- **Timeout** — Bounded by 5s default

### 4. Distributed Rate Limiting (`@oneunit/redis/rate-limit`)

| Algorithm | Use Case |
|-----------|----------|
| Fixed Window | Simple, low-overhead request limiting |
| Sliding Window | Smooth rate limiting, no boundary bursts |
| Token Bucket | Burst allowance with sustained rate |
| Leaky Bucket | Policing/shaping, constant output rate |

**Advanced capabilities:**
- **Multi-dimensional** — Compose multiple limiters (`createMultiRateLimiter`)
- **Weighted requests** — Fractional costs (`consume(key, 2.5)`)
- **Daily/monthly quotas** — Calendar-based (`createQuota`)
- **Distributed concurrency** — Semaphore permits (`createConcurrencyLimiter`)
- **Burst protection** — Sustained + burst tiers (`createBurstProtector`)
- **Fail-open/fail-closed** — Configurable failure behavior
- **Adaptive throttling** — Local load-based adjustment
- **Load shedding** — Priority-based admission control
- **Backpressure** — Max in-flight with wait queue

### 5. Distributed Coordination (`@oneunit/redis/coordination`)
Built on atomic Lua scripts with Redis server time (`TIME`) and hash-tag support for Cluster.

| Primitive | Description |
|-----------|-------------|
| **Locks** | Mutex with fencing tokens, TTL, renewal, safe release |
| **Semaphores** | Counting permits with lease expiration |
| **Leases** | Time-bound ownership with epoch fencing |
| **Leader Election** | Term-based leader acquisition/loss |
| **Singleton Scheduler** | One-owner periodic task scheduling |
| **Job Claims** | At-least-once job claim/complete/release |
| **Barriers** | Arrive-and-wait synchronization |
| **Fencing** | Validate/compare/bump fencing tokens |
| **Resource Leases** | Lease wrapper over arbitrary resources |
| **Single-Flight** | Dedupe concurrent same-key execution |

### 6. Redis Caching (`@oneunit/redis/cache`)
```typescript
const cache = createRedisCache(redis, {
  defaultTtlSeconds: 300,
  localL1: { enabled: true, ttlSeconds: 60, maxEntries: 10_000 },
  writeBehind: { enabled: true, flushIntervalMs: 5000 },
  staleWhileRevalidate: true,
  negativeTtlSeconds: 30,
  metrics: true,
});

// Read-through with stampede protection
const user = await cache.getOrLoad("user:1", async () => db.users.find(1));

// Tag-based invalidation
await cache.set("post:1", post, { ttlSeconds: 300, tags: ["posts", "user:1"] });
await cache.invalidateTag("user:1");
```

**Features:** L1 in-memory cache (LRU/LFU/FIFO/random), write-behind, stale-while-revalidate, tag invalidation, TTL jitter, negative caching, metrics.

### 7. Resilience Engine (`@oneunit/redis/resilience`)
Transparent fallback during Redis outages:

```typescript
const redis = createClient({
  url: process.env.REDIS_URL,
  resilience: { fallback: { enabled: true }, recovery: { enabled: true } },
});

// During outage: eligible reads served locally, eligible writes journaled
// On recovery: TTL-preserving replay with conflict detection
await redis.set("key", value);
const value = await redis.get("key");
```

**Guarantees:** Bounded memory, TTL preservation, ambiguous outcome handling (non-idempotent → `AMBIGUOUS`), conflict detection, process-local (no cross-instance coordination).

### 8. At-Least-Once Job Processing
Optional BullMQ-backed queue with zero overhead when disabled:

```typescript
const redis = createClient({
  url: process.env.REDIS_URL,
  jobAtLeastOnce: {
    enabled: true,
    queueName: "app-jobs",
    concurrency: 10,
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    dlq: { queueName: "app-jobs-dlq", preservePayload: true },
  },
});

const worker = redis.jobAtLeastOnce.createWorker(async (job) => {
  await doWork(job.data);
  return { success: true };
});

await redis.jobAtLeastOnce.add("send-email", { to: "user@example.com" });
```

### 9. Scheduled Session Revocation
Delayed session revocation via BullMQ delayed jobs:

```typescript
import { createScheduledSessionRevocation } from "@oneunit/redis/features";

const scheduler = createScheduledSessionRevocation({
  connection: client,
  queueName: "session-revocation",
  sessionStore,
  prefix: "queue",
  concurrency: 1,
});
await scheduler.schedule(sessionId, Date.now() + 30 * 60 * 1000); // timestamp or Date (runAt)
```

### 10. Auth Stores (`@oneunit/redis/features`)
- `createRedisRefreshStore` — Refresh tokens with TTL + consume
- `createRedisSessionStore` — Session data with TTL
- `createRedisStateStore` — OAuth state with TTL + consume

### 11. Core Helpers (`@oneunit/redis/features`)
| Helper | Purpose |
|--------|---------|
| `buildKey(...parts)` | Validated namespace/key builder |
| `serialize/deserialize` | JSON codec helpers |
| `jitterTtl(base, jitter?)` | TTL jitter to prevent stampedes |
| `setIfAbsent` | Atomic write gate (`SET NX`) |
| `compareAndSwap` | Optimistic atomic CAS |
| `detectCapabilities` | Redis feature detection |

---

## Architecture Highlights

| Principle | Implementation |
|-----------|----------------|
| **Shared connections** | `maxRetriesPerRequest: null` by default |
| **Credential safety** | Mandatory redaction in all error paths |
| **Ownership contracts** | `shutdown()` idempotent; queues/workers close owned connections |
| **Subpath isolation** | `@oneunit/redis/client` loads without BullMQ |
| **Queue option merging** | Per-key merge preserves defaults; `null` = keep forever |
| **Pipeline validation** | One command per step enforced at runtime |
| **Cluster safety** | Hash tags `{resource}` for CROSSSLOT compatibility |

---

## Verification Status

| Category | Tests | Status |
|----------|-------|--------|
| Core Redis | 40 | ✅ |
| Queue/Worker | 22 | ✅ |
| Pipeline | 19 | ✅ |
| Rate Limiting | 200+ | ✅ |
| Coordination | 28 | ✅ |
| Caching | 70 | ✅ |
| Resilience | 67 | ✅ |
| At-Least-Once Jobs | 6 | ✅ |
| Scheduled | 10 | ✅ |
| Auth Stores | 3 | ✅ |
| Security | 14 | ✅ |

**Total: 640 tests, all passing**

---

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — Design principles, data flow, ownership contracts
- [Redis Client](docs/client/README.md) — createClient, health checks, shutdown, transactions, Sentinel/Cluster
- [Queues & Workers](docs/queue/README.md) — BullMQ factories, job operations, worker lifecycle, DLQ, events
- [Pipeline Batching](docs/pipeline/README.md) — Bounded pipeline, per-command errors, redaction, timeouts
- [Distributed Coordination](docs/coordination/README.md) — Locks, semaphores, leases, leader election, single-flight, job claims, barriers, fencing
- [Rate Limiting](docs/rate-limit/README.md) — Algorithms, advanced features, operational concerns
- [Redis Caching](docs/cache/README.md) — L1 cache, write-behind, tag invalidation, SWR, negative caching, metrics
- [Resilience Engine](docs/resilience/README.md) — Fallback, recovery, configuration
- [Auth Stores & Features](docs/features/README.md) — Refresh/session/state stores, scheduled revocation, core helpers
- [At-Least-Once Jobs](docs/jobs/README.md) — BullMQ job processing, retries, backoff, DLQ, workers
- [Scheduled Session Revocation](docs/scheduled/README.md) — Delayed session revocation via BullMQ
- [Changelog](docs/CHANGELOG.md) — Version history
- [Contributing](docs/CONTRIBUTING.md) — Development workflow

---

## License

MIT License — see [LICENSE](LICENSE) for details.