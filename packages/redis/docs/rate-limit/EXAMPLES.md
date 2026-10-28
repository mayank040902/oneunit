# Rate Limiting Examples

This guide provides practical, real-world examples for using `@oneunit/redis/rate-limit`.

## Prerequisites

```bash
npm install @oneunit/redis
```

Requires Node.js 20+ and a Redis server.

---

## Basic Setup

```typescript
import { createClient, shutdown } from "@oneunit/redis";
import {
  createRateLimiter,
  createQuota,
  createConcurrencyLimiter,
  createBurstProtector,
  createMultiRateLimiter,
} from "@oneunit/redis/rate-limit";

const redis = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });

// Graceful shutdown
process.on("SIGTERM", async () => {
  await shutdown(redis);
  process.exit(0);
});
```

---

## Example 1: API Rate Limiting (Fixed Window)

Simple per-user rate limit with reset at fixed intervals.

```typescript
import { createRateLimiter } from "@oneunit/redis/rate-limit";

// 100 requests per minute per user
const apiLimiter = createRateLimiter(redis, {
  algorithm: "fixed-window",
  limit: 100,
  intervalMs: 60_000,           // 1 minute windows
  keyPrefix: "api",             // Keys: ratelimit:api:fixed-window:{user}
  failurePolicy: "fail-closed", // Default: deny on Redis failure
});

async function handleRequest(userId: string) {
  const result = await apiLimiter.consume(userId, 1);

  if (!result.allowed) {
    // Return 429 with standard headers
    throw new RateLimitExceededError(result);
  }

  // Request allowed - proceed
  return doWork();
}

class RateLimitExceededError extends Error {
  constructor(public readonly decision: RateLimitDecision) {
    super("Rate limit exceeded");
    this.name = "RateLimitExceededError";
  }
}
```

**Express/Koa Middleware:**
```typescript
import { RateLimitDecision } from "@oneunit/redis/rate-limit";

function rateLimitMiddleware(limiter: ReturnType<typeof createRateLimiter>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?.id || req.ip || "anonymous";
    const result = await limiter.consume(userId, 1);

    // Standard rate limit headers
    res.set({
      "X-RateLimit-Limit": result.limit.toString(),
      "X-RateLimit-Remaining": result.remaining.toString(),
      "X-RateLimit-Reset": Math.ceil((result.resetAt || Date.now()) / 1000).toString(),
    });

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.retryAfterMs || 0) / 1000);
      res.set("Retry-After", retryAfter.toString());
      return res.status(429).json({
        error: "Too Many Requests",
        retryAfter,
        reason: result.reason,
      });
    }

    next();
  };
}

app.use("/api/", rateLimitMiddleware(apiLimiter));
```

---

## Example 2: Smooth Rate Limiting (Sliding Window)

No boundary bursts - exact sliding window.

```typescript
import { createRateLimiter } from "@oneunit/redis/rate-limit";

// 100 requests per rolling 60 seconds
const slidingLimiter = createRateLimiter(redis, {
  algorithm: "sliding-window",
  limit: 100,
  intervalMs: 60_000,
});

// Usage same as fixed window
const result = await slidingLimiter.consume("user:123", 1);
```

**When to use:**
- Payment APIs where burst at window boundary is unacceptable
- Smooth traffic shaping for downstream services
- When you need exact request-level precision

---

## Example 3: Burst Handling (Token Bucket)

Allow bursts up to capacity while enforcing sustained rate.

```typescript
import { createRateLimiter } from "@oneunit/redis/rate-limit";

// 1000 capacity, refills at 50/second = 3000/min sustained
const tokenBucket = createRateLimiter(redis, {
  algorithm: "token-bucket",
  limit: 1000,              // Capacity (burst allowance)
  intervalMs: 60_000,       // Metadata only
  tokenBucket: {
    capacity: 1000,
    refillRatePerSecond: 50,    // 50 tokens/second = 3000/min sustained
    initialTokens: 1000,        // Start full
  },
});

async function handleBurstyRequest(userId: string) {
  const result = await tokenBucket.consume(userId, 1);

  if (!result.allowed) {
    // Client should wait retryAfterMs before retrying
    await delay(result.retryAfterMs!);
    return handleBurstyRequest(userId); // Retry
  }

  return doWork();
}
```

**Configuration Guide:**
| Use Case | Capacity | Refill Rate |
|----------|----------|-------------|
| API with occasional spikes | 1000 | 50/sec |
| WebSocket message rate | 100 | 10/sec |
| Background job queue | 50 | 1/sec |
| Strict rate, no burst | 100 | 100/sec (capacity = rate) |

---

## Example 4: Admission Control (Leaky Bucket)

**Policing only** - drops excess, no queueing.

```typescript
import { createRateLimiter } from "@oneunit/redis/rate-limit";

const leakyBucket = createRateLimiter(redis, {
  algorithm: "leaky-bucket",
  limit: 100,
  intervalMs: 60_000,
  leakyBucket: {
    capacity: 100,
    leakRatePerSecond: 10,    // Drains at 10/second
  },
});

// Usage
const result = await leakyBucket.consume("user:123", 1);
// If allowed: water level increases
// If denied: returns retryAfterMs = (water + cost - capacity) / leakRate
```

**⚠️ Important:** This is **admission control**, not a shaping queue. Denied requests return immediately - they are NOT queued or delayed.

---

## Example 5: Multi-Dimensional Limits

Compose multiple independent limits (all must allow).

```typescript
import { createRateLimiter, createMultiRateLimiter } from "@oneunit/redis/rate-limit";

const userLimiter = createRateLimiter(redis, {
  algorithm: "fixed-window",
  limit: 10,
  intervalMs: 60_000,
  keyPrefix: "user",
});

const globalLimiter = createRateLimiter(redis, {
  algorithm: "fixed-window",
  limit: 1000,
  intervalMs: 60_000,
  keyPrefix: "global",
});

const ipLimiter = createRateLimiter(redis, {
  algorithm: "fixed-window",
  limit: 50,
  intervalMs: 60_000,
  keyPrefix: "ip",
});

const multiLimiter = createMultiRateLimiter([userLimiter, globalLimiter, ipLimiter]);

async function handleRequest(req: Request) {
  const userId = req.user!.id;
  const ip = req.ip!;

  // Check all limits first
  const check = await multiLimiter.check(`${userId}:${ip}`, 1);
  if (!check.allowed) {
    // Find which limiter denied
    const denied = check.decisions.find(d => !d.allowed)!;
    throw new RateLimitExceededError(denied);
  }

  // Consume from all
  const result = await multiLimiter.consume(`${userId}:${ip}`, 1);
  // result.decisions contains per-limiter decisions
}
```

---

## Example 6: Daily/Monthly Quotas

Calendar-based quotas with UTC reset.

```typescript
import { createQuota } from "@oneunit/redis/rate-limit";

// Daily quota (resets at UTC midnight)
const dailyQuota = createQuota(redis, {
  resource: "api",
  quota: 10_000,
  period: "daily",
  weight: 1,  // Each consume() call adds weight * amount
});

// Monthly quota (resets 1st of month UTC)
const monthlyQuota = createQuota(redis, {
  resource: "api",
  quota: 100_000,
  period: "monthly",
});

// Custom period (hourly)
const hourlyQuota = createQuota(redis, {
  resource: "api",
  quota: 1000,
  period: "custom",
  customPeriodMs: 60 * 60 * 1000,
});

async function handleRequest(userId: string) {
  // Check daily first (usually stricter)
  const daily = await dailyQuota.consume(userId, 1);
  if (!daily.allowed) {
    throw new QuotaExceededError(daily);
  }

  // Check monthly
  const monthly = await monthlyQuota.consume(userId, 1);
  if (!monthly.allowed) {
    throw new QuotaExceededError(monthly);
  }

  return doWork();
}

class QuotaExceededError extends Error {
  constructor(public readonly decision: import("@oneunit/redis/rate-limit").QuotaDecision) {
    super("Quota exceeded");
    this.name = "QuotaExceededError";
  }
}
```

---

## Example 7: Distributed Concurrency Control

Limit simultaneous operations across all instances.

```typescript
import { createConcurrencyLimiter } from "@oneunit/redis/rate-limit";

const dbPool = createConcurrencyLimiter(redis, {
  resource: "postgres-pool",
  maxConcurrency: 20,      // Max 20 simultaneous
  leaseMs: 30_000,         // Lease expires in 30s
  timeoutMs: 5_000,        // Wait max 5s for permit
  retryIntervalMs: 100,    // Poll every 100ms
});

async function runQuery<T>(query: string): Promise<T> {
  // Automatic acquire + release
  return dbPool.run(async () => {
    return db.query(query);
  }, "query-worker");
}

// Or manual control
async function runWithManualPermit<T>(fn: () => Promise<T>): Promise<T> {
  const permit = await dbPool.acquire("manual-worker");
  try {
    return await fn();
  } finally {
    await dbPool.release(permit.token!);
  }
}

// Cancellation support
async function runWithTimeout<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return dbPool.acquire("timeout-worker", { signal }).then(permit => {
    return fn().finally(() => dbPool.release(permit.token!));
  });
}
```

---

## Example 8: Burst Protection (Multi-Layer)

Three layers: sustained + burst + concurrency.

```typescript
import { createBurstProtector } from "@oneunit/redis/rate-limit";

const protector = createBurstProtector(redis, {
  // Sustained: 100 req/min long-term
  sustainedLimit: 100,
  sustainedIntervalMs: 60_000,

  // Burst: 20 tokens, refills at 5/sec
  burstCapacity: 20,
  burstIntervalMs: 10_000,
  burstRefillRatePerSecond: 5,

  // Optional concurrency: max 5 simultaneous
  concurrencyLimit: 5,
  concurrencyLeaseMs: 30_000,
});

async function handleRequest(userId: string) {
  const result = await protector.consume(userId, 1, true); // true = acquire concurrency

  if (!result.allowed) {
    throw new RateLimitExceededError(result);
  }

  try {
    return await doWork();
  } finally {
    // Release concurrency token when done
    if (result.concurrencyToken) {
      await protector.releaseConcurrency(result.concurrencyToken);
    }
  }
}
```

**Evaluation Order:**
1. Sustained limit checked first
2. Burst limit checked second
3. Concurrency checked last

---

## Example 9: Weighted Requests

Different costs for different operations.

```typescript
const limiter = createRateLimiter(redis, {
  algorithm: "fixed-window",
  limit: 100,
  intervalMs: 60_000,
});

// Read = 1 unit
await limiter.consume("user:123", 1);

// Write = 5 units
await limiter.consume("user:123", 5);

// Expensive operation = 10 units
const result = await limiter.consume("user:123", 10);
if (!result.allowed) {
  // result.retryAfterMs tells when enough capacity returns
  console.log(`Wait ${result.retryAfterMs}ms`);
}

// Validation
await limiter.consume("user:123", 0);    // Throws: weight must be positive
await limiter.consume("user:123", -1);   // Throws
await limiter.consume("user:123", 1.5);  // OK: fractional
await limiter.consume("user:123", 1e10); // Denied: cost_exceeds_limit
```

---

## Example 10: Fail-Open (Graceful Degradation)

Allow requests when Redis is down.

```typescript
import { createRateLimiter } from "@oneunit/redis/rate-limit";

// Fail-open: allow on Redis failure
const analyticsLimiter = createRateLimiter(redis, {
  algorithm: "fixed-window",
  limit: 1000,
  intervalMs: 60_000,
  failurePolicy: "fail-open",
});

async function trackEvent(userId: string, event: string) {
  const result = await analyticsLimiter.consume(userId, 1);

  if (result.fallback) {
    console.warn("Rate limiter in fallback mode:", result.metadata?.error);
    // Request allowed but not counted
  }

  // Track event anyway (best effort)
  return trackAnalytics(event);
}
```

**Fail-Closed (Default - Strict Protection):**
```typescript
const paymentLimiter = createRateLimiter(redis, {
  algorithm: "fixed-window",
  limit: 10,
  intervalMs: 60_000,
  failurePolicy: "fail-closed", // Default
});

async function processPayment(userId: string) {
  try {
    const result = await paymentLimiter.consume(userId, 1);
    return chargeCard();
  } catch (e) {
    if (e instanceof RateLimitError) {
      // Redis unavailable - deny payment
      throw new PaymentError("Rate limit service unavailable");
    }
    throw e;
  }
}
```

---

## Example 11: Express/Koa Complete Middleware

```typescript
import { createClient, shutdown } from "@oneunit/redis";
import {
  createRateLimiter,
  createQuota,
  createMultiRateLimiter,
} from "@oneunit/redis/rate-limit";

const redis = createClient({ url: process.env.REDIS_URL });

// User tier limits
const tierLimits = {
  free: { requests: 100, windowMs: 60_000 },
  pro: { requests: 1000, windowMs: 60_000 },
  enterprise: { requests: 10000, windowMs: 60_000 },
};

// Create limiter factory
function createTierLimiter(tier: keyof typeof tierLimits) {
  const { requests, windowMs } = tierLimits[tier];
  return createRateLimiter(redis, {
    algorithm: "sliding-window",
    limit: requests,
    intervalMs: windowMs,
    keyPrefix: `tier:${tier}`,
  });
}

// Daily quota for all tiers
const dailyQuota = createQuota(redis, {
  resource: "api",
  quota: 50000,
  period: "daily",
});

// Middleware
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const tier = req.user?.tier || "free";
  const limiter = createTierLimiter(tier);
  const userId = req.user!.id;

  // Check quota first
  const quotaCheck = await dailyQuota.check(userId, 1);
  if (!quotaCheck.allowed) {
    return res.status(429).json({ error: "Daily quota exceeded" });
  }

  // Then rate limit
  const result = await limiter.consume(userId, 1);

  res.set({
    "X-RateLimit-Limit": result.limit.toString(),
    "X-RateLimit-Remaining": result.remaining.toString(),
    "X-RateLimit-Reset": Math.ceil((result.resetAt || Date.now()) / 1000).toString(),
  });

  if (!result.allowed) {
    const retryAfter = Math.ceil((result.retryAfterMs || 0) / 1000);
    res.set("Retry-After", retryAfter.toString());
    return res.status(429).json({
      error: "Too Many Requests",
      retryAfter,
      tier,
    });
  }

  next();
}

app.use("/api/", rateLimitMiddleware);
```

---

## Example 12: WebSocket Message Rate Limiting

```typescript
import { createRateLimiter } from "@oneunit/redis/rate-limit";

const wsLimiter = createRateLimiter(redis, {
  algorithm: "token-bucket",
  limit: 50,
  intervalMs: 60_000,
  tokenBucket: {
    capacity: 50,
    refillRatePerSecond: 5,  // 5 messages/sec sustained
    initialTokens: 50,
  },
  failurePolicy: "fail-open", // Don't block WS on Redis issues
});

wsServer.on("connection", (ws, req) => {
  const userId = req.user!.id;

  ws.on("message", async (data) => {
    const result = await wsLimiter.consume(`ws:${userId}`, 1);

    if (!result.allowed) {
      ws.send(JSON.stringify({
        type: "rate_limited",
        retryAfterMs: result.retryAfterMs,
      }));
      return;
    }

    // Process message
    handleMessage(ws, data);
  });
});
```

---

## Example 13: Background Job Rate Limiting

```typescript
import { createRateLimiter, createConcurrencyLimiter } from "@oneunit/redis/rate-limit";

const jobRateLimiter = createRateLimiter(redis, {
  algorithm: "fixed-window",
  limit: 100,
  intervalMs: 60_000,
});

const jobConcurrency = createConcurrencyLimiter(redis, {
  resource: "job-processor",
  maxConcurrency: 10,
  leaseMs: 300_000, // 5 min lease for long jobs
});

// In BullMQ worker
const worker = createWorker({
  name: "jobs",
  connection: redis,
  concurrency: 10,
  processor: async (job) => {
    // Rate limit per job type
    const rateResult = await jobRateLimiter.consume(`job:${job.name}`, 1);
    if (!rateResult.allowed) {
      throw new RateLimitError("Job rate limited", { retryAfter: rateResult.retryAfterMs });
    }

    // Concurrency limit for resource-intensive jobs
    return jobConcurrency.run(async () => {
      return processJob(job.data);
    }, `job-${job.id}`);
  },
});
```

---

## Example 14: Testing Helpers

```typescript
import { createClient, createRateLimiter, shutdown } from "@oneunit/redis";

async function createTestLimiter() {
  const redis = createClient({ url: "redis://localhost:6379/15" }); // Test DB
  await redis.flushdb();

  const limiter = createRateLimiter(redis, {
    algorithm: "fixed-window",
    limit: 10,
    intervalMs: 60_000,
  });

  return {
    limiter,
    cleanup: async () => {
      await redis.flushdb();
      await shutdown(redis);
    },
  };
}

// Test
test("rate limiter allows up to limit", async () => {
  const { limiter, cleanup } = await createTestLimiter();

  for (let i = 0; i < 10; i++) {
    const result = await limiter.consume("test", 1);
    expect(result.allowed).toBe(true);
  }

  const denied = await limiter.consume("test", 1);
  expect(denied.allowed).toBe(false);

  await cleanup();
});
```

---

## Error Handling Reference

```typescript
import {
  RateLimitError,
  RateLimitConfigError,
  ConcurrencyAcquisitionError,
  BackpressureError,
} from "@oneunit/redis/rate-limit";

try {
  await limiter.consume("user:123", 1);
} catch (e) {
  if (e instanceof RateLimitConfigError) {
    // Invalid config (e.g., limit <= 0)
  } else if (e instanceof RateLimitError) {
    // Operational error (Redis unavailable, timeout)
  } else if (e instanceof ConcurrencyAcquisitionError) {
    // Timeout waiting for permit
  } else if (e instanceof BackpressureError) {
    // Backpressure timeout
  }
}
```

---

## Performance Tips

1. **Use `check()` for read-heavy paths** - doesn't consume capacity
2. **Batch similar operations** - single `consume()` with weight > 1
3. **Reuse limiters** - don't create new instances per request
4. **Use appropriate algorithm** - fixed-window for simple cases, sliding for precision
5. **Monitor Redis latency** - health check your Redis instance

```typescript
// ❌ Bad: creates new limiter per request
app.use(async (req, res, next) => {
  const limiter = createRateLimiter(redis, { ... });
  await limiter.consume(req.user.id, 1);
});

// ✅ Good: singleton limiter
const limiter = createRateLimiter(redis, { ... });
app.use(async (req, res, next) => {
  await limiter.consume(req.user.id, 1);
});
```

---

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Creating limiter per request | Create once at startup, reuse |
| Using `check()` then `consume()` expecting atomicity | Known race window - use single `consume()` |
| Expecting leaky bucket to queue | It's policing only - use concurrency limiter for queueing |
| Forgetting to release concurrency token | Use `limiter.run()` for automatic release |
| Using fail-open for critical paths | Use fail-closed for payments/auth |
| Ignoring `retryAfterMs` in client | Implement exponential backoff with jitter |