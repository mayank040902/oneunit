# Redis Resilience Engine

Detailed reference for the `@oneunit/redis` resilience feature.

## 1. What it is

The **Resilience Engine** is an optional, in-process layer that wraps an
existing `ioredis` client. During a Redis outage it keeps eligible
application operations available by:

- running Redis commands directly while Redis is healthy;
- serving eligible reads from a **process-local data store** when Redis is
  unavailable (`HIT` / `MISS` / `UNKNOWN`);
- applying eligible writes locally and **journaling** them in a bounded
  in-memory operation store for later reconciliation;
- rejecting commands that cannot be safely reproduced (counters, arbitrary
  commands, etc.);
- replaying the journaled writes automatically (or manually) once Redis is
  reachable again, preserving per-key ordering, TTL deadlines, retries, and
  conflict checks.

The native `ioredis` client remains fully available. The engine does **not**
take ownership of the client and does not close it on `shutdown()`.

The engine is **process-local** only: no shared state, no cross-process or
cross-instance coordination, and no durability across process crashes.


## 1.1 Recommended transparent API

For normal application code, configure resilience inside `createClient` and then use ordinary
Redis commands directly on the returned client. Outage detection, fallback, and recovery happen automatically:

```ts
import { createClient } from "@oneunit/redis";

export const cache = createClient({
  url: process.env.REDIS_URL,
  resilience: {
    fallback: { enabled: true, strategy: "memory" },
    recovery: { enabled: true },
  },
});

await cache.set("user:123", JSON.stringify(user));
const value = await cache.get("user:123");
await cache.hset("session:123", "status", "active");

await cache.shutdown();
```

Alternatively, `createResilientRedis` is available for wrapping an existing `ioredis` client:

```ts
import Redis from "ioredis";
import { createResilientRedis } from "@oneunit/redis";

const redis = new Redis(process.env.REDIS_URL);
const resilient = createResilientRedis(redis, {
  fallback: { enabled: true, strategy: "memory" },
  recovery: { enabled: true },
});
```

The resilience engine remains available on `cache.engine` for diagnostics. Manual `engine.execute()`
or `engine.recover()` are not required for normal use.

## 2. Module layout

| Module | Responsibility |
|---|---|
| `ConnectionManager` | Tracks ioredis lifecycle (`connected` / `degraded` / `recovering` / `stopped`), emits degraded/reconnected events. |
| `OperationStore` | Bounded journal of pending operations awaiting recovery. Enforces count, total bytes, and per-operation byte limits. |
| `LocalStore` | Bounded degraded-mode read model. Stores values, tombstones, versions, and TTLs for read-your-writes. |
| `RecoveryCoordinator` | Single-worker replay of journaled operations with per-key ordering, batching, retries, backoff, expiration, and conflict checks. |
| `ExpirationManager` | Preserves absolute TTL deadlines; computes remaining TTL for persistence. |
| `ResilienceEventEmitter` | Synchronous, best-effort lifecycle event delivery to registered handlers. |

## 3. Quick start

```ts
import {
  createClient,
  createResilienceEngine,
  shutdown,
  silentLogger,
} from "@oneunit/redis";

const client = createClient(
  { url: "redis://127.0.0.1:6379", lazyConnect: false },
  silentLogger,
);

// Ensure the client is actually ready before relying on direct execution.
// With lazyConnect:true, trigger the connection first:
// await client.ping();

const engine = createResilienceEngine(client, {
  enabled: true,
  maxOperations: 1000,
  logger: silentLogger,
});

try {
  const write = await engine.execute({
    id: "set:user:1",
    command: "set",
    key: "user:1",
    args: ["alice"],
    ttlSeconds: 60,
  });

  const read = await engine.execute({
    id: "get:user:1",
    command: "get",
    key: "user:1",
    args: [],
  });

  console.log(write.outcome, read.value);
} finally {
  await engine.shutdown();
  await shutdown(client, silentLogger);
}
```

Important: `createClient` defaults to `lazyConnect: true`. If the client is not
yet ready when the engine is constructed, the engine starts in `degraded`
mode. Either use `lazyConnect: false`, or trigger the connection (`await
client.ping()` / `await client.connect()`) before constructing the engine or
before the first `execute()` where direct execution is desired.

## 4. Core API

### `createResilienceEngine(client, options?)`

Wraps an existing `ioredis` client. Returns a `ResilienceEngine`.

If `options.enabled === false`, returns a **pass-through engine** that delegates
every operation directly to Redis with no buffering, no local store, and no
recovery logic.

### `ResilienceEngine`

| Member | Type | Description |
|---|---|---|
| `redis` | `Redis` | The wrapped native client. Engine does not own it. |
| `state` | `ConnectionState` | `connected` \| `degraded` \| `recovering` \| `stopped`. |
| `isDegraded` | `boolean` | `true` while `state === "degraded"`. |
| `store` | `OperationStore` | Pending journal (public for inspection). |
| `localStore` | `LocalStore` | Degraded-mode data store (public for inspection). |
| `execute<T>(operation)` | `Promise<ResilienceResult<T>>` | Execute or buffer an operation per policy. |
| `on(handler)` / `off(handler)` | — | Subscribe/unsubscribe lifecycle events. |
| `metrics()` | `ResilienceMetrics` | Aggregate counters and gauges. |
| `recover()` | `Promise<number>` | Manually trigger one recovery cycle; returns processed count. |
| `shutdown()` | `Promise<void>` | Stop connection handling, discard pending + local state, emit a report. |

### Operation shape

```ts
interface ResilienceOperation<T = unknown> {
  id: string;                 // stable caller id (required)
  command: ResilienceCommand;  // supported command name (required)
  key: string;                // primary resource key (required)
  args: unknown[];            // command args excluding the key
  ttlSeconds?: number;        // optional TTL in seconds
  tags?: string[];            // optional invalidation grouping
  idempotent?: boolean;       // override idempotency (default by command)
  replaceable?: boolean;      // hint that a newer write supersedes this one
  policy?: "buffer" | "reject"; // override default fallback policy
  payload?: T;                // optional write payload
  expiresAt?: number;         // absolute deadline (ms since epoch)
  deduplicationKey?: string;  // cross-cycle dedup key
  conflictPolicy?: "overwrite" | "reject" | "abort";
}
```

`id` and `key` are required. `ttlSeconds` (when present) must be a positive
finite number. `expiresAt` (when present) must be a positive finite timestamp.

## 5. Supported commands

### Reads (may be served from local state during outage)

| Command | Local behavior |
|---|---|
| `get` | Returns stored value or `null` (known absence) / rejects `UNKNOWN`. |
| `exists` | Returns `1` on HIT, `0` on MISS. |
| `ttl` | Returns remaining TTL seconds, `-1` (no TTL), or `-2` (key absent). |
| `hget` | Returns field value from a locally stored hash. |
| `smembers` | Returns stored set members. |

### Writes (may be applied locally and journaled)

| Command | Local behavior |
|---|---|
| `set` | Write value (honours `ttlSeconds`). |
| `setex` | Write value with TTL taken from args. |
| `setnx` | Write only if key does not exist locally. |
| `del` | Record a tombstone (known absence) with TTL up to max(original, 300ms). |
| `expire` | Update TTL of an existing local entry. |
| `sadd` | Add a member to a locally stored set. |
| `srem` | Remove a member from a locally stored set. |
| `hset` | Set a field on a locally stored hash. |
| `hdel` | Delete a field from a locally stored hash. |
| `getset` | Overwrite and record local entry. |

### Never eligible for fallback (rejected during outage)

| Command | Reason |
|---|---|
| `incr`, `incrby`, `decr`, `decrby` | Non-idempotent counters; replay risks double-application. |

All other commands (`incr` family already listed; arbitrary/unsupported
commands) are rejected during an outage.

Notes:

- `ResilienceCommand` also lists `incr`, `incrby`, `decr`, `decrby`; they are
  intentionally **not** bufferable. They are valid command names but rejected by
  fallback policy.
- Command strings in direct execution are dispatch by `switch`; any unlisted
  command throws `"Unsupported command"`.

## 6. Operation outcomes and states

### `OperationOutcome` (returned to caller)

- `EXECUTED` — ran now (directly, or served locally).
- `BUFFERED` — applied locally and journaled for recovery.
- `REJECTED` — not eligible or capacity exceeded.
- `EXPIRED` — deadline passed before execution/recovery.
- `FAILED` — permanent failure or retry exhaustion on a non-ambiguous error.
- `AMBIGUOUS` — Redis may have executed the command but the result was lost;
  no blind replay occurs for non-idempotent commands.

### `OperationState` (journal lifecycle)

`CREATED` → `QUEUED` → `REPLAYING` → `PERSISTED` \| `EXPIRED` \| `REJECTED`
\| `FAILED` \| `AMBIGUOUS` \| `CANCELLED`.

Terminal states release the operation from the journal.

## 7. Degraded-mode behavior

### Connection states

- `connected` — socket ready; commands execute directly.
- `degraded` — Redis unreachable/not ready; fallback path active.
- `recovering` — Redis ready again; journal being drained.
- `stopped` — engine shut down.

### Reads

For an eligible read command, the engine consults `LocalStore.read()`:

- `HIT` — value exists and is valid → returned as `EXECUTED`. For
  `exists`/`ttl`/`hget`/`smembers` the engine transforms the stored value into
  the command-specific result.
- `MISS` — key is known to be absent (tombstone or expired) →
  `exists` returns `0`, `ttl` returns `-2`, others `null`.
- `UNKNOWN` — no local information → `REJECTED` with
  `"No local data for key and Redis unavailable"`.

Reads are not journaled.

### Writes

For an eligible write command, the engine:

1. applies the mutation to `LocalStore` (read-your-writes);
2. admits the operation into `OperationStore`;
3. returns `BUFFERED`.

If the local store rejects the write (size/capacity), or the journal is at
capacity, the write is `REJECTED` and the local mutation is rolled back where
applicable.

### Capacity and overflow

Defaults (override via options):

| Option | Default | Meaning |
|---|---|---|
| `maxOperations` | `10000` | Max pending journal entries **and** max local entries. |
| `maxPayloadBytes` | `50 MiB` | Max estimated total memory for journal/local store. |
| `maxOperationBytes` | `1 MiB` | Max estimated size of a single journaled operation. |
| `maxEntryBytes` | (same as `maxOperationBytes`) | Max estimated size of a single local entry value. |

On overflow, the engine emits `redis.fallback.capacity_exceeded` and returns
`REJECTED` (overflow policy is effectively `reject`).

### Fallback policy

- Default: `buffer` for all eligible commands except the counter family
  (`reject`).
- Per-operation override via `operation.policy: "buffer" | "reject"`.
- Unknown/unsupported commands reject by default.

## 8. Local degraded-mode store

The `LocalStore` keeps a process-local view of keys touched during an outage:

- keyed by Redis key;
- each entry has `value`, `state` (`valid` \| `expired` \| `tombstone`),
  `version` (monotonic), `operationId`, `updatedAt`, optional `expiresAt`;
- tombstones preserve a key's known absence, preventing stale reads after
  `DEL`;
- TTLs are absolute: `write(key, value, { ttlSeconds })` stores
  `expiresAt = now + ttlSeconds * 1000`;
- `expireStale()` removes expired entries lazily (also triggered on reads);
- bounded by entries, total bytes, and per-entry bytes;
- `read()` returns remaining TTL in seconds when applicable.

Read-your-writes: a locally applied write is immediately observable by a
subsequent `execute()` read for the same key in the same process.

## 9. Recovery

Recovery is triggered automatically when the connection manager emits
`redis.reconnected` after an outage. It can also be started explicitly with
`engine.recover()`.

### Algorithm

1. Set connection state to `recovering`; emit `redis.recovery.started`.
2. Repeat until the journal is empty or no eligible batch remains:
   - expire stale (deadline-passed) operations → `EXPIRED`;
   - select up to `recoveryBatchSize` (default `50`) eligible operations;
   - group by key for **per-key ordering**;
   - replay each key-group in admission order (groups run concurrently);
   - mark each as `REPLAYING` to prevent duplicate workers.
3. For each operation:
   - re-check TTL against current time (`ttlForPersistence`);
   - for write commands, run **conflict detection** (key exists in Redis?);
   - apply conflict policy (`overwrite` default, `reject`, `abort`);
   - execute the preserved command with the remaining TTL;
   - retry on connection/timeout failures with exponential backoff + jitter
     (base `100ms`, max `5000ms`, default `maxRetries = 3`);
   - write commands that may have executed but lost their response report
     `AMBIGUOUS` instead of being blindly replayed;
   - counter family and other non-idempotent commands are never buffered.
4. Emit per-operation `redis.operation.persisted` / `expired` / `failed` /
   `ambiguous`, and `redis.recovery.conflict` when applicable.
5. Set state back to `connected`; emit `redis.recovery.completed`.

### Backoff formula

```
delay = min(baseDelayMs * 2^(attempt-1), maxDelayMs)
delay = floor(delay * (0.5 + random() * 0.5))   // ±50% jitter band
```

### Deduplication

When `dedupeOnRecovery` is `true` (default), the coordinator records processed
operation ids and skips re-running an id seen in a prior cycle. This protects
non-idempotent ids but is best-effort in a single process.

### Conflict detection and policy

For each write recovery, the coordinator checks `GET key` in Redis:

- if the key exists, the operation is flagged `conflicted`;
- `overwrite` (default): replay proceeds (last write wins);
- `reject`: operation becomes `REJECTED`;
- `abort`: operation becomes `FAILED` and that operation is not applied.

Note: existence-based detection is advisory. It cannot tell whether the newer
value differs, or distinguish versions precisely. False positives occur whenever
any value is present.

### Ambiguous outcomes

If a connection or timeout error occurs during replay and retries are exhausted,
the outcome may be `AMBIGUOUS` rather than `FAILED`:

- idempotent commands are retried; on final failure they become `AMBIGUOUS`;
- non-idempotent commands become `AMBIGUOUS` as soon as such a failure happens,
  because replaying could double-apply.

Callers must handle `AMBIGUOUS` explicitly. There is no exactly-once guarantee.

### Manual recovery

```ts
const persistedCount = await engine.recover();
```

Safe to call while recovery is running (returns `0` for concurrent callers).

## 10. Lifecycle events

```ts
engine.on((event) => { ... });
```

Event types:

- `redis.degraded` — Redis became unavailable / not ready (`reason`).
- `redis.reconnected` — connection restored (triggers recovery).
- `redis.recovery.started` / `redis.recovery.completed` (`durationMs`, `reason`).
- `redis.operation.buffered` — operation journaled locally.
- `redis.operation.persisted` — operation successfully replayed or executed.
- `redis.operation.expired` — deadline passed before execution.
- `redis.operation.failed` — permanent or exhausted failure.
- `redis.operation.ambiguous` — outcome may have happened; not replayed.
- `redis.operation.rejected` — rejected (policy/capacity/etc.).
- `redis.fallback.capacity_exceeded` — store capacity exceeded.
- `redis.local.read.hit` / `.miss` / `.unknown` — local read classifications.
- `redis.local.write` / `.delete` / `.entry.expired` — local mutations.
- `redis.recovery.conflict` — a key conflict was detected during recovery.

Events are synchronous and best-effort: a throwing handler never breaks the
engine; slow handlers are not awaited.

## 11. Metrics

`engine.metrics()` returns:

| Field | Description |
|---|---|
| `connectionState` | Current connection state. |
| `pendingOperations` | Journal size. |
| `estimatedPayloadBytes` | Journal estimated bytes. |
| `operationsBuffered` | Total buffered count (cumulative). |
| `operationsPersisted` | Total persisted count (cumulative). |
| `operationsExpired` | Total expired count. |
| `operationsRejected` | Total rejected count. |
| `operationsFailed` | Total failed count. |
| `operationsAmbiguous` | Total ambiguous count. |
| `retryAttempts` | Retry attempt counter (declared; see noted gaps). |
| `retryExhausted` | Exhausted retry counter (declared; see noted gaps). |
| `overflowEvents` | Combined journal + local store overflow count. |
| `recoveryCycles` | Number of recovery cycles started. |
| `recoveryDurationMs` | Cumulative recovery wall-clock time. |
| `conflictsDetected` | Total conflicts detected. |
| `outageStartMs` / `outageDurationMs` | Current outage timing. |
| `oldestPendingAgeMs` | Age of oldest pending operation. |
| `localStore.*` | Entries, bytes, read/write/delete counters, expiry/rejection/overflow. |

These options can be passed to `createResilienceEngine`, `createResilientRedis`, or nested in `createClient({ resilience })` (or as direct `createClient` fields).

## 12. Options reference (`ResilienceEngineOptions`)

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | Disable entirely for pass-through mode. |
| `maxOperations` / `maxPendingOperations` | `10000` | Alias pair for max queued ops / max local entries. |
| `maxPayloadBytes` / `maxBufferSize` | `50 MiB` | Alias pair for total estimated fallback + journal bytes. |
| `maxOperationBytes` | `1 MiB` | Max bytes per journaled operation. |
| `maxPendingAge` | none | Maximum age, in milliseconds, before a pending operation is treated as expired. |
| `maxRetries` | `3` | Max replay attempts per operation. |
| `baseDelayMs` | `100` | Base retry delay. |
| `maxDelayMs` | `5000` | Retry delay cap. |
| `jitter` | (unset) | Declared; **currently unused** — backoff always applies jitter internally. |
| `recoveryBatchSize` | `50` | Max operations per recovery batch. |
| `recoveryConcurrency` | `1` | Declared; **currently recovery launches one coroutine per key group** (not strictly bounded by this value). |
| `overflow` / `onLimitExceeded` | `reject` | Only `reject` is supported; unsupported policies fail explicitly. |
| `logger` | — | Optional normalized logger. |
| `dedupeOnRecovery` | `true` | Skip re-executing ids seen in prior recovery cycles. |
| `conflictPolicy` | `overwrite` | `overwrite` \| `reject` \| `abort` during recovery. |

## 13. Pass-through mode

```ts
const engine = createResilienceEngine(client, { enabled: false });
```

- `state` always reports `connected`;
- `isDegraded` is always `false`;
- every `execute()` delegates directly to Redis;
- `store` / `localStore` are empty no-op stubs (writes throw
  `"local store disabled"` if invoked, but they are never invoked);
- `recover()` resolves `0`; `shutdown()` is a no-op.

Use this to keep call sites uniform while disabling resilience.

## 14. Advantages

- **Availability during outages**: eligible reads/writes keep functioning
  while Redis is down.
- **Read-your-writes**: local mutations are immediately observable.
- **Safe by default**: non-idempotent counters and unsupported commands are
  rejected rather than blindly applied.
- **Bounded resources**: count and byte budgets prevent unbounded memory
  growth.
- **TTL fidelity**: absolute deadlines are preserved and remaining TTL is
  applied on recovery.
- **Observability**: structured events, rich metrics, and a manual `recover()`.
- **Configurable conflict handling**: overwrite/reject/abort policies.
- **Drop-in wrapper**: native client still accessible for direct use.
- **No extra infrastructure**: entirely in-process; works with any `ioredis`
  client (standalone or cluster).

## 15. Trade-offs

- **Process-local scope**: buffered operations live only in the current
  process; other instances remain unaware of each other's writes during an
  outage. Cross-instance consistency requires additional coordination.
- **No crash durability**: all in-memory state is lost on crash/restart.
  `shutdown()` discards state and emits a report; pending work is not resumed
  later.
- **No exactly-once guarantee**: `AMBIGUOUS` outcomes require caller handling.
  Non-idempotent side effects are never replayed blindly.
- **Divergent behavior during outage**: counter commands and unsupported
  commands fail even though Redis would normally accept them.
- **Memory cost**: journal + local store consume process memory proportional
  to outage duration and write rate, up to configured bounds.
- **Recovery latency**: replay is batched and per-key ordered, so a large
  backlog can take time; concurrency is utilised per key group.
- **Conservative conflict detection**: existence checks produce false
  positives (any existing key is treated as a conflict).
- **Pass-through vs engine duality**: applications must code against
  `ResilienceResult` outcomes, not raw Redis return values.
- **Option gaps**: `jitter`, `overflow`, and `recoveryConcurrency` are declared
  but not fully wired in the current implementation.

## 16. Limitations

| Limitation | Notes |
|---|---|
| Process-local state | No cross-instance view during outage. |
| No crash durability | Lost on process exit/crash. |
| No exactly-once | `AMBIGUOUS` reporting; caller must reconcile. |
| Advisory conflicts | Existence-based detection only. |
| Not a Redis emulator | Only supported commands buffer/serve locally; others rejected. |
| Counter commands | `incr`/`incrby`/`decr`/`decrby` rejected during outage. |
| Locks / transactions | Not supported (atomicity cannot be reproduced locally). |
| Subscription recovery | Automatic resubscription not provided. |
| Concurrency option | `recoveryConcurrency` not strictly enforced. |
| Options partially wired | `jitter`, `overflow` not fully honoured. |
| ioredis only | Wraps an `ioredis` client; not a generic Redis abstraction. |

## 17. Error handling and observability tips

- Always register an `on()` handler in production to surface
  `redis.degraded`, capacity, conflict, and ambiguous events.
- Use `metrics()` (and expose to your metrics system) to track
  `pendingOperations`, `outageDurationMs`, and the *ambiguous* counter.
- Call `engine.shutdown()` during graceful process shutdown to discard and
  report state rather than letting it silently disappear.
- Treat `AMBIGUOUS` results as “possibly applied”: re-read authoritative
  state or apply idempotency keys at the application layer.
- Validate operation ids and keys client-side where possible, since
  `validateOperation()` throws synchronously inside `execute()`.

## 18. Related files

- `src/resilience/index.ts` — engine factory and pass-through engine.
- `src/resilience/types.ts` — public types and option contracts.
- `src/resilience/connection-manager.ts` — connection lifecycle.
- `src/resilience/operation-store.ts` — bounded journal.
- `src/resilience/local-store.ts` — degraded-mode read model.
- `src/resilience/recovery-coordinator.ts` — replay logic.
- `src/resilience/expiration-manager.ts` — TTL handling.
- `src/resilience/policy.ts` — fallback classification.
- `src/resilience/events.ts` — event emitter.

See also `FEATURES.md` (feature matrix) and `ARCHITECTURE.md` for broader
package context.
