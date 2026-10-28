# Redis Caching (`@oneunit/redis/cache`)

A Redis-backed cache with TTL, local L1 cache, write-behind, tag-based invalidation, stale-while-revalidate, negative caching, stampede protection, and metrics.

## Table of Contents

1. [Quick Start](#quick-start)
2. [createRedisCache](#createrediscache)
3. [Core Operations](#core-operations)
4. [Read-Through](#read-through)
5. [Write-Through](#write-through)
6. [Write-Behind](#write-behind)
7. [Local L1 Cache](#local-l1-cache)
8. [Invalidation](#invalidation)
9. [Stale-While-Revalidate](#stale-while-revalidate)
10. [Negative Caching](#negative-caching)
11. [TTL & Jitter](#ttl--jitter)
12. [Tags](#tags)
13. [Metrics](#metrics)
14. [API Reference](#api-reference)
15. [Operational Notes](#operational-notes)

---

## Quick Start

```typescript
import { createClient, createRedisCache, shutdown } from '@oneunit/redis';

const redis = createClient({ url: process.env.REDIS_URL });

const cache = createRedisCache(redis, {
  defaultTtlSeconds: 300,
  localL1: { enabled: true, ttlSeconds: 60, maxEntries: 10_000 },
  writeBehind: { enabled: true, flushIntervalMs: 5000 },
  staleWhileRevalidate: true,
  negativeTtlSeconds: 30,
  metrics: true,
});

// Read-through with stampede protection
const user = await cache.getOrLoad('user:1', async () => db.users.find(1));

// Tag-based invalidation
await cache.set('post:1', post, { ttlSeconds: 300, tags: ['posts', 'user:1'] });
await cache.invalidateTag('user:1');

await cache.shutdown();
await shutdown(redis);
```

---

## createRedisCache

### Signature

```typescript
createRedisCache(redis: Redis, options?: RedisCacheOptions): RedisCache;
```

### RedisCacheOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `keyPrefix` | `string` | `'oneunit:cache:'` | Redis key prefix |
| `defaultTtlSeconds` | `number` | — | Default TTL for all entries |
| `negativeTtlSeconds` | `number` | — | TTL for cached null results |
| `staleWhileRevalidate` | `boolean` | `false` | Serve stale while revalidating |
| `swrStaleSeconds` | `number` | `60` | Seconds before expiry considered stale |
| `jitter` | `number` | — | TTL jitter (0-1) to spread expirations |
| `metrics` | `boolean` | — | Track hit/miss metrics |
| `writeBehind` | `WriteBehindOptions` | — | Async flush to Redis |
| `localL1` | `LocalL1CacheOptions` | — | In-memory L1 cache |
| `logger` | `Logger` | — | Optional logger |

---

## Core Operations

### get

```typescript
const value = await cache.get<string>('user:1');
// Returns null if key not found or expired
```

### set

```typescript
await cache.set('user:1', { name: 'Alice' }, { ttlSeconds: 300 });
```

### invalidate

```typescript
await cache.invalidate('user:1');
```

---

## Read-Through

`getOrLoad` reads from cache, falling back to a loader with in-process stampede protection (only one caller runs the loader per key).

```typescript
const user = await cache.getOrLoad('user:1', async () => {
  return await db.users.find(1);
}, { ttlSeconds: 300, tags: ['users'] });
```

`remember` is an alias for `getOrLoad`.

```typescript
const user = await cache.remember('user:1', async () => db.users.find(1));
```

`wrap` creates a memoized function:

```typescript
const getUser = cache.wrap(
  (id: number) => `user:${id}`,
  async (id: number) => db.users.find(id)
);

const user = await getUser(1); // cached by key `user:1`
```

---

## Write-Through

`writeThrough` writes synchronously to Redis, bypassing write-behind:

```typescript
const result = await cache.writeThrough('user:1', async () => {
  return await db.users.find(1);
}, { ttlSeconds: 300 });
```

Or use `set` with `writeThrough: true`:

```typescript
await cache.set('user:1', data, { ttlSeconds: 300, writeThrough: true });
```

---

## Write-Behind

Write-behind caches writes locally and flushes to Redis asynchronously:

```typescript
const cache = createRedisCache(redis, {
  writeBehind: {
    enabled: true,
    flushIntervalMs: 5000,      // flush every 5s
    maxDirtyEntries: 100,       // flush when 100 dirty entries
    maxDirtyAgeMs: 5000,        // flush after 5s age
    onFlushError: (error, entries) => {
      console.error('Flush failed:', error.message);
    },
  },
});

await cache.set('user:1', data); // goes to L1 + dirty queue
// ... flushed to Redis automatically

await cache.flushWriteBehind();  // force flush now
const stats = cache.writeBehindStats();
// { pending: 0, flushes: 5, flushErrors: 0, ... }
```

---

## Local L1 Cache

In-memory L1 cache with configurable size policy and eviction:

```typescript
const cache = createRedisCache(redis, {
  localL1: {
    enabled: true,
    ttlSeconds: 60,
    populateOnMiss: true,
    sizePolicy: {
      maxEntries: 10_000,
      maxMemoryBytes: 50 * 1024 * 1024,
      evictionPolicy: 'lru', // lru | lfu | fifo | random
    },
  },
});

const stats = cache.l1Stats();
// { entries: 150, memoryBytes: 45000, evictions: 2, hits: 500, misses: 10 }

cache.clearL1();
cache.evictL1(10);
```

---

## Invalidation

### Single key

```typescript
await cache.invalidate('user:1');
```

### Tag-based

```typescript
await cache.set('post:1', post, { ttlSeconds: 300, tags: ['posts', 'user:1'] });
await cache.set('post:2', post, { ttlSeconds: 300, tags: ['posts', 'user:1'] });

await cache.invalidateTag('user:1'); // invalidates all posts for user:1
```

---

## Stale-While-Revalidate

Serve stale values while revalidating in the background:

```typescript
const cache = createRedisCache(redis, {
  staleWhileRevalidate: true,
  swrStaleSeconds: 60,
});

const user = await cache.getOrLoad('user:1', async () => db.users.find(1));
// After TTL expires but within SWR window, returns stale value
// and revalidates in background
```

---

## Negative Caching

Cache null results to avoid re-running loaders for missing keys:

```typescript
const cache = createRedisCache(redis, {
  negativeTtlSeconds: 30,
});

const user = await cache.getOrLoad('user:999', async () => {
  return await db.users.find(999); // returns null
}, { negativeCaching: true });
// null is cached for 30 seconds; subsequent calls return null without calling loader
```

---

## TTL & Jitter

TTL jitter spreads expirations to prevent cache stampedes:

```typescript
const cache = createRedisCache(redis, {
  defaultTtlSeconds: 300,
  jitter: 0.1, // ±10% jitter on all TTLs
});

// Per-entry TTL override
await cache.set('user:1', data, { ttlSeconds: 600 });
```

---

## Tags

Tags group keys for bulk invalidation:

```typescript
await cache.set('post:1', post, { ttlSeconds: 300, tags: ['posts', 'user:1', 'category:news'] });
await cache.set('post:2', post, { ttlSeconds: 300, tags: ['posts', 'user:1'] });

await cache.invalidateTag('user:1'); // both posts invalidated
await cache.invalidateTag('category:news'); // only post:1 invalidated
```

---

## Metrics

```typescript
const metrics = cache.metrics();
// {
//   hits: 1000,
//   misses: 200,
//   hitRate: 0.833,
//   l1Hits: 800,
//   l1Misses: 100,
//   writeBehindFlushes: 50,
//   writeBehindPending: 3,
// }

cache.resetMetrics();
```

---

## API Reference

```typescript
import {
  createRedisCache,
} from '@oneunit/redis/cache';

import type {
  RedisCache,
  RedisCacheOptions,
  CacheSetOptions,
  CacheLoadOptions,
  CacheMetrics,
  WriteBehindStats,
  L1CacheStats,
  WriteBehindOptions,
  LocalL1CacheOptions,
  EvictionPolicy,
} from '@oneunit/redis/cache';
```

### RedisCache interface

| Method | Description |
|--------|-------------|
| `get<T>(key)` | Get value from cache |
| `set(key, value, options?)` | Set value with optional TTL/tags |
| `getOrLoad<T>(key, loader, options?)` | Read-through with stampede protection |
| `remember<T>(key, loader, options?)` | Alias for getOrLoad |
| `wrap<TArgs, TResult>(keyFactory, fn, options?)` | Memoized function wrapper |
| `writeThrough<T>(key, writer, options?)` | Synchronous write-through |
| `warm<T>(key, loader, options?)` | Prepopulate without returning |
| `invalidate(key)` | Remove a key |
| `invalidateTag(tag)` | Remove all keys with a tag |
| `metrics()` | Hit/miss/L1/write-behind metrics |
| `resetMetrics()` | Reset all counters |
| `writeBehindStats()` | Write-behind flush statistics |
| `flushWriteBehind()` | Force flush dirty entries |
| `l1Stats()` | L1 cache statistics |
| `clearL1()` | Clear L1 cache |
| `evictL1(count?)` | Manually evict L1 entries |
| `shutdown()` | Flush write-behind, clear timers |

---

## Operational Notes

| Concern | Behavior |
|---------|----------|
| L1 cache | Process-local, bounded by entries/memory, LRU/LFU/FIFO/random eviction |
| Write-behind | Async flush, bounded dirty entries, retry on failure |
| Stampede protection | In-process coalescing — one loader per key |
| SWR | Serve stale while revalidating in background |
| Negative caching | Cache null results to avoid repeated loader calls |
| Tag invalidation | Set-based tag membership for bulk invalidation |
| TTL jitter | Spread expirations to prevent stampedes at expiry time |
| Credential redaction | All errors redacted before logging |
