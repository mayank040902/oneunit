# @oneunit/redis - Rate Limiting & Traffic Control

A comprehensive, production-ready rate limiting and traffic control library for Redis with support for 16 distinct algorithms and capabilities.

## Overview

`@oneunit/redis` provides distributed rate limiting, quotas, concurrency control, and traffic management primitives built on Redis. All core algorithms use atomic Lua scripts to ensure correctness under high concurrency.

**Key Characteristics:**
- **Distributed**: All state in Redis, works across multiple application instances
- **Atomic**: Lua scripts guarantee race-free operations
- **Typed**: Full TypeScript support with strict types
- **Tested**: 693+ tests including stress, concurrency, and lifecycle verification
- **Observable**: Rich metadata on every decision (retry-after, remaining, limits, etc.)

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Core Algorithms](#core-algorithms)
   - [Fixed Window](#1-fixed-window-rate-limiter)
   - [Sliding Window](#2-sliding-window-rate-limiter)
   - [Token Bucket](#3-token-bucket-rate-limiter)
   - [Leaky Bucket](#4-leaky-bucket-rate-limiter-policing)
3. [Advanced Features](#advanced-features)
   - [Multi-Dimensional Limiting](#5-multi-dimensional-limiting)
   - [Weighted Requests](#6-weighted-rate-limiting)
   - [Distributed Concurrency](#7-distributed-concurrency-limiting)
   - [Daily/Monthly Quotas](#8-daily--monthly-quotas)
   - [Burst Protection](#9-burst-protection)
   - [Retry-After & Metadata](#10-retry-after--metadata)
   - [Fail-Open/Fail-Closed](#11-fail-open--fail-closed-policies)
4. [Local-Only Utilities](#local-only-utilities)
   - [Adaptive Throttling](#12-adaptive-throttling-local-only)
   - [Load Shedding](#13-load-shedding-local-only)
   - [Backpressure](#14-backpressure-local-only)
5. [Operational Concerns](#operational-concerns)
   - [Redis Cluster](#redis-cluster-support)
   - [Key Management](#key-management--expiration)
   - [Failure Handling](#failure-handling)
6. [API Reference](#api-reference)

---

## Quick Start

```typescript
import { createClient, createRateLimiter, shutdown } from '@oneunit/redis';

const client = createClient({ url: 'redis://localhost:6379' });

// Create a fixed-window rate limiter: 100 requests per minute
const limiter = createRateLimiter(client, {
  algorithm: 'fixed-window',
  limit: 100,
  intervalMs: 60_000,
});

// Check if request is allowed (doesn't consume)
const check = await limiter.check('user:123', 1);
if (check.allowed) {
  // Actually consume the request
  const result = await limiter.consume('user:123', 1);
  console.log(`Remaining: ${result.remaining}`);
}

// Cleanup on shutdown
await shutdown(client);
```

---

## Core Algorithms

### 1. Fixed Window Rate Limiter

**What it is:** Divides time into fixed windows (e.g., 0-60s, 60-120s) and counts requests per window. When a window expires, the counter resets.

**Use Cases:**
- API rate limiting with simple semantics
- Per-minute/hour/day quotas
- When exact boundary behavior is acceptable

**Usage:**
```typescript
import { createRateLimiter } from '@oneunit/redis';

const limiter = createRateLimiter(client, {
  algorithm: 'fixed-window',
  limit: 100,           // Max requests per window
  intervalMs: 60_000,   // Window size (1 minute)
  keyPrefix: 'api',     // Optional: namespace keys
});

// Consume 1 request
const result = await limiter.consume('user:123', 1);
// result: { allowed: true, remaining: 99, consumed: 1, retryAfterMs: null, resetAt: 1234567890000, ... }

// Check without consuming
const check = await limiter.check('user:123', 5);
// check: { allowed: true, remaining: 94, consumed: 0, ... }
```

**Advantages:**
- ✅ Simple to understand and debug
- ✅ Low memory overhead (single counter per key)
- ✅ Fast - single Redis `SET PX` operation
- ✅ Predictable reset times

**Limitations:**
- ❌ **Burst at boundaries**: A client can make `limit` requests at the end of one window and `limit` at the start of the next = 2× burst
- ❌ Less smooth than sliding window

**Trade-offs:**
| Aspect | Fixed Window | Sliding Window |
|--------|--------------|----------------|
| Memory | O(1) per key | O(requests in window) |
| Burst at boundary | Yes (2×) | No |
| Implementation | Simple | Complex (sorted sets) |
| Precision | Window-level | Request-level |

---

### 2. Sliding Window Rate Limiter

**What it is:** Tracks each request with a timestamp in a sorted set. Only requests within the last `intervalMs` are counted. Provides exact sliding window semantics.

**Use Cases:**
- Strict rate limiting where boundary bursts are unacceptable
- Smooth traffic shaping
- When exact request-level precision matters

**Usage:**
```typescript
const limiter = createRateLimiter(client, {
  algorithm: 'sliding-window',
  limit: 100,
  intervalMs: 60_000,  // Last 60 seconds
});

const result = await limiter.consume('user:123', 1);
// Each request stored with timestamp, automatically pruned
```

**Advantages:**
- ✅ No boundary bursts - smooth limiting
- ✅ Exact semantics - each request counted individually
- ✅ Accurate retry-after based on oldest request expiration

**Limitations:**
- ❌ **Memory grows with traffic**: Sorted set stores every request in window
- ❌ Higher latency: `ZRANGE` + `ZREMRANGEBYSCORE` per request
- ❌ High cardinality = more memory (each user = separate sorted set)

**Implementation Detail:** Uses Redis sorted sets (`ZSET`) where:
- Member = `${timestamp}:${uniqueToken}:${cost}`
- Score = timestamp (milliseconds)
- Pruned on every request: `ZREMRANGEBYSCORE key -inf ${now - interval}`

---

### 3. Token Bucket Rate Limiter

**What it is:** A bucket holds tokens up to `capacity`. Tokens refill at `refillRatePerSecond`. Each request consumes `cost` tokens. Allows bursts up to capacity while enforcing long-term rate.

**Use Cases:**
- API burst handling (allow spikes, limit average)
- Resource pooling (connections, CPU credits)
- When you need both burst allowance and sustained rate control

**Usage:**
```typescript
const limiter = createRateLimiter(client, {
  algorithm: 'token-bucket',
  limit: 100,              // Not used directly; capacity is the limit
  intervalMs: 60_000,      // Used for metadata only
  tokenBucket: {
    capacity: 100,              // Max tokens (burst allowance)
    refillRatePerSecond: 10,    // Tokens added per second
    initialTokens: 100,         // Start full (optional, defaults to capacity)
  },
});

const result = await limiter.consume('user:123', 5);
// If 5 tokens available: allowed=true, remaining=95
// If only 3 tokens: allowed=false, retryAfterMs=200 (2 tokens needed / 10 per sec)
```

**Advantages:**
- ✅ Natural burst handling - absorbs traffic spikes
- ✅ Smooth refill - no boundary artifacts
- ✅ Configurable refill rate independent of capacity

**Limitations:**
- ❌ **Refill is approximate**: Uses `elapsed * refillRatePerSec` at request time
- ❌ No "queue" - requests either get tokens or are denied immediately
- ❌ Clock drift handling: negative elapsed treated as 0

**Parameters:**
| Parameter | Description | Typical Value |
|-----------|-------------|---------------|
| `capacity` | Maximum tokens (burst size) | 100 |
| `refillRatePerSecond` | Tokens added per second | 10 |
| `initialTokens` | Starting tokens (default: capacity) | 100 |

---

### 4. Leaky Bucket Rate Limiter (Policing)

**What it is:** **Admission control only** - not a shaping queue. Tracks "water level" that leaks at `leakRatePerSecond`. Requests add water; if `water + cost > capacity`, request is denied.

**⚠️ Important:** This is a **policing** bucket (drop on overflow), NOT a **shaping** queue (delay until capacity). Denied requests return immediately with `retryAfterMs`.

**Use Cases:**
- Protecting downstream services from overload
- Smoothing traffic without buffering
- When you need strict admission control

**Usage:**
```typescript
const limiter = createRateLimiter(client, {
  algorithm: 'leaky-bucket',
  limit: 100,
  intervalMs: 60_000,
  leakyBucket: {
    capacity: 100,           // Max water level
    leakRatePerSecond: 10,   // Water drains per second
  },
});

const result = await limiter.consume('user:123', 1);
// If water + 1 <= capacity: allowed, water increases
// If water + 1 > capacity: denied, retryAfterMs = (water + 1 - capacity) / leakRatePerSec
```

**Advantages:**
- ✅ Smooths traffic at constant rate
- ✅ No memory growth - fixed hash with 3 fields
- ✅ Predictable latency - no queueing delays

**Limitations:**
- ❌ **Not a queue** - no request waiting/delay
- ❌ Burst requests are dropped, not delayed
- ❌ No FIFO ordering - purely admission decision

---

## Advanced Features

### 5. Multi-Dimensional Limiting

**What it is:** Compose multiple independent rate limiters that must ALL allow for a request to proceed. Each limiter can use different algorithms, limits, and key prefixes.

**Use Cases:**
- Per-user + global limits
- Per-tenant + per-route limits
- Per-IP + per-account limits
- Tiered limits (free tier vs paid tier)

**Usage:**
```typescript
import { createRateLimiter, createMultiRateLimiter } from '@oneunit/redis';

const userLimiter = createRateLimiter(client, {
  algorithm: 'fixed-window',
  limit: 10,
  intervalMs: 60_000,
  keyPrefix: 'user',
});

const globalLimiter = createRateLimiter(client, {
  algorithm: 'fixed-window',
  limit: 1000,
  intervalMs: 60_000,
  keyPrefix: 'global',
});

const multi = createMultiRateLimiter([userLimiter, globalLimiter]);

const result = await multi.consume('user:123', 1);
// result.allowed = true only if BOTH allow
// result.decisions = [userDecision, globalDecision]
// result.retryAfterMs = max of all retry-afters
```

**Advantages:**
- ✅ Composable - mix any algorithms
- ✅ Independent limits - each tracked separately
- ✅ Rich metadata - per-limiter decisions returned

**Limitations:**
- ❌ **Race window**: `check()` then `consume()` not atomic across limiters
- ❌ No atomic multi-key consume (Redis Cluster CROSSSLOT risk)
- ❌ If one limiter fails, partial consumption possible (fail-open behavior varies)

---

### 6. Weighted Rate Limiting

**What it is:** All algorithms support `cost` parameter (default: 1). Requests can consume variable capacity.

**Usage:**
```typescript
// All algorithms support weighted costs
await limiter.consume('user:123', 5);  // Consume 5 units

// Validation
await limiter.consume('user:123', 0);     // Throws: weight must be positive
await limiter.consume('user:123', -1);    // Throws
await limiter.consume('user:123', 1.5);   // OK: fractional allowed
await limiter.consume('user:123', 1e10);  // Denied: cost_exceeds_limit
```

**Validation Rules:**
- Must be finite positive number (> 0)
- NaN, Infinity, 0, negative rejected
- Fractional costs supported (1.5, 0.1, etc.)
- Cost > capacity/limit → immediate denial with `cost_exceeds_limit`

---

### 7. Distributed Concurrency Limiting

**What it is:** Semaphore-based concurrency control. Limits simultaneous operations across all instances. Uses Redis sorted sets for permit tracking with lease-based expiration.

**Use Cases:**
- Limit concurrent database connections
- Limit parallel API calls to downstream service
- Distributed mutex / critical section
- Thundering herd prevention

**Usage:**
```typescript
import { createConcurrencyLimiter } from '@oneunit/redis';

const limiter = createConcurrencyLimiter(client, {
  resource: 'db-pool',      // Resource name
  maxConcurrency: 10,       // Max simultaneous permits
  leaseMs: 30_000,          // Lease duration (auto-expires)
  timeoutMs: 5_000,         // Max wait for permit (optional)
  retryIntervalMs: 100,     // Poll interval (optional)
});

// Try to acquire immediately
const result = await limiter.tryAcquire('owner-1');
// { acquired: true, token: 'uuid', retryAfterMs: null }

// Or wait for permit (with timeout)
const result = await limiter.acquire('owner-1');
// Throws if timeout exceeded

// Use with automatic release
const result = await limiter.run(async () => {
  await db.query('...');
  return data;
}, 'owner-1');

// Manual release
await limiter.release(token);
```

**Advantages:**
- ✅ True distributed semaphore - works across instances
- ✅ Lease expiration - dead clients don't hold permits forever
- ✅ Fencing tokens - each acquire gets incrementing token
- ✅ Cancellation support via AbortSignal

**Limitations:**
- ❌ **No ownership validation on release**: Any valid token can release any permit (known issue)
- ❌ No priority queue - FIFO by acquisition time
- ❌ Two Redis keys (semaphore + fencing) - CROSSSLOT risk in Cluster

**Semaphore Internals:**
```
Keys: ratelimit:{resource}:semaphore (ZSET: token → expiry)
      ratelimit:{resource}:semaphore:fencing (STRING: counter)

Acquire: Clean expired → ZCARD < permits? → ZADD(token, expiry) → INCR fencing
Release: ZREM(token)
Renew:   ZSCORE(token) > now? → ZADD(token, new_expiry)
```

---

### 8. Daily & Monthly Quotas

**What it is:** Calendar-based quotas that reset at UTC midnight (daily) or 1st of month (monthly). Supports weighted consumption.

**Use Cases:**
- API daily/monthly quotas
- Billing period limits
- Resource allocation per calendar period

**Usage:**
```typescript
import { createQuota } from '@oneunit/redis';

// Daily quota (resets at UTC midnight)
const dailyQuota = createQuota(client, {
  resource: 'api',
  quota: 10_000,
  period: 'daily',
  weight: 1,           // Optional: weight per consume call
});

// Monthly quota (resets 1st of month UTC)
const monthlyQuota = createQuota(client, {
  resource: 'api',
  quota: 100_000,
  period: 'monthly',
});

// Custom period
const hourlyQuota = createQuota(client, {
  resource: 'api',
  quota: 1000,
  period: 'custom',
  customPeriodMs: 60 * 60 * 1000,  // 1 hour
});

const result = await dailyQuota.consume('user:123', 5);
// result: { allowed: true, used: 5, remaining: 9995, quota: 10000, resetAt: 1234567890000, ... }
```

**Advantages:**
- ✅ Calendar-aware (handles Feb/leap years, DST)
- ✅ UTC-based - consistent across timezones
- ✅ Atomic - single Redis key per resource/period
- ✅ TTL auto-expires old periods

**Limitations:**
- ❌ **Timezone not implemented**: `timezone` option accepted but ignored (UTC only)
- ❌ No partial period carryover
- ❌ Weight applies to `amount`, not per-request

---

### 9. Burst Protection

**What it is:** Combines three layers:
1. **Sustained limiter** (fixed-window) - long-term rate
2. **Burst limiter** (token-bucket) - short-term burst allowance
3. **Concurrency limiter** (optional) - simultaneous requests

**Use Cases:**
- API protection with burst allowance
- Multi-tier rate limiting
- Preventing cascade failures

**Usage:**
```typescript
import { createBurstProtector } from '@oneunit/redis';

const protector = createBurstProtector(client, {
  sustainedLimit: 100,        // Long-term: 100/min
  sustainedIntervalMs: 60_000,
  burstCapacity: 20,          // Short burst: 20 tokens
  burstIntervalMs: 10_000,    // Refill window
  burstRefillRatePerSecond: 5, // Refill rate
  concurrencyLimit: 5,        // Optional: max concurrent
  concurrencyLeaseMs: 30_000,
});

const result = await protector.consume('user:123', 1, true); // true = acquire concurrency
// result: { allowed, reason, retryAfterMs, metadata: { sustained, burst, concurrency }, concurrencyToken }

// Release concurrency token when done
if (result.concurrencyToken) {
  await protector.releaseConcurrency(result.concurrencyToken);
}
```

**Evaluation Order:**
1. Sustained limit checked first
2. Burst limit checked second
3. Concurrency checked last

**Advantages:**
- ✅ Multi-layer protection in one call
- ✅ Automatic concurrency token management
- ✅ Rich per-layer metadata

---

### 10. Retry-After & Metadata

**What it is:** Every decision includes rich metadata for client-side handling.

**Decision Fields:**
```typescript
interface RateLimitDecision {
  allowed: boolean;           // Request allowed?
  algorithm: string;          // 'fixed-window' | 'sliding-window' | 'token-bucket' | 'leaky-bucket'
  limit: number;              // Configured limit/capacity
  remaining: number;          // Available capacity after this request
  consumed: number;           // Cost consumed (0 if denied or check mode)
  retryAfterMs: number | null; // Milliseconds until retry likely succeeds
  resetAt: number | null;     // Absolute timestamp when limit resets (fixed/sliding)
  resetAfterMs: number | null; // Milliseconds until window reset
  reason: string | null;      // 'limited' | 'cost_exceeds_limit' | 'quota_exhausted' | 'concurrency_limit' | 'burst_limit' | 'sustained_limit'
  fallback: boolean;          // True if fail-open allowed request
  metadata?: Record<string, unknown>; // Algorithm-specific data
}
```

**Retry-After Accuracy:**
| Algorithm | Calculation |
|-----------|-------------|
| Fixed Window | `resetAt - now` |
| Sliding Window | `oldestRequestTimestamp + interval - now` |
| Token Bucket | `ceil(neededTokens / refillRatePerMs)` |
| Leaky Bucket | `ceil(neededCapacity / leakRatePerMs)` |
| Quota | `resetAt - now` |
| Concurrency | `null` (no time-based retry) |

**Usage:**
```typescript
const result = await limiter.consume('user:123', 1);

if (!result.allowed) {
  // Tell client when to retry
  const retryAfterSec = Math.ceil((result.retryAfterMs || 0) / 1000);
  res.set('Retry-After', retryAfterSec.toString());
  res.set('X-RateLimit-Limit', result.limit);
  res.set('X-RateLimit-Remaining', result.remaining);
  res.set('X-RateLimit-Reset', Math.ceil((result.resetAt || Date.now()) / 1000));
  return res.status(429).send('Too Many Requests');
}
```

---

### 11. Fail-Open & Fail-Closed Policies

**What it is:** Configurable behavior when Redis is unavailable.

**Usage:**
```typescript
// Fail-open: allow requests if Redis fails (graceful degradation)
const limiter = createRateLimiter(client, {
  algorithm: 'fixed-window',
  limit: 100,
  intervalMs: 60_000,
  failurePolicy: 'fail-open',
});

// Fail-closed: deny requests if Redis fails (strict protection)
const limiter = createRateLimiter(client, {
  algorithm: 'fixed-window',
  limit: 100,
  intervalMs: 60_000,
  failurePolicy: 'fail-closed',  // Default
});
```

**Behavior:**
| Policy | Redis Down | Decision | Fallback Field |
|--------|------------|----------|----------------|
| `fail-open` | Yes | Allowed | `fallback: true` |
| `fail-closed` | Yes | Throws error | N/A |
| (default) | Yes | Throws error | N/A |

**Fail-Open Response:**
```typescript
const result = await limiter.consume('user:123', 1);
// { allowed: true, fallback: true, metadata: { error: 'Connection is closed' }, ... }
```

**⚠️ Critical Limitation:** Fail-open catches **ALL** errors, including programming errors (Lua syntax errors, config bugs). Should only catch operational Redis failures.

---

## Local-Only Utilities

These utilities run in-process without Redis coordination. They are **NOT distributed** - each instance operates independently.

### 12. Adaptive Throttling (Local Only)

**What it is:** Dynamically adjusts a limit based on load signals (0-1). No Redis coordination.

```typescript
import { createAdaptiveThrottler } from '@oneunit/redis';

const throttler = createAdaptiveThrottler(100, {  // Base limit: 100
  minLimit: 10,
  maxLimit: 200,
  samplingIntervalMs: 1000,      // Min time between adjustments
  maxAdjustmentPerStep: 5,       // Max change per adjustment
  hysteresis: 0.1,               // Dead band around 0.5
  recoveryStep: 2,               // Increase rate during recovery
});

// Call periodically with load signal (0-1)
const currentLimit = throttler.sample(0.75);  // 75% load

// Load bands:
//   0.0 - 0.4+hysteresis: Recovery (increase)
//   0.4+hysteresis - 0.8: Stable (no change)
//   0.8 - 1.0: Overload (decrease)
```

**⚠️ Not Distributed:** Multiple instances will fight each other. No shared state.

---

### 13. Load Shedding (Local Only)

**What it is:** Admits or sheds requests based on in-flight count and priority.

```typescript
import { createLoadShedder } from '@oneunit/redis';

const shedder = createLoadShedder(10, 100);  // maxInFlight=10, queueThreshold=100 (unused)

const result = shedder.acquire(0);   // Priority 0 (low)
// { shed: false, reason: null, priority: 0, inFlight: 1 }

const result = shedder.acquire(10);  // Priority 10 (high)
// { shed: false, ... }

shedder.release();  // Decrement in-flight
```

**⚠️ Not Distributed:** Local in-flight counter only. `queueThreshold` option exists but is unused.

---

### 14. Backpressure (Local Only)

**What it is:** Admission control with optional waiting. No actual queue - just a counter with busy-wait.

```typescript
import { createBackpressureController } from '@oneunit/redis';

const bp = createBackpressureController(10, 1000);  // maxPending=10, maxWaitMs=1000

// Immediate admission if capacity
const result = await bp.admit(1);
// { admitted: true, waitMs: 0, pending: 1 }

// Wait if at capacity (requires waitFn)
const result = await bp.admit(1, async (ms) => {
  await new Promise(r => setTimeout(r, ms));
});
// { admitted: false, waitMs: 500, pending: 10 }

// Release when done
bp.release(1);
```

**⚠️ Limitations:**
- No AbortSignal/cancellation support
- Busy-wait loop (no exponential backoff)
- No actual queue ordering (FIFO not guaranteed)
- Not distributed - local counter only

---

## Operational Concerns

### Redis Cluster Support

| Component | Cluster Safe? | Notes |
|-----------|---------------|-------|
| Rate Limiters | ✅ Yes | Single key per resource |
| Quota | ✅ Yes | Single key per resource |
| Concurrency/Semaphore | ⚠️ Conditional | Two keys with same hash tag `{resource}` |
| Multi-Limiter | ⚠️ Conditional | Multiple keys - ensure same hash tag |

**Hash Tags:** Semaphore keys use `{resource}` hash tag:
```
ratelimit:{my-resource}:semaphore
ratelimit:{my-resource}:semaphore:fencing
```

**Recommendation:** Use `{resource}` prefix in keys for Cluster deployments.

---

### Key Management & Expiration

| Component | Key Pattern | TTL |
|-----------|-------------|-----|
| Fixed Window | `ratelimit:{prefix}:fixed-window:{resource}` | `intervalMs` |
| Sliding Window | `ratelimit:{prefix}:sliding-window:{resource}` | `intervalMs + 1s` |
| Token Bucket | `ratelimit:{prefix}:token-bucket:{resource}` | 24 hours |
| Leaky Bucket | `ratelimit:{prefix}:leaky-bucket:{resource}` | 24 hours |
| Quota | `ratelimit:{prefix}:quota:{resource}` | Period duration |
| Semaphore | `ratelimit:{resource}:semaphore` | `leaseMs + 1s` |
| Fencing | `ratelimit:{resource}:semaphore:fencing` | `leaseMs + 1s` |

**Cleanup:** All keys have TTL. Expired keys auto-removed by Redis.

---

### Failure Handling

**Fail-Closed (Default):**
- Throws `RateLimitError` on Redis failure
- Caller must handle (retry, circuit break, deny)

**Fail-Open:**
- Returns `allowed: true, fallback: true`
- Original error in `metadata.error`
- **Catches ALL errors** (including bugs) - use with caution

**Error Codes:**
```typescript
import { RateLimitError, RateLimitConfigError } from '@oneunit/redis';

try {
  await limiter.consume('user:123', 1);
} catch (e) {
  if (e instanceof RateLimitConfigError) {
    // Invalid configuration (e.g., limit <= 0)
  } else if (e instanceof RateLimitError) {
    // Operational error (Redis unavailable, timeout)
  }
}
```

---

## API Reference

### Main Exports

```typescript
// Core
import { 
  createClient,           // Redis client
  shutdown,               // Graceful client shutdown
  silentLogger,           // No-op logger
} from '@oneunit/redis';

// Rate Limiting
import {
  createRateLimiter,      // All 4 algorithms
  createMultiRateLimiter, // Compose multiple limiters
  createQuota,            // Daily/monthly/custom quotas
  createConcurrencyLimiter, // Distributed semaphore
  createBurstProtector,   // Multi-layer protection
} from '@oneunit/redis';

// Local Utilities
import {
  createAdaptiveThrottler,
  createLoadShedder,
  createBackpressureController,
} from '@oneunit/redis';

// Types
import type {
  RateLimitDecision,
  RateLimiterOptions,
  RateLimitAlgorithm,
  QuotaOptions,
  ConcurrencyLimiterOptions,
  BurstProtectionOptions,
} from '@oneunit/redis';

// Errors
import {
  RateLimitError,
  RateLimitConfigError,
  ConcurrencyAcquisitionError,
  BackpressureError,
} from '@oneunit/redis';
```

### Subpath Imports

```typescript
import {
  createRateLimiter,
  createMultiRateLimiter,
  createQuota,
  createConcurrencyLimiter,
  createBurstProtector,
} from '@oneunit/redis/rate-limit';
```

---

## Performance Characteristics

| Algorithm | Redis Ops | Memory/Key | Latency |
|-----------|-----------|------------|---------|
| Fixed Window | 1 (SET PX) | ~50 bytes | ~0.5ms |
| Sliding Window | 3 (ZREM + ZRANGE + ZADD) | O(requests in window) | ~1-2ms |
| Token Bucket | 3 (HGET + HSET + EXPIRE) | ~100 bytes | ~0.5ms |
| Leaky Bucket | 3 (HGET + HSET + EXPIRE) | ~100 bytes | ~0.5ms |
| Quota | 2 (GET + SET PX) | ~50 bytes | ~0.5ms |
| Concurrency | 4 (ZRANGE + ZREM + ZADD + ZCARD) | O(permits) | ~1ms |

---

## Testing & Verification

Run the test suite:
```bash
npm test              # Run test suite
npm run test:coverage # Run with coverage
npm run test:examples # Run examples smoke tests
npm run verify        # Full CI pipeline (build, typecheck, lint, test, pack)
```

**Test Coverage:**
- Unit tests for all algorithms
- Concurrency stress tests (1000 parallel requests)
- Race condition verification
- Lifecycle/shutdown tests
- Fail-open/fail-closed tests
- Redis Cluster key safety tests
- Public API consumer tests

---

## Migration & Compatibility

**Breaking Changes from v0.x:**
- `createRateLimiter` now requires `algorithm` field
- `tokenBucket` and `leakyBucket` config moved to nested objects
- `check()` mode no longer consumes capacity
- Error classes renamed (RateLimitError hierarchy)

**Version Policy:** Semantic versioning. Major version for breaking changes.

---

## Real-World Verification

All rate limiting algorithms have been tested against a production Redis Cloud instance:

**Target**: `redis-10952.crce194.ap-seast-1-1.ec2.cloud.redislabs.com:10952` (ap-southeast-1)
**Network RTT**: ~350-450ms

### Test Results (200+ tests)

| Algorithm / Feature | Tests | Status |
|---|---|---|
| Fixed Window | 24 | ✅ Pass |
| Sliding Window | 28 | ✅ Pass |
| Token Bucket | 29 | ✅ Pass |
| Leaky Bucket | 26 | ✅ Pass |
| Multi-Dimensional Limiting | 23 | ✅ Pass |
| Weighted Requests | 23 | ✅ Pass |
| Concurrency / Semaphore | 23 | ✅ Pass |
| Daily/Monthly Quotas | 25 | ✅ Pass |
| Burst Protection | 23 | ✅ Pass |
| Fail-Open/Fail-Closed | 17 | ✅ Pass |
| Adaptive Throttling (Local) | 27 | ✅ Pass |
| Load Shedding (Local) | 27 | ✅ Pass |
| Backpressure (Local) | 27 | ✅ Pass |
| Atomicity & Key Safety | 23 | ✅ Pass |
| Lifecycle / Shutdown | 20 | ✅ Pass |
| Stress / Concurrency | 23 | ✅ Pass |

### Verified Properties

- **Atomic Operations**: All algorithms use Lua scripts; verified under 1000 parallel requests
- **Distributed State**: Multiple application instances share limits correctly
- **Redis Cluster Safety**: Keys use hash tags `{resource}` for CROSSSLOT compatibility
- **Failure Handling**: Fail-open/fail-closed policies work as documented
- **Metadata Accuracy**: `retryAfterMs`, `resetAt`, `remaining` all accurate
- **TTL Management**: All keys auto-expire; no orphaned keys
- **Weighted Requests**: Fractional costs supported; validation rejects invalid weights

### Performance Baselines (Cloud Redis)

| Operation | Latency (p50) |
|---|---|
| Fixed Window `consume()` | 380ms |
| Sliding Window `consume()` | 380ms |
| Token Bucket `consume()` | 380ms |
| Leaky Bucket `consume()` | 380ms |
| Quota `consume()` | 380ms |
| Semaphore `acquire()` | 380ms |
| Multi-limiter `consume()` | 380ms |

> All operations include network RTT (~380ms). Local Redis would be <5ms.

### Run Tests Against Cloud Redis

```bash
export REDIS_URL="redis://default:<password>@redis-10952.crce194.ap-seast-1-1.ec2.cloud.redislabs.com:10952"
npm test
```

---

## License

MIT License - see LICENSE file for details.