# Redis Client (`@oneunit/redis/client`)

A production-ready Redis client wrapper built on `ioredis` with safe URL handling, credential redaction, bounded health checks, idempotent shutdown, Sentinel/Cluster support, typed transactions, and optional resilience & at-least-once job processing.

## Table of Contents

1. [Quick Start](#quick-start)
2. [createClient](#createclient)
3. [Connection Safety](#connection-safety)
4. [Credential Redaction](#credential-redaction)
5. [Health Checks](#health-checks)
6. [Graceful Shutdown](#graceful-shutdown)
7. [Transactions](#transactions)
8. [Sentinel & Cluster](#sentinel--cluster)
9. [Error Handling](#error-handling)
10. [Subpath Imports](#subpath-imports)
11. [API Reference](#api-reference)
12. [Operational Notes](#operational-notes)

---

## Quick Start

```typescript
import { createClient, shutdown, health } from '@oneunit/redis/client';

const redis = createClient({ url: 'redis://localhost:6379' });

await redis.set('hello', 'world');
console.log(await redis.get('hello')); // "world"

const h = await health(redis, { timeout: 1000 });
console.log(h.status); // "up"

await shutdown(redis);
```

---

## createClient

`createClient` accepts either a URL string or an options object. It constructs an `ioredis` client, attaches event handlers, and optionally wraps it with resilience or job-processing capabilities.

### Signature

```typescript
createClient(options?: RedisClientOptions | string, logger?: Logger): Redis | ResilientRedisFacade;
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | `process.env.REDIS_URL` | Redis connection URL. Required. |
| `lazyConnect` | `boolean` | `true` | Defer connection until first command. |
| `errorHandling` | `ErrorHandlingOptions` | — | Enable typed error classification & retry. |
| `resilience` | `ResilientRedisOptions` | — | Enable the resilience engine (fallback/recovery). |
| `fallback` | `FallbackOptions` | — | Degraded-mode local read/write during outages. |
| `recovery` | `RecoveryOptions` | — | Automatic journal replay when Redis returns. |
| `ownsClient` | `boolean` | — | Whether `shutdown()` closes the underlying client. |
| `shutdownClient` | `boolean` | — | Whether `shutdown()` closes the underlying client. |
| `atLeastOnce` / `jobAtLeastOnce` | `boolean \| JobAtLeastOnceOptions` | — | Enable BullMQ-backed at-least-once job processing. |
| `prefix` | `string` | — | Key prefix for queues/coordination. |

### Important: URL handling

**`createClient("redis://...")`** works correctly — ioredis reads `url` from the first positional argument.

**`createClient({ url })`** also works — the package passes `url` into the options object that ioredis reads.

**Do not** pass `keyPrefix` — it is incompatible with BullMQ. Use `prefix` instead.

```typescript
// ✅ Correct
const redis = createClient('redis://default:pass@host:6379');

// ✅ Also correct
const redis = createClient({ url: process.env.REDIS_URL });

// ❌ Avoid
const redis = createClient({ keyPrefix: 'app:' }); // throws
```

---

## Connection Safety

### No silent localhost fallback

If no URL is provided via options or `REDIS_URL`, `createClient` throws immediately rather than silently connecting to localhost:6379.

```typescript
try {
  createClient({}); // throws: "No Redis URL provided..."
} catch (e) {
  // Fail fast — no accidental localhost connection
}
```

### Bounded defaults

- `maxRetriesPerRequest: null` — ioredis does not retry individual commands indefinitely.
- `retryStrategy` disabled when at-least-once jobs are enabled — prevents unbounded reconnect loops from Queue/QueueEvents duplicate connections.
- `lazyConnect: true` by default — connection established on first command. Use `lazyConnect: false` to connect eagerly.

### Sentinel & Cluster

```typescript
import { createSentinelClient } from '@oneunit/redis/client';
import { createClusterClient } from '@oneunit/redis/features';

const sentinel = createSentinelClient({
  sentinels: [{ host: '10.0.0.1', port: 26379 }],
  name: 'mymaster',
});

const cluster = createClusterClient(['redis://node1:6379', 'redis://node2:6379']);
```

---

## Credential Redaction

Passwords are stripped from `AUTH`/`HELLO` errors across all error paths — events, shutdown logs, queue events, rate limiter errors, and pipeline failures.

```typescript
import { redactError } from '@oneunit/redis/client';

const safe = redactError(new Error('AUTH failed: password=secret123'));
// "AUTH failed: password=REDACTED"
```

Redacted credentials never appear in log output or exception messages.

---

## Health Checks

`health(client, options)` runs a bounded `PING` and returns status + latency.

```typescript
import { health } from '@oneunit/redis/client';

const result = await health(redis, { timeout: 1000 });
// { status: 'up', latency: { value: 2, unit: 'ms' } }
// or { status: 'down', latency: { value: 1000, unit: 'ms' }, error: '...' }
```

| Option | Type | Default |
|--------|------|---------|
| `timeout` | `number` | `1000` ms |

Errors are redacted before being returned. Invalid/negative timeouts fall back to `1000` ms.

---

## Graceful Shutdown

`shutdown(client)` sends `QUIT`, waits up to 5s, then forces `disconnect()` if needed. It is idempotent — calling it twice is safe.

```typescript
import { shutdown } from '@oneunit/redis/client';

await shutdown(redis, { timeout: 5000, logger });

// Or with a logger object directly
await shutdown(redis, logger);
```

| Option | Type | Default |
|--------|------|---------|
| `timeout` | `number` | `5000` ms |
| `logger` | `Logger` | — |

If `QUIT` times out, the connection is force-disconnected and a warning is logged. A closed client is a no-op.

---

## Transactions

`runTransaction(client, steps, options)` wraps Redis `MULTI`/`EXEC` with typed steps, bounded timeout, and credential redaction.

```typescript
import { runTransaction } from '@oneunit/redis/client';

const result = await runTransaction(redis, [
  { label: 'incr-counter', run: (t) => t.incr('counter') },
  { label: 'get-counter', run: (t) => t.get('counter') },
], { timeout: 5000 });

// result: { executed: true, results: [...], durationMs: 12, failed: 0 }
```

### Options

| Option | Type | Default |
|--------|------|---------|
| `timeout` | `number` | `5000` ms |
| `watch` | `string[]` | — |
| `throwOnError` | `boolean` | — |
| `logger` | `Logger` | — |

### Error types

- `TransactionTimeoutError` — EXEC did not complete within `timeout`.
- `TransactionStepError` — a step did not queue exactly one command.
- `TransactionCommandError` — one or more commands failed (when `throwOnError: true`).

---

## Error Handling

`attachErrorHandling` and `classifyError` provide typed error classification and retry policies.

```typescript
import { attachErrorHandling, classifyError, isRetryable } from '@oneunit/redis/client';

attachErrorHandling(client, {
  enabled: true,
  logger,
  onError: (err) => { /* ... */ },
});

if (isRetryable(error)) {
  // safe to retry
}
```

See `src/client/events.ts` for full `ErrorHandlingOptions`.

---

## Subpath Imports

Import only what you need:

```typescript
// Client only (zero BullMQ, zero queue code)
import { createClient, health, shutdown } from '@oneunit/redis/client';
```

---

## API Reference

### Main exports

```typescript
import {
  createClient,           // Construct Redis client (URL string or options)
  shutdown,               // Idempotent graceful shutdown with bounded QUIT
  health,                 // Bounded PING health check
  attachEvents,           // Attach ioredis lifecycle event handlers
  attachErrorHandling,    // Typed error classification & retry
  redactError,            // Strip credentials from error messages
  classifyError,          // Classify error type
  isRetryable,            // Check if error is retryable
  retryOperation,         // Retry async operation with backoff + jitter
  retryOperationWithResult, // Retry with attempt count returned
  runTransaction,         // Typed MULTI/EXEC wrapper
  createSentinelClient,   // Sentinel-backed client factory
} from '@oneunit/redis/client';

// Cluster client factory is exported from '@oneunit/redis/features' or root '@oneunit/redis'
import { createClusterClient } from '@oneunit/redis/features';
```

### Types

```typescript
import type {
  RedisClientOptions,
  Logger,
  HealthResult,
  HealthOptions,
  ShutdownOptions,
  TransactionStep,
  TransactionOptions,
  TransactionResult,
  ErrorHandlingOptions,
  RetryPolicy,
  RetryResult,
} from '@oneunit/redis/client';
```

---

## Operational Notes

| Concern | Behavior |
|---------|----------|
| Shared connections | `maxRetriesPerRequest: null` by default |
| Credential safety | Mandatory redaction in all error paths |
| Ownership | `shutdown()` idempotent; queues/workers close owned connections |
| Subpath isolation | `@oneunit/redis/client` loads without BullMQ |
| Cluster safety | Hash tags `{resource}` for CROSSSLOT compatibility |
| Lazy connect | `lazyConnect: true` by default — connect on first command |

---

## Testing

```bash
npm test              # Run test suite
npm run test:coverage # Run with coverage
npm run verify        # Complete verification pipeline
```
