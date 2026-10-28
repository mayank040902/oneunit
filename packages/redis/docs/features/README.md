# Auth Stores & Core Features (`@oneunit/redis/features`)

Redis-backed auth stores (refresh tokens, sessions, temporary state), scheduled session revocation, and core helpers (key building, serialization, TTL jitter, atomic compare-and-swap, capability detection).

## Table of Contents

1. [Quick Start](#quick-start)
2. [Auth Stores](#auth-stores)
   - [Refresh Store](#refresh-store)
   - [Session Store](#session-store)
   - [State Store](#state-store)
   - [createRedisStores](#createredisstores)
3. [Scheduled Session Revocation](#scheduled-session-revocation)
4. [Core Helpers](#core-helpers)
   - [buildKey](#buildkey)
   - [serialize / deserialize](#serialize--deserialize)
   - [jitterTtl](#jitterttl)
   - [setIfAbsent](#setifabsent)
   - [compareAndSwap](#compareandswap)
   - [detectCapabilities](#detectcapabilities)
   - [createClusterClient](#createclusterclient)
5. [Retry Helpers](#retry-helpers)
6. [Subpath Imports](#subpath-imports)
7. [API Reference](#api-reference)

---

## Quick Start

```typescript
import { createClient } from '@oneunit/redis';
import { createRedisStores } from '@oneunit/redis/features';

const redis = createClient({ url: process.env.REDIS_URL });

const stores = createRedisStores(redis, {
  keyPrefix: 'oneunit:auth:',
  revokedSessionTtlSeconds: 30 * 24 * 60 * 60, // 30 days
});

// Refresh token
await stores.refreshStore.save({ id: 'rt-1', userId: 'u-1', tokenHash: 'hash', expiresAt: Date.now() + 86400000 });
const record = await stores.refreshStore.get('rt-1');
const consumed = await stores.refreshStore.consume('rt-1'); // atomic consume + delete

// Session versioning
const version = await stores.sessionStore.getVersion('u-1');
await stores.sessionStore.bumpVersion('u-1');
await stores.sessionStore.revokeSession('session-123');
const revoked = await stores.sessionStore.isSessionRevoked('session-123');

// Temporary state (one-time consume)
await stores.stateStore.set('oauth-state', { nonce: 'abc' }, 300);
const value = await stores.stateStore.consume('oauth-state'); // returns value, then deletes
```

---

## Auth Stores

All three stores are exported from `@oneunit/redis/features` and depend on the optional peer `@oneunit/auth` for type definitions.

### Refresh Store

`RefreshStore` — refresh tokens with TTL + atomic consume (Lua script).

| Method | Signature | Description |
|--------|-----------|-------------|
| `save(record)` | `(record: RefreshRecord) => Promise<void>` | Save a refresh token with TTL |
| `get(id)` | `(id: string) => Promise<RefreshRecord \| null>` | Get a refresh token (checks expiry) |
| `consume(id)` | `(id: string) => Promise<RefreshRecord \| null>` | Atomic get + delete (Lua) |
| `revoke(id)` | `(id: string) => Promise<void>` | Revoke/delete a refresh token |

```typescript
import { createRedisRefreshStore } from '@oneunit/redis/features';

const store = createRedisRefreshStore(redis, { keyPrefix: 'auth:' });

await store.save({
  id: 'rt-1',
  userId: 'u-1',
  tokenHash: 'sha256hash',
  expiresAt: Date.now() + 86400000, // 24 hours
});

const record = await store.get('rt-1');
// { id: 'rt-1', userId: 'u-1', tokenHash: '...', expiresAt: ... }

// Atomic consume — returns record and deletes it
const consumed = await store.consume('rt-1');
// Subsequent consume returns null
await store.revoke('rt-1');
```

The `consume` operation uses a Lua script for atomicity: reads, validates expiry, deletes, and returns in one Redis round trip.

### Session Store

`SessionStore` — per-user version counters and revoked-session flags with TTL.

| Method | Signature | Description |
|--------|-----------|-------------|
| `getVersion(userId)` | `(userId) => Promise<number>` | Get session version (0 if none) |
| `bumpVersion(userId)` | `(userId) => Promise<number>` | Increment version (invalidates all sessions) |
| `revokeSession(sessionId)` | `(sessionId) => Promise<void>` | Mark session as revoked |
| `isSessionRevoked(sessionId)` | `(sessionId) => Promise<boolean>` | Check revocation status |

```typescript
import { createRedisSessionStore } from '@oneunit/redis/features';

const store = createRedisSessionStore(redis, {
  keyPrefix: 'auth:',
  revokedSessionTtlSeconds: 30 * 24 * 60 * 60, // 30 days
});

const version = await store.getVersion('u-1'); // 0
await store.bumpVersion('u-1'); // 1
const version2 = await store.getVersion('u-1'); // 1

await store.revokeSession('session-123');
const revoked = await store.isSessionRevoked('session-123'); // true
```

### State Store

`StateStore` — temporary single-use state with TTL and atomic consume.

| Method | Signature | Description |
|--------|-----------|-------------|
| `set(id, value, ttlSeconds?)` | `(id, value, ttlSeconds?) => Promise<void>` | Set state with optional TTL (default 600s) |
| `get(id)` | `(id) => Promise<unknown \| null>` | Get state (checks expiry) |
| `delete(id)` | `(id) => Promise<void>` | Delete state |
| `consume(id)` | `(id) => Promise<unknown \| null>` | Atomic get + delete (Lua) |

```typescript
import { createRedisStateStore } from '@oneunit/redis/features';

const store = createRedisStateStore(redis, { keyPrefix: 'auth:' });

// OAuth state (one-time use)
await store.set('oauth-state-xyz', { nonce: 'abc', redirect: '/dashboard' }, 300);
const state = await store.consume('oauth-state-xyz');
// { nonce: 'abc', redirect: '/dashboard' }
// Subsequent consume returns null (state is consumed)
```

---

### createRedisStores

Factory returning all three stores with shared options:

```typescript
import { createRedisStores } from '@oneunit/redis/features';

const stores = createRedisStores(redis, {
  keyPrefix: 'oneunit:auth:',
  revokedSessionTtlSeconds: 30 * 24 * 60 * 60,
});

// stores.refreshStore
// stores.sessionStore
// stores.stateStore
```

### RedisStoreOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `keyPrefix` | `string` | `'oneunit:auth:'` | Redis key prefix |
| `revokedSessionTtlSeconds` | `number` | `2592000` (30 days) | TTL for revoked session flags |

---

## Scheduled Session Revocation

Queue-backed delayed session revocation built on BullMQ delayed jobs.

```typescript
import { createScheduledSessionRevocation } from '@oneunit/redis/features';

const scheduler = createScheduledSessionRevocation({
  connection: client,
  queueName: 'session-revocation',
  sessionStore,
  prefix: 'queue',
  concurrency: 1,
});

await scheduler.schedule(sessionId, Date.now() + 30 * 60 * 1000); // timestamp or Date (runAt)
```

See `src/features/scheduled.ts` for the full implementation.

---

## Core Helpers

### buildKey

Validated namespace/key builder with `:` separator:

```typescript
import { buildKey } from '@oneunit/redis/features';

const key = buildKey('app', 'user', '123'); // 'app:user:123'
// Throws if any segment is null, undefined, or empty
// Throws if no segments provided
```

### serialize / deserialize

JSON codec helpers:

```typescript
import { serialize, deserialize } from '@oneunit/redis/features';

const raw = serialize({ name: 'Alice' }); // '{"name":"Alice"}'
const obj = deserialize<{ name: string }>(raw); // { name: 'Alice' }
const nullVal = deserialize(null); // null
```

### jitterTtl

Apply TTL jitter to spread expirations:

```typescript
import { jitterTtl } from '@oneunit/redis/features';

const ttl = jitterTtl(300, 0.1); // ~270-330 seconds
// baseSeconds must be positive finite
// jitter must be between 0 and 1 (default 0.1)
```

### setIfAbsent

Atomic write gate using `SET NX`:

```typescript
import { setIfAbsent } from '@oneunit/redis/features';

const created = await setIfAbsent(redis, 'lock:resource', 'owner-1', { ttlSeconds: 30 });
// true if key was set, false if it already existed
```

### compareAndSwap

Optimistic atomic CAS using `WATCH`/`MULTI`/`EXEC`:

```typescript
import { compareAndSwap } from '@oneunit/redis/features';

const swapped = await compareAndSwap(
  redis,
  'counter',
  '5',      // expected current value
  '6',      // next value
  { ttlSeconds: 60, maxRetries: 5 },
);
// true if CAS succeeded, false if value changed or retries exhausted
```

### detectCapabilities

Redis feature detection:

```typescript
import { detectCapabilities } from '@oneunit/redis/features';

const caps = await detectCapabilities(redis);
// {
//   version: '7.0.0',
//   isCluster: false,
//   hasStreams: true,
//   hasAcl: true,
//   modules: [],
// }
```

### createClusterClient

Optional ioredis Cluster factory:

```typescript
import { createClusterClient } from '@oneunit/redis/features';

const cluster = createClusterClient([
  'redis://node1:6379',
  'redis://node2:6379',
]);
```

---

## Retry Helpers

Retry operation helpers are exported from `@oneunit/redis/features` (via `retry.ts`). These provide typed retry logic with exponential backoff and jitter for transient failures:

```typescript
import {
  retryOperation,
  retryOperationWithResult,
  isRetryClassifiedError,
  type RetryPolicy,
  type RetryResult,
} from '@oneunit/redis/features';

// Retry an operation with default policy (3 attempts, 100ms base, 5000ms max, jitter enabled)
const result = await retryOperation(async () => {
  return await fetchData();
});

// With custom policy and retry callback
const value = await retryOperation(
  async () => doSomething(),
  {
    attempts: 5,
    baseDelayMs: 200,
    maxDelayMs: 10_000,
    jitter: true,
    retryWhen: (err) => isRetryClassifiedError(err).retryable,
    onRetry: (attempt, error, delayMs) => {
      console.warn(`Retry attempt ${attempt} after ${delayMs}ms due to:`, error);
    },
  },
);

// Get both the result and total attempts made
const { value: data, attempts } = await retryOperationWithResult(async () => {
  return await remoteCall();
});
console.log(`Succeeded on attempt ${attempts}`);
```

---

## Subpath Imports

```typescript
// Everything
import {
  createRedisStores,
  buildKey,
  serialize,
  deserialize,
  jitterTtl,
  setIfAbsent,
  compareAndSwap,
  detectCapabilities,
  createClusterClient,
  retryOperation,
  retryOperationWithResult,
  createScheduledSessionRevocation,
  createRedisCache,
} from '@oneunit/redis/features';

// Auth only (also available via '@oneunit/redis/auth')
import {
  createRedisRefreshStore,
  createRedisSessionStore,
  createRedisStateStore,
  createRedisStores,
} from '@oneunit/redis/features';
```

---

## API Reference

```typescript
import {
  // Auth stores
  createRedisRefreshStore,
  createRedisSessionStore,
  createRedisStateStore,
  createRedisStores,

  // Scheduled revocation
  createScheduledSessionRevocation,

  // Core helpers
  buildKey,
  serialize,
  deserialize,
  jitterTtl,
  setIfAbsent,
  compareAndSwap,
  detectCapabilities,
  createClusterClient,
  Cluster,

  // Retry helpers
  retryOperation,
  retryOperationWithResult,
  isRetryClassifiedError,

  // Caching (re-exported)
  createRedisCache,
} from '@oneunit/redis/features';

import type {
  RedisStoreOptions,
  RedisStores,
  ScheduledSessionRevocationConfig,
  ScheduledSessionRevocation,
  RedisCapabilities,
  KeyBuilderOptions,
  RetryPolicy,
  RetryResult,
} from '@oneunit/redis/features';
```

---

## Operational Notes

| Concern | Behavior |
|---------|----------|
| Refresh store | Atomic consume via Lua script; TTL derived from `expiresAt` |
| Session store | Version counters with `INCR`; revocation flags with TTL |
| State store | Single-use consume via Lua script; default TTL 600s |
| Key building | Validated non-empty segments; `:` separator |
| CAS | `WATCH`/`MULTI`/`EXEC` with bounded retries |
| Cluster support | `createClusterClient` forwards options to ioredis Cluster |
