# Feature Matrix — `@oneunit/redis`

Status legend:

- ✅ **Implemented** — the package ships a dedicated API or documented contract for it.
- ⚠️ **Partial / pass-through** — available through the native `ioredis` / BullMQ objects the package returns or configures, but the package adds little or no abstraction.
- ❌ **Not implemented** — no dedicated API or helper in this package.

Package version covered: `1.0.0` (`src/` as published). Raw Redis commands remain available on every client returned by `createClient`; they are listed as ⚠️ only where the package documents or depends on them, and ❌ where there is no package-level support at all.

## 1. Core Redis infrastructure

| Feature | Status | Notes |
|---|---|---|
| Connection management — connect, reconnect, disconnect, lifecycle hooks | ✅ | `createClient`, `attachEvents` (`connect`, `ready`, `reconnecting`, `error`, `close`), `shutdown` |
| Client adapters — ioredis adapter | ✅ | Native `ioredis` client is constructed and returned |
| Client adapters — optional alternative client adapters | ❌ | None beyond ioredis |
| Connection profile — standalone | ✅ | `createClient` returns the standalone `Redis` client |
| Connection profile — Sentinel | ✅ | `createSentinelClient` plus pass-through options |
| Connection profile — Cluster | ✅ | Optional `createClusterClient` |
| Namespace management — application, environment, service, tenant prefixes | ✅ | Optional `buildKey` and key validation |
| Key builder — consistent keys, validation, hash-tag support | ✅ | Optional `buildKey` |
| Serialization — JSON, strings, typed codecs, versioning | ✅ | Optional `serialize` / `deserialize` |
| TTL management — default TTLs, expiration, TTL jitter | ✅ | Raw commands plus optional `jitterTtl` |
| Atomic operations — transactions | ✅ | `runTransaction` wrapper with labelled steps, timeout, and typed results (raw `MULTI`/`EXEC`/`WATCH` also available) |
| Atomic operations — conditional writes | ✅ | Optional `setIfAbsent` / `compareAndSwap` |
| Pipelines — batch commands, reduced round trips | ✅ | `runPipeline`, `pipelineValues`, labeled results, timeout, redaction |
| Error handling — typed errors | ✅ | Typed pipeline/timeout/step errors plus optional `classifyError`, `isRetryable`, `attachErrorHandling` |
| Error handling — timeout classification | ✅ | Health, pipeline, and shutdown are bounded |
| Error handling — retry policies | ✅ | ioredis/BullMQ pass-through plus optional `retryOperation` helper |
| Health checks — liveness, readiness, connectivity | ✅ | `health()` with bounded `PING` |
| Graceful shutdown — stop workers, close subscriptions, release connections | ✅ | `shutdown()`, queue/worker close guidance |
| Configuration validation — URLs, credentials, TLS, timeouts | ✅ | URL, `keyPrefix`, concurrency, TTL, and store validation |
| Capability detection — supported commands and Redis features | ✅ | Optional `detectCapabilities` |
| Resilience engine — transparent resilient client | ✅ | `createResilientRedis` and `createClient({ resilience, fallback, recovery })`, with auto-detect, degraded routing, automatic recovery |
| Job processing — optional at-least-once BullMQ integration | ✅ | `jobAtLeastOnce`, BullMQ queue/worker wrappers, retries, backoff, graceful shutdown |

| Resilience engine — in-memory buffering during Redis outages | ✅ | `createResilienceEngine`, bounded operation store, TTL-preserving recovery, lifecycle events, bounded pending age |
| Resilience engine — operation fallback policy | ✅ | Eligible commands buffered, non-idempotent/unsafe commands rejected |
| Resilience engine — bounded memory | ✅ | Max operation count, max payload bytes, max per-operation size, overflow policy |
| Resilience engine — TTL preservation | ✅ | Absolute deadlines preserved across outage, remaining TTL applied on recovery |
| Resilience engine — single-worker recovery | ✅ | One recovery coordinator per process, per-key ordering, bounded retries |
| Resilience engine — ambiguous outcome handling | ✅ | Non-idempotent commands report AMBIGUOUS rather than blindly replaying |
| Resilience engine — degraded-mode local reads | ✅ | Eligible reads served from local state (HIT/MISS/UNKNOWN) during outage |
| Resilience engine — degraded-mode local writes | ✅ | Eligible mutations applied locally and journaled for reconciliation |
| Resilience engine — local tombstones | ✅ | Deletions recorded as tombstones, preventing stale reads |
| Resilience engine — local TTL preservation | ✅ | Original TTL deadlines preserved, remaining TTL served on read |
| Resilience engine — bounded local store | ✅ | Max entries, max payload bytes, max entry size, overflow policy |
| Resilience engine — read-your-writes | ✅ | Same-process local reads observe prior local mutations |
| Resilience engine — conflict detection | ✅ | Recovery detects keys modified by other writers; configurable policy (overwrite/reject/abort) |
| Resilience engine — ambiguous outcomes | ✅ | Connection failures after possible execution report AMBIGUOUS; no blind replay of non-idempotent commands |
| Resilience engine — shutdown reporting | ✅ | Shutdown reports discarded pending operations and local entries |
| Resilience engine — multi-instance | ❌ | Process-local only; no cross-instance shared state during outage |
| Resilience engine — crash durability | ❌ | In-memory state lost on process crash; no durable persistence |
| Resilience engine — local state cleared on shutdown | ✅ | `shutdown()` clears local store and stops connection |

## 2. Caching infrastructure

No dedicated cache module. Examples show manual cache-aside/TTL patterns on the native client.

| Feature | Status |
|---|---|
| Cache-aside | ✅ | Optional `createRedisCache` |
| Read-through | ✅ | `getOrLoad` / `remember` |
| Write-through | ✅ | Explicit `writeThrough(key, writer)` helper, `writeThrough` option on `set` |
| Write-behind | ✅ | `writeBehind` option with async flush, `flushWriteBehind()`, `writeBehindStats()` |
| Cache invalidation | ✅ | `invalidate` |
| Tag-based invalidation | ✅ | `invalidateTag` |
| Namespace invalidation | ⚠️ | Prefix-scoped keys, no global registry |
| Negative caching | ✅ | `negativeTtlSeconds` option caches null results |
| Cache stampede protection | ✅ | In-process coalescing |
| Request coalescing | ✅ | In-process `getOrLoad` |
| Stale-while-revalidate | ✅ | `staleWhileRevalidate` option serves stale while revalidating |
| TTL jitter | ✅ | `jitter` option applies `jitterTtl` to stored TTLs |
| Cache warming | ✅ | `warm(key, loader)` prepopulates without returning |
| Local L1 cache | ✅ | `localL1` option with `enabled`, `ttlSeconds`, `populateOnMiss`, size policies |
| Cache metrics | ✅ | `metrics()` returns hits, misses, hit rate, L1 stats, write-behind stats |
| Cache size policies | ✅ | `sizePolicy` with `maxEntries`, `maxMemoryBytes`, `evictionPolicy` (LRU/LFU/FIFO/random) |
| Recommended public API (`get`, `set`, `getOrLoad`, `remember`, `invalidate`, `invalidateTag`, `wrap`, `warm`, `writeThrough`, `flushWriteBehind`, `writeBehindStats`, `l1Stats`, `clearL1`, `evictL1`, `shutdown`) | ✅ | All implemented |

## 3. Rate limiting, quotas, and traffic control

No rate-limit or quota module in this package.

| Feature | Status |
|---|---|
| Fixed-window limiter | ❌ |
| Sliding-window limiter | ❌ |
| Token bucket | ❌ |
| Leaky bucket | ❌ |
| Multi-dimensional limiting | ❌ |
| Weighted rate limiting | ❌ |
| Concurrency limiter | ❌ |
| Distributed semaphore | ❌ |
| Daily/monthly quotas | ❌ |
| Burst protection | ❌ |
| Retry-after calculation | ❌ |
| Rate-limit metadata | ❌ |
| Fail-open/fail-closed policy | ❌ |
| Adaptive throttling | ❌ |
| Load shedding | ❌ |
| Backpressure | ❌ |

## 4. Distributed coordination and locking

Implemented under `@oneunit/redis/coordination` (also re-exported from the package root).

| Feature | Status |
|---|---|
| Distributed mutex | ✅ |
| Lease-based lock | ✅ |
| Lock renewal | ✅ |
| Safe lock release | ✅ |
| Lock timeout | ✅ |
| Try-lock | ✅ |
| Lock with callback | ✅ |
| Distributed semaphore | ✅ |
| Single-flight execution | ✅ |
| Leader election | ✅ |
| Singleton scheduler | ✅ |
| Job claiming | ✅ |
| Fencing tokens | ✅ |
| Resource leases | ✅ |
| Distributed barriers | ✅ |

## 5. Idempotency and duplicate prevention

| Feature | Status | Notes |
|---|---|---|
| Idempotency keys | ❌ | |
| Request deduplication | ❌ | |
| Job deduplication | ⚠️ | BullMQ `jobId` / deduplication options pass-through only |
| Event deduplication | ❌ | |
| Claim/complete states | ⚠️ | `createRedisStateStore` get/set/consume lifecycle |
| In-flight request coordination | ❌ | |
| Result caching | ❌ | |
| Idempotency TTL policies | ⚠️ | Store keys carry TTLs |
| Payload fingerprinting | ❌ | |
| Retry-safe execution helpers | ❌ | |

## 6. Queues and background jobs

| Feature | Status | Notes |
|---|---|---|
| Queue factory | ✅ | `createQueue` |
| Worker factory | ✅ | `createWorker` |
| Scheduled jobs | ✅ | Delayed jobs via BullMQ |
| Recurring jobs | ✅ | `scheduleJob` / `removeJobScheduler` / `getJobSchedulers` wrappers plus BullMQ repeat options |
| Retry and backoff policies | ✅ | Defaults + override merge |
| Job priorities | ⚠️ | BullMQ `priority` option |
| Job deduplication | ⚠️ | BullMQ `jobId` / deduplication pass-through |
| Concurrency controls | ✅ | `WorkerConfig.concurrency` |
| Job cancellation | ✅ | `cancelJob`/`cancelWorkerJob` wrappers around native BullMQ cancellation |
| Job progress | ✅ | `getJobProgress` wrapper plus native progress reporting |
| Job result storage | ✅ | `getJobResult` wrapper plus native BullMQ return values |
| Dead-letter handling | ✅ | `createDlqQueue`, `moveToDlq`, `replayDlqJob`, `getDlqEntries` wrappers |
| Stalled-job recovery | ✅ | BullMQ built-in |
| Graceful draining | ✅ | `worker.close(true)`, `queue.close()` |
| Queue pause/resume | ✅ | `pauseQueue`/`resumeQueue` wrappers over native BullMQ methods |
| Queue rate limiting | ✅ | `WorkerConfig.limiter` |
| Delayed execution | ✅ | Job `delay` |
| Dependency workflows | ✅ | `createFlowProducer`, `addFlow`, `addBulkFlows` wrappers |
| Batch jobs | ✅ | `addBulkJobs`/`enqueueBulkJobs`/`addBulkFlows` high-level wrappers |
| Bulk enqueueing | ✅ | `addBulkJobs`/`enqueueBulkJobs`/`addBulkFlows` wrappers |
| Job retention policies | ✅ | Defaults (`removeOnComplete`, `removeOnFail`) + override |
| Queue health metrics | ✅ | `getQueueCounts`/`getQueueHealth`/`getWorkerHealth` wrappers |
| Worker heartbeats | ✅ | BullMQ built-in |
| Queue dashboard adapter | ❌ | None |
| Higher-level additions (middleware, typed registries, error classification, tracing, per-queue policies) | ✅ | `createWorker` middleware, `createJobRegistry`/`validateJobData`, `createErrorClassifier`, `createTracingMiddleware`, policy registry helpers ||

## 7. Messaging and event infrastructure

| Feature | Status | Notes |
|---|---|---|
| Pub/Sub publisher | ⚠️ | `client.publish` on the native client; see `examples/pubsub.js` |
| Pub/Sub subscriber | ⚠️ | `subscribe` / `on("message")` on the native client |
| Typed event contracts | ❌ | |
| Event versioning | ❌ | |
| Channel namespaces | ❌ | Convention only; no enforcement |
| Redis Streams producer | ⚠️ | Raw `XADD` via the client |
| Consumer groups | ❌ | No wrapper |
| Acknowledgements | ❌ | No wrapper |
| Pending-message recovery | ❌ | No wrapper |
| Consumer identity | ❌ | No wrapper |
| Event deduplication | ❌ | |
| Retry and dead-letter workflow | ⚠️ | Queue-events path only |
| Event filtering | ❌ | |
| Outbox integration | ❌ | |
| Inbox pattern | ❌ | |
| Replay utilities | ❌ | |
| Event metrics | ❌ | |

## 8. Session, identity, and ephemeral state

| Feature | Status | Notes |
|---|---|---|
| Session store (shared across instances) | ✅ | `createRedisSessionStore` |
| Session expiration | ⚠️ | Auth-side TTL handling; store tracks versions/revocation |
| Session touch | ❌ | No touch helper in the package |
| Session revocation | ✅ | `revokeSession` / `isSessionRevoked` |
| Session versioning | ✅ | `getVersion` / `bumpVersion` |
| Device session registry | ❌ | |
| OTP storage | ❌ | |
| OTP attempt limits | ❌ | |
| Temporary tokens | ⚠️ | `createRedisStateStore` |
| Password-reset state | ❌ | |
| One-time token consumption | ✅ | `StateStore.consume` |
| Temporary workflow state | ✅ | `createRedisStateStore` |
| Distributed feature flags | ❌ | |
| Short-lived authorization state | ⚠️ | State store with TTL |

## 9. Real-time presence and coordination

| Feature | Status |
|---|---|
| Online/offline status | ❌ |
| Heartbeats | ❌ |
| Presence TTL | ❌ |
| Device presence | ❌ |
| Service-instance presence | ❌ |
| Connection registry | ❌ |
| Room membership | ❌ |
| Typing indicators | ❌ |
| Last-seen timestamp | ❌ |
| Ephemeral notifications | ❌ |
| WebSocket fan-out | ❌ |
| Presence aggregation | ❌ |
| Reconnect coordination | ❌ |

## 10. Counters, rankings, and real-time data structures

These are raw Redis primitives exposed on the native client; the package ships no dedicated metric/ranking APIs.

| Feature | Status |
|---|---|
| Atomic counters | ⚠️ |
| Field-level counters | ⚠️ |
| Unique membership (sets) | ⚠️ |
| Ranking (sorted sets) | ⚠️ |
| Time-ordered IDs (sorted sets) | ⚠️ |
| Approximate unique counts (HyperLogLog) | ⚠️ |
| Compact boolean state (bitmaps) | ⚠️ |
| Time-series aggregation | ⚠️ |
| Geospatial lookup | ⚠️ |
| Temporary aggregation | ⚠️ |
| Rolling windows | ⚠️ |
| Distributed sequence allocation | ⚠️ |

## 11. Reliability, recovery, and resilience

| Feature | Status | Notes |
|---|---|---|
| Command timeout policies | ⚠️ | Selected operations bounded; raw commands follow ioredis defaults |
| Retry classification | ⚠️ | ioredis retry strategy and BullMQ attempts |
| Exponential backoff with jitter | ⚠️ | Queue defaults use exponential backoff; jitter not built in |
| Circuit breaker | ❌ | |
| Bulkhead isolation | ❌ | |
| Fallback policies | ❌ | |
| Connection recovery | ✅ | ioredis reconnect + event hooks |
| Subscription recovery | ⚠️ | Automatic resubscription is not provided |
| Worker recovery | ✅ | BullMQ built-in |
| Operation deadlines | ⚠️ | Health, pipeline, shutdown only |
| Cancellation propagation | ❌ | |
| Graceful degradation | ❌ | |
| Recovery hooks | ⚠️ | Lifecycle event hooks |
| Dependency health aggregation | ⚠️ | Single-client `health()` |
| Failure injection tests | ❌ | No consumer-facing utilities |

## 12. Observability and diagnostics

| Feature | Status | Notes |
|---|---|---|
| Structured logs | ⚠️ | Normalized logger with redaction |
| Metrics hooks | ❌ | |
| OpenTelemetry tracing | ❌ | |
| Command latency metrics | ❌ | Only health latency is returned |
| Cache hit/miss metrics | ❌ | |
| Queue metrics | ⚠️ | Native BullMQ counts/metrics |
| Consumer lag metrics | ❌ | |
| Rate-limit metrics | ❌ | |
| Lock metrics | ❌ | |
| Connection metrics | ⚠️ | Connection event logs |
| Health endpoints | ❌ | `health()` helper only; no HTTP server integration |
| Diagnostic snapshots | ❌ | |
| Config introspection | ❌ | |
| Cardinality controls | ❌ | |

## 13. Memory, capacity, and performance management

| Feature | Status | Notes |
|---|---|---|
| Memory usage inspection | ❌ | |
| Key TTL auditing | ❌ | |
| Keyspace statistics | ❌ | |
| Large-key diagnostics | ❌ | |
| Batch operation helpers | ✅ | `runPipeline` |
| Pipeline helpers | ✅ | `runPipeline` |
| Connection usage metrics | ❌ | |
| Hot-key diagnostics | ❌ | |
| Cache TTL policies | ❌ | |
| Eviction-policy guidance | ⚠️ | General TTL discipline in docs/examples |
| Data retention policies | ⚠️ | Queue defaults (`removeOnComplete`/`removeOnFail`) |
| Payload-size limits | ❌ | |
| Cluster-aware key design | ❌ | |
| Workload isolation guidance | ⚠️ | ARCHITECTURE discusses load isolation |

## 14. Multi-tenancy and service isolation

| Feature | Status | Notes |
|---|---|---|
| Service namespaces | ❌ | |
| Environment namespaces | ❌ | |
| Tenant key prefixes | ❌ | |
| Tenant quotas | ❌ | |
| Per-tenant rate limits | ❌ | |
| Per-tenant cache policy | ❌ | |
| Queue isolation | ⚠️ | `prefix` per queue |
| Priority classes | ⚠️ | Job `priority` option |
| Resource budgets | ❌ | |
| Namespace-safe invalidation | ❌ | |
| Access-control integration | ❌ | |

## 15. Security infrastructure

| Feature | Status | Notes |
|---|---|---|
| TLS configuration | ⚠️ | Pass-through ioredis options |
| Credential-provider support | ❌ | URL / `REDIS_URL` only |
| Secret redaction | ✅ | `redactError` / `redactError` in events and shutdown |
| Redis ACL compatibility | ⚠️ | Pass-through |
| Command allowlists | ❌ | |
| Input validation | ⚠️ | URL, `keyPrefix`, concurrency guards |
| Payload limits | ❌ | |
| Namespace enforcement | ❌ | |
| Secure temporary tokens | ⚠️ | State store with TTL/consume |
| Security event hooks | ⚠️ | Redacted connection/error events |
| Safe key deletion | ❌ | `KEYS` avoided in docs; no helper |

## 16. Distributed configuration and feature management

| Feature | Status | Notes |
|---|---|---|
| Configuration cache | ❌ | |
| Configuration versioning | ❌ | |
| Pub/Sub invalidation | ⚠️ | Raw publish/subscribe can be used |
| Feature-flag cache | ❌ | |
| Runtime policy updates | ❌ | |
| Dynamic service settings | ❌ | |
| Configuration snapshots | ❌ | |
| Change notifications | ⚠️ | Events only on queues |

## 17. Deployment and infrastructure integration

| Feature | Status | Notes |
|---|---|---|
| Environment-aware configuration | ⚠️ | `REDIS_URL`, logger detection |
| Docker Compose examples | ❌ | No compose files in the package |
| Sentinel support | ⚠️ | Pass-through |
| Cluster support | ❌ | |
| TLS and ACL examples | ❌ | |
| Readiness integration | ⚠️ | `health()` helper |
| Shutdown integration | ✅ | `shutdown()` |
| Kubernetes health integration | ❌ | No endpoints exported |
| Migration/version checks | ❌ | |
| Operational runbooks | ⚠️ | README / ARCHITECTURE / CONTRIBUTING |
| Backup and restore documentation | ❌ | |
| Integration-test environment | ✅ | Tests run against a real Redis service container |
| Load-testing scenarios | ❌ | |

## 18. Testing infrastructure for package consumers

| Feature | Status | Notes |
|---|---|---|
| Mock Redis interfaces | ❌ | |
| Test Redis container | ❌ | Consumers provide Redis |
| Queue test utilities | ❌ | Not shipped |
| Deterministic clock injection | ❌ | |
| Failure simulation | ❌ | Not exposed |
| Concurrency tests | ❌ | |
| Test namespace isolation | ❌ | |
| Cleanup utilities | ❌ | Internal example helpers only |
| Contract tests | ⚠️ | Package's own internal tests |
| Benchmark utilities | ❌ | |
| Test fixtures | ❌ | |

---

## Feature folder (`src/features`)

The `features/` subtree is the only higher-level application support shipped in this package. It is exposed via `@oneunit/redis/features` (also `@oneunit/redis/auth`) and depends on the optional peer `@oneunit/auth`.

| Export | Status | Purpose |
|---|---|---|
| `createRedisRefreshStore(redis, options?)` | ✅ | Redis-backed `RefreshStore`: save, get, atomic consume (Lua), and revoke; TTL on expiry |
| `createRedisSessionStore(redis, options?)` | ✅ | `SessionStore`: per-user version counters and revoked-session flags with TTL |
| `createRedisStateStore(redis, options?)` | ✅ | `StateStore`: temporary single-use state with TTL and atomic consume |
| `createRedisStores(redis, options?)` | ✅ | Factory returning all three stores above |
| `RedisStoreOptions` (`keyPrefix`, `revokedSessionTtlSeconds`) | ✅ | Store configuration options |
| `createScheduledSessionRevocation(config)` | ✅ | Queue-backed delayed session revocation built on BullMQ delayed jobs |
| `createRedisCache(redis, options?)` | ✅ | Optional Redis-backed cache with TTL, invalidation, tags, and stampede protection |
| `buildKey(...parts)` | ✅ | Validated namespace/key builder primitive |
| `serialize(value)` / `deserialize(raw)` | ✅ | JSON codec helpers |
| `jitterTtl(baseSeconds, jitter?)` | ✅ | TTL jitter helper |
| `setIfAbsent(client, key, value, options?)` | ✅ | Conditional write helper |
| `compareAndSwap(client, key, expected, next, options?)` | ✅ | Optimistic atomic CAS helper |
| `detectCapabilities(client)` | ✅ | Redis capability probing helper |
| `createClusterClient(nodes, options?)` | ✅ | Optional ioredis Cluster factory |
| `ScheduledSessionRevocationConfig` / `ScheduledSessionRevocation` | ✅ | Configuration and runtime interface |

### Feature-folder cross-reference

| Stable feature | Implemented by |
|---|---|
| Session store / session revocation / session versioning (category 8) | `createRedisSessionStore`, `createScheduledSessionRevocation` |
| Temporary tokens / temporary workflow state / short-lived authorization state (category 8) | `createRedisStateStore` |
| Idempotency claim/complete and TTL policies (category 5) | `RefreshStore.consume`, `StateStore.consume`, store TTLs |
| Queue factory / scheduled jobs / delayed execution (category 6) | `createScheduledSessionRevocation` uses `createQueue`/`createWorker` |

### Local storage security

The process-local store and pending journal retain values needed to serve or replay supported
commands during an outage. They are process memory only, not encrypted, and may expose sensitive
values if the process is compromised. They are not a durable store and are cleared on shutdown.

### Resilience engine limitations

| Limitation | Description |
|---|---|
| Process-local state | Local data and pending journal exist only in the current process. Other server instances cannot see buffered operations during an outage. Cross-instance consistency requires a shared/durable coordination mechanism. |
| No crash durability | In-memory state is lost if the process crashes, restarts, or is terminated. `shutdown()` discards pending operations and local entries with an explicit event report. |
| No exactly-once guarantee | The engine does not guarantee exactly-once execution. Non-idempotent commands report AMBIGUOUS rather than being blindly replayed. Callers must handle ambiguous outcomes. |
| Conflict policy is advisory | Conflict detection during recovery checks if a key exists in Redis but cannot determine the exact version without a sidecar metadata key. The "overwrite" policy allows last-write-wins; "reject"/"abort" prevent overwriting but may leave operations unreconciled. |
| Not a Redis emulator | Only explicitly supported commands can be buffered or served locally. Unsupported commands (e.g., `INCR`, `DECR`, transactions, locks) are rejected during outages. |
| Secure temporary tokens (category 15) | `createRedisStateStore` with TTL + consume |
