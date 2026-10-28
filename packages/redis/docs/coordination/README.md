# Distributed Coordination (`@oneunit/redis/coordination`)

Distributed coordination primitives built on atomic Lua scripts with Redis server time (`TIME`) and hash-tag support for Cluster. Includes locks, semaphores, leases, leader election, single-flight, job claiming, fencing, barriers, and resource leases.

## Table of Contents

1. [Quick Start](#quick-start)
2. [createCoordinationClient](#createcoordinationclient)
3. [Locks](#locks)
4. [Semaphores](#semaphores)
5. [Leases](#leases)
6. [Leader Election](#leader-election)
7. [Single-Flight](#single-flight)
8. [Job Claims](#job-claims)
9. [Resource Leases](#resource-leases)
10. [Barriers](#barriers)
11. [Fencing](#fencing)
12. [Singleton Scheduler](#singleton-scheduler)
13. [Subpath Imports](#subpath-imports)
14. [API Reference](#api-reference)
15. [Operational Notes](#operational-notes)

---

## Quick Start

```typescript
import { createCoordinationClient } from '@oneunit/redis/coordination';

const coord = createCoordinationClient({ client: redis, keyPrefix: 'coord' });

// Distributed lock
const lock = await coord.acquireLock({ resource: 'my-resource', leaseMs: 30000 });
try {
  await doWork();
} finally {
  await coord.releaseLock({ resource: 'my-resource', token: lock.token });
}

// Distributed semaphore
const permit = await coord.acquireSemaphore({ resource: 'db-pool', permits: 10, leaseMs: 30000, ownerId: 'worker-1' });
try {
  await db.query();
} finally {
  await coord.releaseSemaphore({ resource: 'db-pool', token: permit.token });
}
```

---

## createCoordinationClient

Creates a coordination client wrapping a Redis client with all coordination primitives.

### Signature

```typescript
createCoordinationClient(config: CoordinationClientConfig): CoordinationClient;
```

### CoordinationClientConfig

| Field | Type | Description |
|-------|------|-------------|
| `client` | `Redis` | ioredis client (required) |
| `keyPrefix` | `string` | Key prefix (default: `'coord'`) |
| `defaultLeaseMs` | `number` | Default lock/lease duration (default: `30000` ms) |
| `defaultTimeoutMs` | `number` | Default acquire timeout (default: `10000` ms) |
| `defaultRetryIntervalMs` | `number` | Default retry interval (default: `100` ms) |
| `logger` | `Logger` | Optional logger |

```typescript
const coord = createCoordinationClient({
  client: redis,
  keyPrefix: 'myapp:coord',
  defaultLeaseMs: 30_000,
  defaultTimeoutMs: 10_000,
  logger,
});
```

---

## Locks

Distributed mutex with fencing tokens, TTL, renewal, and safe release.

```typescript
// Acquire a lock
const result = await coord.acquireLock({
  resource: 'my-resource',
  leaseMs: 30_000,
  ownerId: 'unique-owner-id',  // optional, auto-generated if omitted
});

// result: { acquired: true, token: '...', fencingToken: 1, ttlMs: ... }

// Or with try-lock (non-blocking)
const result = await coord.tryLock({ resource: 'my-resource', leaseMs: 30_000 });

// Renew a lock
await coord.renewLock({ resource: 'my-resource', token: '...', leaseMs: 30_000 });

// Release a lock
await coord.releaseLock({ resource: 'my-resource', token: '...' });

// withLock — acquire, run, release automatically
const result = await coord.withLock(
  { resource: 'my-resource', leaseMs: 30_000 },
  async () => { await doWork(); return 'done'; }
);

// Check lock status
const status = await coord.getLockStatus('my-resource');
```

### Operations

| Operation | Description |
|-----------|-------------|
| `acquireLock` | Blocking lock acquire with optional timeout |
| `tryLock` | Non-blocking lock acquire |
| `renewLock` | Extend lock TTL |
| `releaseLock` | Release lock with fencing token validation |
| `withLock` | Acquire → run → release in one call |
| `getLockStatus` | Check current lock holder and TTL |

---

## Semaphores

Counting permits with lease-based expiration for distributed concurrency control.

```typescript
// Acquire a permit
const result = await coord.acquireSemaphore({
  resource: 'db-pool',
  permits: 10,
  leaseMs: 30_000,
  ownerId: 'worker-1',
});

// result: { acquired: true, token: '...', fencingToken: 1, ttlMs: ... }

// Renew a permit
await coord.renewSemaphore({ resource: 'db-pool', token: result.token!, leaseMs: 30_000 });

// Release a permit
await coord.releaseSemaphore({ resource: 'db-pool', token: result.token! });

// Try acquire (non-blocking)
const result = await coord.tryAcquireSemaphore({ resource: 'db-pool', permits: 10, leaseMs: 30_000, ownerId: 'worker-1' });

// Check status
const status = await coord.getSemaphoreStatus('db-pool', 10);
// { totalPermits: 10, availablePermits: 9, holders: [{ token: '...', expiresAt: ... }] }
```

### Operations

| Operation | Description |
|-----------|-------------|
| `acquireSemaphore` | Acquire a permit (waits if none available) |
| `tryAcquireSemaphore` | Non-blocking permit acquire |
| `renewSemaphore` | Extend permit lease |
| `releaseSemaphore` | Release a permit |
| `getSemaphoreStatus` | Check permit availability and active holders |

---

## Leases

Time-bound ownership with epoch fencing for arbitrary resources.

```typescript
// Acquire a lease
const result = await coord.acquireLease({
  resource: 'my-resource',
  leaseMs: 60_000,
  holderId: 'worker-1',
});

// Renew a lease
await coord.renewLease({ resource: 'my-resource', token: result.token!, leaseMs: 60_000 });

// Release a lease
await coord.releaseLease({ resource: 'my-resource', token: result.token! });

// Check status
const status = await coord.getLeaseStatus('my-resource');
```

---

## Leader Election

Term-based leader acquisition and loss with fencing and event emitter.

```typescript
import { createCoordinationClient } from '@oneunit/redis/coordination';

const coord = createCoordinationClient({ client: redis });

const election = coord.createLeaderElection({
  resource: 'my-service',
  candidateId: 'instance-1',
  leaseMs: 30_000,
  onEvent: (event) => {
    if (event.type === 'leader-acquired') {
      console.log('I am the leader for term:', event.term);
    } else if (event.type === 'leader-lost') {
      console.log('I lost leadership');
    }
  },
});

await election.start();
// election.isLeader() returns boolean
// election.status() returns { isLeader, leaderId, leaseExpiresAt, term }
await election.stop();
```

---

## Single-Flight

Deduplicate concurrent same-key execution — only one caller runs the function, others wait for the result.

```typescript
const result = await coord.singleFlight({
  key: 'user:123:profile',
  leaseMs: 5000,
  execute: async () => {
    return await fetchProfile(123);
  },
  timeoutMs: 5000,
});

// result: { value: profile, isOwner: true, fencingToken: 1 }
// Concurrent callers with the same key get the same result
// without executing the function multiple times.
```

---

## Job Claims

At-least-once job claim/complete/release lifecycle.

```typescript
// Claim a job
const claim = await coord.claimJob({
  jobId: 'job-123',
  leaseMs: 60_000,
  claimantId: 'worker-1',
});

// Renew the claim while processing
await coord.renewJobClaim({ jobId: 'job-123', token: claim.token!, leaseMs: 60_000 });

// Complete the job
await coord.completeJobClaim({ jobId: 'job-123', token: claim.token!, result: { processed: true } });

// Or fail it
await coord.failJobClaim({ jobId: 'job-123', token: claim.token!, error: 'processing failed' });

// Or release it back
await coord.releaseJobClaim({ jobId: 'job-123', token: claim.token! });

// Check status
const status = await coord.getJobClaimStatus('job-123');
```

---

## Resource Leases

Lease wrapper over arbitrary resources with ownership validation.

```typescript
const result = await coord.acquireLease({
  resource: 'database-connection-1',
  leaseMs: 30_000,
  holderId: 'worker-1',
});

try {
  await useResource(result.resource ?? 'database-connection-1');
} finally {
  await coord.releaseLease({
    resource: 'database-connection-1',
    token: result.token!,
  });
}
```

---

## Barriers

Arrive-and-wait synchronization for distributed barriers.

```typescript
// Arrive at a barrier
const result = await coord.arriveBarrier({
  barrierId: 'batch-job-1',
  participantId: 'worker-1',
  requiredCount: 5,
  timeoutMs: 30_000,
});

// When all participants arrive, result.released is true
// Check barrier status
const status = await coord.getBarrierStatus('batch-job-1', 1);
```

---

## Fencing

Validate, compare, and bump fencing tokens for safe resource access (standalone functions exported from `@oneunit/redis/coordination`):

```typescript
import {
  validateFencingToken,
  compareFencingTokens,
  isStaleFencingToken,
  nextFencingToken,
} from '@oneunit/redis/coordination';

// Compare tokens
const diff = compareFencingTokens(tokenA, tokenB);

// Check if token is stale
if (isStaleFencingToken(highestSeen, token)) {
  throw new Error('Stale fencing token');
}

// Validate token (throws if provided < expected)
validateFencingToken(expectedToken, providedToken, 'my-resource');

// Compute next safe fencing token with overflow guard
const next = nextFencingToken(currentToken);
```

---

## Singleton Scheduler

One-owner periodic task scheduling across distributed nodes built on leader election:

```typescript
import {
  createSingletonSchedulerFromClient,
  createSingletonScheduler,
} from '@oneunit/redis/coordination';

// Create from existing coordination client
const scheduler = createSingletonSchedulerFromClient(coord, {
  resource: 'periodic-task',
  candidateId: 'instance-1',
  leaseMs: 30_000,
  intervalMs: 60_000,
  task: async () => {
    await runPeriodicTask();
  },
  onLeadershipChange: (isLeader) => {
    console.log(`Leadership changed: ${isLeader}`);
  },
});

await scheduler.start();
// Only the elected leader runs task every intervalMs
// scheduler.isLeader() returns boolean
await scheduler.stop();
```

---

## Subpath Imports

```typescript
import { createCoordinationClient } from '@oneunit/redis/coordination';
```

Also available from the package root:

```typescript
import { createCoordinationClient } from '@oneunit/redis';
```

---

## API Reference

```typescript
import {
  createCoordinationClient,
  createSingletonScheduler,
  createSingletonSchedulerFromClient,
  SingletonScheduler,
  LeaderElectionCoordinator,
  validateFencingToken,
  compareFencingTokens,
  isStaleFencingToken,
  nextFencingToken,
  createLockManager,
  createSemaphoreManager,
  createSingleFlightManager,
  createJobClaimManager,
  createResourceLeaseManager,
  createBarrierCoordinator,
} from '@oneunit/redis/coordination';

import type {
  CoordinationClient,
  CoordinationClientConfig,
  LockAcquireOptions,
  LockTryOptions,
  LockRenewOptions,
  LockReleaseOptions,
  LockStatus,
  WithLockResult,
  SemaphoreAcquireOptions,
  SemaphoreTryOptions,
  SemaphoreRenewOptions,
  SemaphoreReleaseOptions,
  SemaphoreStatus,
  SingleFlightOptions,
  SingleFlightResult,
  LeaderElectionOptions,
  LeaderElectionStatus,
  LeaderElectionEvent,
  JobClaimOptions,
  JobCompleteOptions,
  JobReleaseOptions,
  JobClaimStatus,
  LeaseAcquireOptions,
  LeaseRenewOptions,
  LeaseReleaseOptions,
  LeaseStatus,
  BarrierArrivalOptions,
  BarrierArrivalResult,
  BarrierStatus,
  SingletonSchedulerOptions,
} from '@oneunit/redis/coordination';

// Method signatures on CoordinationClient instance (coord)
coord.acquireLock(opts: LockAcquireOptions)
coord.tryLock(opts: LockTryOptions)
coord.renewLock(opts: LockRenewOptions)
coord.releaseLock(opts: LockReleaseOptions)
coord.withLock(opts: LockAcquireOptions, fn: (handle: any) => Promise<T>)
coord.getLockStatus(resource: string)

// Semaphores
coord.acquireSemaphore(opts: SemaphoreAcquireOptions)
coord.tryAcquireSemaphore(opts: SemaphoreTryOptions)
coord.renewSemaphore(opts: SemaphoreRenewOptions)
coord.releaseSemaphore(opts: SemaphoreReleaseOptions)
coord.getSemaphoreStatus(resource: string, permits: number)

// Single flight
coord.singleFlight<T>(opts: SingleFlightOptions<T>)

// Leader election
coord.createLeaderElection(opts: LeaderElectionOptions): LeaderElectionCoordinator

// Job claims
coord.claimJob(opts: JobClaimOptions)
coord.renewJobClaim(opts: { jobId: string; token: string; leaseMs: number })
coord.releaseJobClaim(opts: JobReleaseOptions)
coord.completeJobClaim(opts: JobCompleteOptions)
coord.failJobClaim(opts: { jobId: string; token: string; error?: string })
coord.getJobClaimStatus(jobId: string)

// Resource leases
coord.acquireLease(opts: LeaseAcquireOptions)
coord.renewLease(opts: LeaseRenewOptions)
coord.releaseLease(opts: LeaseReleaseOptions)
coord.getLeaseStatus(resource: string)

// Barriers
coord.arriveBarrier(opts: BarrierArrivalOptions)
coord.getBarrierStatus(barrierId: string, generation: number)
```

---

## Operational Notes

| Concern | Behavior |
|---------|----------|
| Atomic Lua scripts | All primitives use Lua scripts for race-free operations |
| Redis server time | Uses `TIME` for clock-aware leases and TTLs |
| Hash tags | Keys use `{resource}` hash tags for Cluster compatibility |
| Fencing tokens | Incrementing tokens prevent stale lock/semaphore releases |
| Lease expiration | Dead clients don't hold permits/locks forever |
| Single-flight | Dedupe concurrent same-key execution in-process |
| Leader election | Term-based with automatic fencing on loss |
