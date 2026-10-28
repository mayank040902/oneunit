# Architecture — `@oneunit/redis`

**Status:** Architecture (verified against cloud Redis & local Redis)   
**Audience:** Maintainers and contributors of `@oneunit/redis`  
**Guiding question:** What is the smallest set of guarantees that prevents recurring Redis/BullMQ integration failures without hiding the underlying libraries?

---

## 0. Executive summary

`@oneunit/redis` is a thin, opinionated integration layer over **ioredis** and **BullMQ**, with an optional adapter for **`@oneunit/auth`**.

It exists to:

1. Apply safe, repeatable defaults (connection options, redaction, timeouts).
2. Make resource ownership and shutdown contracts explicit.
3. Bound operations that commonly hang (health, pipeline, shutdown).
4. Keep subpath dependency surfaces small and independently loadable.
5. Verify that the *packed* package—not just the source tree—behaves as documented.

It does **not** exist to replace ioredis/BullMQ, introduce a connection pool, cache layer, repository pattern, or framework runtime.

**Non-negotiables**

| Guarantee | Why it matters |
|---|---|
| Native objects returned | Full library compatibility; no proxy surprises |
| Explicit ownership | No double-close, no orphaned reconnect loops |
| Bounded waits | Callers never hang indefinitely on health/pipeline/shutdown |
| Credential redaction | Secrets never reach logs or public error surfaces by default |
| Subpath isolation | Importing `client` must not load BullMQ |
| Artifact-tested public API | Type declarations, exports, and runtime match the published tarball |

---

## 1. Purpose and design principles

### Architectural principles

1. **Thin wrappers, explicit contracts.** Add behavior only where it prevents a recurring integration error or provides a clear, reusable guarantee.
2. **Dependency direction is one-way.** Shared primitives sit below clients, queues, pipelines, and optional features. Subpaths must not import unrelated subsystems.
3. **Ownership is explicit.** Every connection and event listener has a documented owner and a single shutdown path.
4. **Failures are bounded where promised.** Health, pipeline, and shutdown settle within documented deadlines. A deadline bounds the *caller’s wait*; it does not cancel the underlying Redis command unless explicitly documented otherwise.
5. **Security is centralized.** Redaction happens in one place before logging or returning errors through APIs that promise sanitization. Job payload logging is opt-in.
6. **Public behavior is tested from the packed artifact.** Type declarations, export maps, source maps, and runtime imports are part of the package contract.
7. **No hidden infrastructure.** No connection pool, cache, serializer, retry engine, or framework-specific dependency unless a concrete consumer requirement justifies it.

### Design tension to keep visible

| Choice | Benefit | Cost |
|---|---|---|
| Native ioredis / BullMQ objects | Zero abstraction tax | Consumers must understand library semantics |
| `lazyConnect: true` | No import-time side effects | Readiness is the caller’s responsibility |
| `maxRetriesPerRequest: null` | BullMQ-compatible | Commands can wait indefinitely without wrapper bounds |
| Promise-based deadlines | Prevent hung callers | Timeout ≠ cancellation |
| Separate subpaths | Smaller dependency surface | Export maps and consumer tests require ongoing care |

---

## 2. Scope and non-goals

### In scope

- Creating and configuring an ioredis client with safe defaults.
- Connection event logging with credential redaction.
- Bounded Redis health checks.
- Graceful, idempotent client shutdown with a forced-close deadline.
- BullMQ Queue, Worker, and QueueEvents factories with documented option merge rules.
- Labelled, bounded pipeline execution with explicit per-command results.
- Optional Redis-backed auth-store adapters for `@oneunit/auth`.
- Optional queue-backed delayed operations (for example scheduled session revocation) built on the queue and pipeline contracts, kept out of the base Redis client.
- Public package exports, subpath isolation, and release verification.

### Out of scope

- Implementing Redis commands or replacing ioredis.
- Implementing a queue engine or replacing BullMQ.
- Application-specific cache policies, key schemas, or domain repositories.
- Hidden infrastructure not justified by a concrete consumer requirement.
- A mandatory logger, HTTP framework, metrics provider, or process manager.
- Automatic lifecycle management for resources the package did not create.
- Multi-tenant key isolation or encryption-at-rest.

Optional modules now implemented as separate, explicitly designed features (not part of the thin core client):
coordination, rate limiting, caching, resilience, scheduled revocation, at-least-once job processing, and core helper primitives.

---

## 3. Dependency graph and boundaries

```mermaid
flowchart TD
    Core["core<br/>types · errors · timeout · helpers"]
    Logging["logging<br/>contract · normalize · redact"]
    Client["client<br/>factory · events · health · shutdown · sentinel · transaction"]
    Queue["queue<br/>Queue · Worker · QueueEvents · lifecycle · DLQ"]
    Pipeline["pipeline<br/>labelled batch execution"]
    Auth["features/auth-stores<br/>refresh · session · state"]
    AuthStores["features/stores · scheduled · retry"]
    Helpers["features/core-helpers<br/>keys · codec · ttl · CAS · capabilities"]
    Cache["cache<br/>local L1 + Redis cache · SWR · write-behind"]
    Coord["coordination<br/>lock · semaphore · lease · election · barrier · fencing"]
    Resilience["resilience<br/>engine · local store · recovery · connection manager"]
    JobProc["jobs<br/>at-least-once processing"]
    RateLimit["rate-limit<br/>limiter · quota · concurrency · burst · adaptive · load-shed · backpressure · multi"]
    Ioredis["ioredis"]
    Bull["bullmq"]
    OneAuth["@oneunit/auth"]

    Client --> Core
    Client --> Logging
    Client --> Ioredis
    Client --> Resilience
    Queue --> Core
    Queue --> Logging
    Queue --> Bull
    Queue --> Ioredis
    Pipeline --> Core
    Pipeline --> Logging
    Pipeline --> Ioredis
    Auth --> Core
    Auth --> OneAuth
    Auth --> Ioredis
    Cache --> Core
    Cache --> Pipeline
    Cache --> Ioredis
    Coord --> Core
    Coord --> Logging
    Coord --> Ioredis
    Resilience --> Core
    Resilience --> Logging
    Resilience --> Ioredis
    RateLimit --> Core
    RateLimit --> Coord
    RateLimit --> Client
    RateLimit --> Ioredis
    JobProc --> Queue
    JobProc --> Ioredis
```

### Boundary rules (must be enforced by tests)

| Rule | Rationale |
|---|---|
| `client/` never imports BullMQ | Keeps `@oneunit/redis/client` free of queue weight |
| `queue/` does not import client health/shutdown implementation | Avoids coupling; may share types and redaction only |
| `pipeline/` does not import the root barrel | Prevents accidental initialization and cycles |
| Base client/queue subpaths never import `@oneunit/auth` | Auth remains truly optional |
| `coordination/` does not import `queue/` or `pipeline/` | Keeps coordination free of queue weight |
| `cache/` imports `pipeline/` but not `queue/` | Cache batching stays decoupled from queues |
| `rate-limit/` never imports `queue/` or `pipeline/` | Keeps rate limiting free of queue weight |
| `resilience/` and `resilient-redis` keep native client primary | Resilience remains optional and pass-through capable |
| `jobs/` depends on `queue/` only | At-least-once processing stays queue-backed |
| `features/core-helpers` has no Redis I/O except declared helpers | Helper primitives stay dependency-light |
| Internal modules prefer direct file imports over broad barrels | Prevents cycles and accidental surface expansion |
| Root `index.ts` only re-exports | No business logic in the composition root |
| Every public subpath is independently loadable | No side effects from unrelated modules |

### Suggested dependency classification

| Package | Role | Notes |
|---|---|---|
| `ioredis` | dependency | Package constructs clients |
| `bullmq` | dependency | Package constructs queues/workers |
| `@oneunit/auth` | optional peer (or separate adapter package) | Must not be required by base install |
| Logger libraries | none | Accept any compatible shape; no hard dependency |

---

## 4. Source layout

```text
src/
├── index.ts                          # public composition root (re-exports only)
├── logger.ts                         # Logger contract, normalization, redaction helpers
├── client/
│   ├── index.ts
│   ├── client.ts                     # createClient(); optional resilience/job wiring
│   ├── events.ts                     # attach events, redaction, error classification
│   ├── check.ts                      # bounded health()
│   ├── shutdown.ts                   # idempotent, bounded shutdown()
│   ├── retry.ts                      # retry helpers
│   ├── sentinel.ts                   # sentinel client factory
│   └── transaction.ts               # labelled transaction orchestration
├── queue/
│   ├── index.ts
│   ├── queue.ts                      # createQueue, queue operations
│   ├── worker.ts                     # createWorker, worker operations
│   ├── events.ts                     # attachQueueEvents
│   └── lifecycle.ts                  # DLQ, pause/resume, queue policy, types
├── pipeline/
│   ├── index.ts
│   ├── builder.ts                    # runPipeline()
│   └── types.ts
├── cache/
│   ├── index.ts
│   ├── cache.ts                      # createRedisCache()
│   ├── keys.ts
│   ├── ttl.ts
│   └── types.ts
├── coordination/
│   ├── index.ts
│   ├── client.ts                    # createCoordinationClient()
│   ├── types.ts · errors.ts · utils.ts · scripts.ts
│   ├── lease.ts · lock.ts · semaphore.ts
│   ├── single-flight.ts · leader-election.ts · job-claim.ts
│   ├── resource-lease.ts · barrier.ts · fencing.ts
│   └── singleton-scheduler.ts
├── resilience/
│   ├── index.ts
│   ├── connection-manager.ts
│   ├── events.ts
│   ├── expiration-manager.ts
│   ├── local-store.ts
│   ├── operation-store.ts
│   ├── policy.ts
│   ├── recovery-coordinator.ts
│   └── types.ts
├── resilient-redis.ts                # createResilientRedis()
├── rate-limit/
│   ├── index.ts
│   ├── types.ts · errors.ts · limiter.ts · quota.ts
│   ├── concurrency.ts · adaptive.ts · load-shedding.ts
│   ├── backpressure.ts · multi.ts · burst.ts
│   ├── scripts.ts
│   └── internal/{keys.ts,time.ts,validation.ts}
├── features/
│   ├── index.ts
│   ├── stores.ts                    # auth refresh/session/state stores
│   ├── scheduled.ts                 # scheduled session revocation
│   ├── retry.ts                      # re-exports client retry
│   └── core-helpers.ts              # keys, codec, ttl, CAS, capabilities, cluster client
├── jobs/
│   └── at-least-once.ts             # optional at-least-once facade + DLQ
└── rate-limit internal not separately loadable (see subpath surface)
```

This is a target structure. Move code only when separation improves cohesion or testability. Do not invent a generic `timeout` utility that obscures the distinct cancellation and settlement semantics of each operation.

---

## 5. Public entry points

| Entry point | Responsibility | May depend on |
|---|---|---|
| `@oneunit/redis` | Convenient root API | Client, queue, pipeline, logging, features, resilience, coordination, cache, rate-limit, jobs |
| `@oneunit/redis/client` | Client factory, events, health, shutdown, sentinel, transaction, retry | ioredis only |
| `@oneunit/redis/queue` | Queue, Worker, QueueEvents factories, lifecycle, DLQ | bullmq + ioredis types |
| `@oneunit/redis/pipeline` | Labelled pipeline execution | ioredis |
| `@oneunit/redis/features` / `@oneunit/redis/auth` | Auth-store adapters, scheduled revocation, retry re-export, core helpers, cache re-export | ioredis + `@oneunit/auth` (auth optional) |
| `@oneunit/redis/resilience` | Resilience engine, connection/local/operation stores, recovery | ioredis + logger |
| `@oneunit/redis/coordination` | Distributed locks, semaphores, leases, election, barriers, fencing, singleton scheduler, job claims | ioredis |
| `@oneunit/redis/cache` | Redis-backed cache, L1, write-behind, SWR, invalidation | ioredis + pipeline |
| `@oneunit/redis/rate-limit` | Distributed limiters, quotas, concurrency, burst, multi, adaptive, load-shed, backpressure | ioredis + coordination |

### Export rules

- Every documented subpath has matching ESM runtime and TypeScript declaration targets.
- No wildcard exports that leak internal modules.
- Internal helpers (timeout, redaction, lifecycle bookkeeping) stay private unless a real consumer need is demonstrated.
- Optional auth must be reflected accurately in `package.json` (optional peer or separate package). Claiming “optional” while always installing it is a contract violation.
- Document and CI-test the minimum supported Node.js version.
- Prefer keeping `ioredis` and `bullmq` as direct dependencies while the package constructs their objects. Revisit only if supporting consumer-owned major versions becomes an explicit goal.

---

## 6. Redis client lifecycle

`createClient()` returns a **native ioredis instance**. It does not proxy, subclass, or restrict commands.

### Creation flow

```mermaid
sequenceDiagram
    participant App as Application
    participant Factory as createClient
    participant Redis as ioredis
    participant Log as Logger

    App->>Factory: options, optional logger
    Factory->>Factory: Normalize URL / options / env fallback
    Factory->>Redis: Construct client
    Factory->>Log: Register safe event listeners (incl. error)
    Factory-->>App: Native Redis instance
    Note over App,Redis: lazyConnect defaults to true
```

### Defaults and configuration

| Setting | Default | Rationale |
|---|---|---|
| `lazyConnect` | `true` | Avoid import-time connection side effects |
| `maxRetriesPerRequest` | `null` | Required for BullMQ-compatible usage |
| URL resolution | Explicit URL > `REDIS_URL` > error/validate | Never silently fall back to localhost on misconfiguration |
| `keyPrefix` | Reject or strongly document incompatibility with BullMQ | Use BullMQ `prefix` instead |

Rules:

- Accept a URL string if it is part of the documented API; pass it via ioredis’s URL constructor signature.
- Validate malformed inputs early. A likely configuration mistake must not become an unintended localhost connection.
- Never log the full connection URL or credentials.
- Document that overriding `maxRetriesPerRequest` can make the client incompatible with BullMQ workers.

### Ownership matrix

| Factory | What is owned | Who closes it | What is *not* closed |
|---|---|---|---|
| `createClient()` | Returned ioredis client | Application via `shutdown(client)` or equivalent | — |
| `createQueue()` | Queue instance | Caller | Application’s original client |
| `createWorker()` | Worker + its blocking connection | Caller | Application’s original client |
| `attachQueueEvents()` | QueueEvents wrapper + its connection | Caller | Application’s original client |
| `shutdown(client)` | Only the supplied client | Package (idempotent) | Any BullMQ objects |

BullMQ may duplicate a supplied connection for blocking use. Closing a Worker or QueueEvents closes *its* owned connection, not the application client.

If a future managed-resource API is added, it must track only resources *it* creates and must never silently take ownership of caller-provided clients.

### Optional client capabilities

- `createSentinelClient()` builds an ioredis client from a Sentinel configuration.
- `runTransaction()` wraps native MULTI/EXEC with timeout and per-step error classification.
- `createClient()` may be configured with `resilience`, `fallback`, `recovery`, job-at-least-once, or direct resilience fields; when configured it returns a `ResilientRedisFacade`-compatible proxy.
- Native client remains primary unless resilience is explicitly enabled; helper support is limited to the documented command set.

---

## 7. Logging and error redaction

One logger contract. One normalization layer. Logger injection is optional; the default is a silent no-op. A console adapter may be offered for convenience but must never be selected unexpectedly in production.

### Rules

1. Always register an ioredis `error` listener—even with no logger—to prevent process crashes from unhandled `error` events.
2. Normalize supported logger signatures in one place. Isolate pino (or similar) argument-order handling and cover it with tests.
3. Redact *before* any log or public error surface.
4. Preserve useful diagnostics: error class, safe message, operation name, connection state.
5. Strip: passwords, tokens, credential-bearing URLs, sensitive command arguments (e.g. `AUTH`, `HELLO`).
6. Do **not** log raw queue job data by default. If needed, require an explicit option with a documented warning and a redaction hook.
7. Test redaction on every path that can surface errors: events, rejected promises, queue events, pipeline, shutdown.

### Redaction test matrix (minimum)

| Input | Expected outcome |
|---|---|
| URL with password | Password removed / replaced |
| Nested `cause` with credentials | Cause sanitized |
| `AUTH` / `HELLO` command args | Args redacted |
| Job payload containing tokens | Not logged unless opt-in + redacted |

---

## 8. Health checks

`health(client, { timeout })` performs a bounded `PING` and returns a documented result: `up` + latency, or `down` + latency + safe error summary.

```mermaid
sequenceDiagram
    participant Caller
    participant Health
    participant Redis

    Caller->>Health: health(client, timeout)
    Health->>Redis: PING
    alt Reply before deadline
        Redis-->>Health: PONG
        Health-->>Caller: { status: "up", latencyMs }
    else Error or deadline
        Health-->>Caller: { status: "down", latencyMs, error: SafeError }
    end
```

### Required behavior

- The returned promise **must settle** within the configured deadline, even while ioredis is reconnecting and queueing commands offline.
- Clear the timer on every settled path (success, error, timeout).
- Validate timeout values once: non-finite, zero, or negative → documented default **or** clear validation error. Choose one policy and test it consistently.
- **Do not claim cancellation.** A Promise race only bounds the caller’s wait. The PING may still complete or remain queued later. Document this distinction in the public API.
- Timer `ref`/`unref` behavior must be deliberate and tested. If the deadline must deliver a result while the process is otherwise idle, the timer must keep the event loop alive.
- Health checks must not mutate client configuration or disconnect a shared application client.

---

## 9. Graceful shutdown

`shutdown(client, { timeout })` is **idempotent** and **bounded**.

### Lifecycle

1. If the client is already ended or was previously force-closed by this package → return immediately (idempotent).
2. Attempt graceful `QUIT`; allow pending replies to complete.
3. If the graceful deadline expires → force disconnect to stop reconnect attempts.
4. Treat a connection that closes during shutdown as an expected terminal condition.
5. Log only sanitized diagnostics for unexpected failures.
6. Record forced closure in package-owned state (e.g. `WeakSet`), never by mutating the public Redis instance.

### Contract (recommended)

- **Resolve** when the connection is definitively closed (gracefully or forcibly).
- **Reject** only when the package cannot establish that teardown completed.
- A timeout bounds how long `shutdown()` waits; it does **not** prove every pending operation succeeded.

Document the chosen contract and test it. Do not register process signal handlers inside the library; applications own signal handling and shutdown ordering (workers → QueueEvents → queues → base client).

---

## 10. BullMQ queue subsystem

Factories construct **native BullMQ objects** and apply documented defaults without hiding BullMQ behavior.

### Factories

| Factory | Responsibility |
|---|---|
| `createQueue()` | Queue with documented prefix and job defaults |
| `createWorker()` | Worker; forward only defined options (concurrency only if supplied) |
| `attachQueueEvents()` | Managed event logging; returns a closable object |

### Option merge semantics

- Never pass absent options as explicit `undefined` if that overwrites a library default.
- Merge `defaultJobOptions` **per key** so overriding one option preserves unrelated defaults.
- Preserve intentional `null` values when the underlying library assigns meaning to them.
- Prefer a clearly specified shallow / per-key merge over silent deep-merge of arbitrary nested options.
- Derive QueueEvents prefix from the Queue’s effective options when no override is supplied.
- Validate only options the wrapper owns; leave the rest to BullMQ unless a concrete integration bug justifies extra validation.

### Connection and close behavior

- Workers and QueueEvents require blocking connections and may duplicate a supplied ioredis client. Document and test this.
- `close()` failure handling must prefer public error types over message matching.
- Any compatibility fallback for duplicate package copies belongs in one isolated helper, tested against supported BullMQ versions.
- Forced-close workarounds must be narrowly scoped, must not reach into undocumented internals without a compatibility test, and must not leave orphaned reconnect loops.

### Event payload safety

Default queue event logs to **metadata only**: queue name, job ID, event name, duration, sanitized failure reason.  
Raw job payloads are excluded by default (they may contain PII, credentials, or secrets). Opt-in logging must be explicit and redacted.

---

## 11. Pipeline subsystem

`runPipeline()` is a labelled orchestration helper over ioredis’s native pipeline. It is **not** a transaction and does **not** make a batch atomic.

### Contract

- Each step has a stable label and synchronously queues exactly one command.
- An asynchronous step is rejected **before** `EXEC`.
- A step that throws aborts batch construction; a partially constructed pipeline must never execute accidentally.
- Results are mapped to labels by position.
- Each step result distinguishes a successful `null` from a command error.
- Connection-level `exec()` rejection follows one documented contract and is sanitized where required.
- A configurable deadline bounds the caller’s wait; it does not cancel a command already sent to Redis.
- `throwOnError` behavior is explicit. A non-throwing mode returns per-command failures; a strict helper (e.g. `pipelineValues()`) can throw on any failure.
- Never return raw command errors if the API promises redaction.

### Suggested result shape

```ts
type SafeError = {
  name: string;
  message: string;
  // no credentials, no raw command args
};

type PipelineStepResult<T = unknown> = {
  label: string;
  value: T | null;
  error?: SafeError;
};

type PipelineResult = {
  results: PipelineStepResult[];
  durationMs: number;
  failed: boolean;
};
```

Preserve existing public types unless a change is required; any public type change needs a compatibility review.

### Implementation safeguards

Checking pipeline queue length before and after each step guards against multi-command or zero-command steps. This relies on ioredis internals that may be version-sensitive—pin the behavior with compatibility tests and isolate the check behind a small helper. Test both synchronous throws and async callbacks that return a promise.

---

## 12. Optional authentication stores

Auth-store adapters are **integration features**, not core Redis functionality.

- Keep refresh-token, session, and state stores in separate modules; share contracts only where implementations genuinely share behavior.
- Use `@oneunit/auth` interfaces as the source of truth; do not duplicate interface definitions.
- Document: key namespaces, TTL semantics, serialization format, and behavior when Redis is unavailable.
- Never log stored values, tokens, session contents, or raw keys if keys contain sensitive identifiers.
- Decide explicitly: fail closed, fail open, or propagate. Security-sensitive session/refresh operations must **not** silently succeed when persistence failed.
- Test: expiry, missing records, malformed values, concurrent updates, Redis outages.
- Delayed operations, when offered, must receive an explicit caller-owned queue/connection, never create hidden workers or bypass Redis TTL.
- Keep auth-store exports out of client and queue subpaths.

---

## 13. Error model

Prefer stable package error classes for errors the package itself creates:

| Error | When used |
|---|---|
| `HealthCheckTimeoutError` | Health deadline exceeded |
| `ShutdownTimeoutError` | Only if the chosen contract rejects on timeout |
| `PipelineTimeoutError` | Pipeline deadline exceeded |
| `PipelineStepError` | Step construction failed (async step, throw, multi-command) |
| `PipelineCommandError` / safe error shape | Per-command failure when needed by public API |

Rules:

- Do not automatically wrap every third-party error.
- Preserve the original cause internally where supported.
- Ensure public and logged representations never expose credentials.
- Document which functions throw, which return failure results, and which treat expected terminal conditions as success.

---

## 14. Testing strategy

Layered tests. CI must prove that integration tests actually ran.

### Unit tests

- URL normalization, env fallback, invalid inputs.
- Default options and caller override precedence.
- Omission of undefined options vs intentional `null`.
- Logger normalization for every supported shape.
- Credential redaction (URLs, AUTH/HELLO, nested causes).
- Timeout validation and deadline cleanup.
- Pipeline one-command-per-step validation.
- Idempotent shutdown and forced-close bookkeeping.

### Integration tests (real Redis required)

- Client connects and executes commands.
- Health returns `up`; returns `down` within deadline when Redis is unavailable.
- Queue creation, job defaults, retries, backoff, retention, worker concurrency.
- QueueEvents with custom prefixes.
- Worker and QueueEvents close their owned connections.
- Pipeline maps values, nulls, and command errors correctly.
- Auth stores enforce TTL and expected failure semantics.

### Package-consumer (tarball) tests

Install the generated tarball into a clean fixture and verify:

- Every documented subpath imports successfully.
- ESM runtime exports and TypeScript declarations resolve.
- `@oneunit/redis/client` does not load BullMQ.
- Base entry points do not require the optional auth integration.
- Source maps resolve to files included in the package.
- The installed package works without access to the repository’s `src/` or `node_modules`.

### CI rules

| Rule | Enforcement |
|---|---|
| Unit tests may run without Redis | Only when they truly need no Redis |
| Integration tests require a live Redis | Fail the job if Redis is unavailable; never silently skip the suite in CI |
| Local skip is allowed | Print an explicit skip summary; must not be the release gate |
| Full gate | build → typecheck → unit → integration → pack → tarball smoke |
| No concurrent `dist/` mutation | Avoid deleting/rebuilding while workers import it |
| Regression tests must fail when the bug is reintroduced | Especially timeouts, redaction, lifecycle |

---

## 15. Packaging and release

- Clean `dist/` and incremental compiler metadata before every release build.
- Include source files if source maps point to them; otherwise configure maps so they resolve without shipping unnecessary files.
- Validate `exports`, `files`, `types`, `main`, and `module` against the actual emitted files.
- Test the packed tarball, not only `npm pack --dry-run`.
- Avoid running `prepack` in a test that is meant to inspect an already-built artifact if that script rewrites `dist/`.
- Pre-publish checklist: license, README, changelog, engines, dependency versions, tarball contents, clean-consumer install.
- Publish only after the full CI release gate passes with evidence, not after a green local run alone.

---

## 16. Observability

Provide useful hooks without forcing an observability stack.

- Logger injection remains optional.
- Lifecycle or metrics callbacks are acceptable only when real consumers need them.
- No mandatory metrics dependency.
- Never use high-cardinality labels (raw keys, user IDs, job payloads, full URLs) in metrics.
- Document which events are emitted and whether handlers can affect application behavior.

---

## 17. Compatibility and versioning policy

| Concern | Policy |
|---|---|
| Supported Node.js | Document minimum; CI tests the minimum |
| ioredis / BullMQ | Pin tested major ranges; compatibility tests on supported versions |
| Public API breakage | Semver major; changelog entry required |
| Subpath addition | Minor (additive) |
| Subpath removal or behavior change | Major |
| Optional auth dependency | Must remain optional across minor versions |
| Timeout / ownership contract changes | Major (these are behavioral contracts) |

---

## 18. Risks and trade-offs

| Decision | Benefit | Cost / caveat |
|---|---|---|
| Native ioredis / BullMQ objects | Low abstraction, full compatibility | Consumers must understand library semantics |
| `lazyConnect: true` | No construction-time side effect | Startup readiness is explicit |
| `maxRetriesPerRequest: null` | BullMQ worker compatible | Unbounded waits without wrapper deadlines |
| Bounded health / pipeline / shutdown | Avoids hung callers | Timeout does not cancel the Redis operation |
| Separate subpath exports | Smaller dependency surface | Export maps and consumer tests need maintenance |
| Optional auth adapter | Core stays reusable | Metadata and install behavior must match the claim |
| Job payload logging off by default | Reduces accidental data exposure | Debugging requires explicit, controlled opt-in |

---

## 19. Recommended implementation order

### Phase 1 — Lock down existing contracts

| Step | Acceptance criterion |
|---|---|
| Tests for exports, option merging, redaction, timeouts, shutdown, QueueEvents prefixes | Fail when the contract is violated |
| Document ownership and exact resolve/reject behavior of every lifecycle method | Docs match tests |
| Verify dependency metadata vs actual imports and optional feature behavior | `client` install does not pull auth; auth is optional |
| CI fails if required Redis integration tests do not run | Integration job cannot be green without Redis |

### Phase 2 — Extract shared primitives only where justified

| Step | Acceptance criterion |
|---|---|
| Centralize safe error formatting / redaction | Single implementation; all paths covered |
| Centralize logger normalization | One module; all supported shapes tested |
| Introduce timeout helper only if semantics are shared | No generic utility that obscures per-operation behavior |
| Keep internal helpers private | No accidental public export |

### Phase 3 — Harden BullMQ lifecycle

| Step | Acceptance criterion |
|---|---|
| Test ownership of Worker and QueueEvents blocking connections | Closing them does not close the app client |
| Validate close behavior on every supported BullMQ version | Compatibility suite green |
| Remove broad / undocumented internal workarounds where a public API exists | Prefer public APIs |
| Default queue event logs to metadata-only | No raw payloads without opt-in |

### Phase 4 — Verify release artifact

| Step | Acceptance criterion |
|---|---|
| Clean-tree build | No stale `dist/` |
| Typecheck + all unit/integration tests | Green |
| Pack + install tarball into clean consumer fixture | All subpaths work |
| Subpath isolation, declarations, source maps verified | Documented surface matches reality |
| Publish only after full release gate | Evidence from CI, not local only |

---

## 20. Definition of done

The architecture is ready when **all** of the following are true:

- [ ] Each subpath has a documented and tested dependency boundary.
- [ ] Resource ownership and shutdown ordering are unambiguous and tested.
- [ ] Every promised bounded operation settles within its deadline under success, failure, and Redis-unavailable conditions.
- [ ] Timeout behavior is never described as cancellation.
- [ ] Credentials and sensitive job data are not logged by default; redaction is tested on all exposure paths.
- [ ] Queue option merging preserves defaults and intentional overrides (including `null`).
- [ ] Pipeline results cannot become misaligned with labels; one-command-per-step is enforced.
- [ ] Redis integration tests are mandatory in CI and fail the job when Redis is missing.
- [ ] The packed package works in a clean consumer project for every documented entry point.
- [ ] Public API changes are intentional, versioned, documented, and covered by compatibility tests.
- [ ] Optional auth remains optional in both metadata and install behavior.
- [ ] Optional coordination, cache, rate-limit, resilience, and job-processing modules remain subpath-isolated.
- [ ] Core helper primitives remain thin and dependency-light.

---

## 20.5 Resilience engine (optional)

The resilience engine is an optional, process-local layer. It must remain an optional feature,
not a mandatory dependency, and must preserve thin integration principles.

- Configuration lives in `createClient({ resilience, fallback, recovery, ... })` or `createResilientRedis(client, config)`.
- Healthy commands execute directly against ioredis.
- Outage detection uses connection events and connection-failure command errors; ordinary Redis command errors do not activate fallback.
- Eligible degraded reads use the process-local store (`HIT`, `MISS`, or `UNKNOWN`), and eligible writes are journaled with bounded limits.
- Reconnection automatically runs a single shared recovery loop; manual recovery is diagnostic.
- Pending operation age and storage limits are enforced; overflow is rejected rather than silently discarding queued work.
- Shutdown clears pending/local state, waits for active recovery, and preserves caller ownership unless configured otherwise.
- No cross-instance coordination or crash durability is claimed.

## 20.7 Job processing (optional)

Optional at-least-once processing is implemented through BullMQ rather than a separate custom queue engine.

- Disabled by default and inactive when disabled.
- Enabled feature creates a BullMQ queue; workers are created explicitly by the caller.
- Retries, backoff, stalled-job handling, persistence, and completion semantics remain BullMQ's.
- At-least-once semantics are documented, including possible duplicate handler execution.
- Shutdown closes owned worker, event, and queue resources in order.

## 20.8 Rate limiting & traffic control (optional)

The rate limiting module is an optional, distributed traffic control layer built on Redis atomic Lua scripts. It is exposed via `@oneunit/redis/rate-limit` and does not change the default behavior of the base client.

### Scope

| Capability | Type | Distribution | Status |
|------------|------|--------------|--------|
| Fixed Window | Rate Limiter | Distributed | ✅ Verified |
| Sliding Window | Rate Limiter | Distributed | ✅ Verified |
| Token Bucket | Rate Limiter | Distributed | ✅ Verified |
| Leaky Bucket | Rate Limiter (Policing) | Distributed | ✅ Verified |
| Multi-Dimensional | Composable | Distributed | ✅ Verified |
| Weighted Requests | All algorithms | Distributed | ✅ Verified |
| Concurrency | Semaphore | Distributed | ✅ Verified |
| Daily/Monthly Quotas | Calendar | Distributed | ✅ Verified |
| Burst Protection | Multi-layer | Distributed | ✅ Verified |
| Retry-After Metadata | All | Distributed | ✅ Verified |
| Fail-Open/Fail-Closed | All | Distributed | ✅ Verified |
| Adaptive Throttling | Local | Local-only | ⚠️ Local |
| Load Shedding | Local | Local-only | ⚠️ Local |
| Backpressure | Local | Local-only | ⚠️ Local |

### Design Principles

1. **Atomic by default** — Every operation executes in a single Lua script; no read-modify-write races.
2. **Distributed state** — All counters, permits, and quotas live in Redis; multiple application instances share limits.
3. **Observable decisions** — Every call returns rich metadata (remaining, retry-after, reset timestamp, algorithm, reason, fallback flag).
4. **Explicit failure policy** — `fail-open` (allow on Redis failure) or `fail-closed` (deny) per limiter.
5. **Subpath isolation** — Importing `@oneunit/redis/rate-limit` does not load BullMQ or queue subsystem.

### Architecture

```mermaid
flowchart TD
    RateLimit["rate-limit<br/>limiter · quota · concurrency · burst · multi · adaptive · loadshed · backpressure"]
    Core["core<br/>types · errors · validation · time · keys"]
    Scripts["scripts<br/>Lua scripts per algorithm"]
    Coord["coordination<br/>semaphore · lease · fencing"]
    Client["client<br/>ioredis factory"]
    Redis["ioredis"]

    RateLimit --> Core
    RateLimit --> Scripts
    RateLimit --> Coord
    RateLimit --> Client
    Coord --> Client
    Client --> Redis
```

### Boundary Rules

| Rule | Rationale |
|------|-----------|
| `rate-limit/` never imports `queue/` or `pipeline/` | Keeps rate limiting free of queue weight |
| `rate-limit/` may import `coordination/` (semaphore) | Semaphore is a shared distributed primitive |
| Root `index.ts` re-exports `rate-limit` subpath | Optional feature, additive surface |
| Lua scripts are internal | No public API depends on script signatures |

### Lua Script Safety

- All scripts use `redis.call('TIME')` for server-side timestamps (no client clock dependency).
- Keys use hash tags `{resource}` for Redis Cluster compatibility.
- TTLs are set on every write; expired keys auto-cleaned.
- Scripts validate inputs (positive finite costs, capacity bounds) before mutating state.

### Failure Handling

| Policy | Behavior | Use Case |
|--------|----------|----------|
| `fail-closed` (default) | Throws `RateLimitError` on Redis failure | Strict protection (payments, auth) |
| `fail-open` | Returns `allowed: true, fallback: true` with error in metadata | Graceful degradation (analytics, non-critical) |

⚠️ **Known limitation:** `fail-open` catches all errors including programming errors. Should only catch operational Redis failures.

### Testing Requirements

- Unit tests: validation, metadata shapes, algorithm config merge.
- Integration tests (real Redis): atomicity under concurrency (1000 parallel), boundary conditions, window rollover, lease expiration, fail-open/closed.
- Stress tests: sustained load, mixed check/consume, weighted requests.
- Cluster key safety: hash tag verification, CROSSSLOT checks.
- Lifecycle: idempotent shutdown, no cross-test state leakage, no unhandled rejections.

## 20.9 Coordination (optional)

Optional distributed coordination primitives over Redis Lua scripts and atomic compare-and-set. Exposed via `@oneunit/redis/coordination`; never imported by the base client subpath.

### Capabilities

| Factory / helper | Responsibility |
|---|---|
| `createCoordinationClient()` | Top-level client wrapper with key prefix, logger, typed sub-managers |
| Lock manager | Distributed lock acquire/renew/release with fencing tokens |
| Semaphore manager | Counting permits with acquire/release/renew/status |
| Lease manager | Time-bound ownership lease |
| Resource lease manager | Lease wrapper over a resource with epoch fencing |
| Single-flight manager | Dedupe concurrent same-key execution |
| Leader election | Term-based leader acquisition/loss and status |
| Job claim manager | At-least-once-ish job claim/complete/release |
| Barrier coordinator | Arrive-and-wait synchronization across participants |
| Fencing helpers | Validate/compare/bump fencing tokens |
| Singleton scheduler | One-owner periodic task scheduling |
| Coordination utils | Key builders, validation, timeouts, Lua result parsing, time helpers |

### Design principles

1. Redis remains the source of truth; ownership is explicit via tokens/epochs.
2. Operations are bounded by caller-provided deadlines where documented; `sleep` supports `AbortSignal`.
3. Lua scripts use `redis.call('TIME')` for server timestamps and hash tags for cluster safety.
4. Errors are stable `CoordinationError` subclasses with type guards.
5. No hidden scheduler or worker is started by import; callers own lifecycle.

## 20.10 Caching (optional)

Optional Redis-backed cache layer over the pipeline subsystem. Exposed via `@oneunit/redis/cache` and re-exported from `@oneunit/redis/features`.

### Capabilities

| Feature | Behavior |
|---|---|
| `createRedisCache()` | Factory returning cache API |
| `get` / `set` | JSON-serialized records with optional TTL |
| `getOrLoad` / `remember` / `wrap` | Cache-aside with stampede protection |
| Negative caching | Cache null/missing results for configured TTL |
| Stale-while-revalidate | Serve stale values while refreshing in background |
| Tag invalidation | Invalidate groups by tag; track invalidation tokens |
| L1 local cache | Optional process-local Map with LRU/LFU/FIFO/random eviction and size policies |
| Write-behind | Dirty-entry buffering with periodic flush, limits, and error callback |
| Metrics / reset | Hits, misses, hit rate, L1 and write-behind counters |
| Shutdown | Flush pending write-behind, clear timers and L1 state |

### Design principles

1. Backed by Redis via `runPipeline()`; no transactional/atomic multi-key guarantees beyond pipeline execution.
2. Invalidation tokens and in-flight loading maps prevent stale repopulation after invalidation.
3. Write-behind is opt-in and bounded; errors are surfaced via callback and metrics.
4. L1 cache is process-local only; cluster-wide invalidation requires caller coordination.
5. Serialization is JSON; complex types must be serializable.

## 20.11 Core helper primitives (optional)

The package ships dependency-light helper primitives, exposed through `@oneunit/redis/features` (core helpers) and partially documented in section 21. Includes:

- Key/namespace builder (`buildKey`) with null/empty validation.
- JSON encode/decode helpers (`serialize`, `deserialize`).
- TTL jitter (`jitterTtl`).
- Conditional writes (`setIfAbsent`, `compareAndSwap`).
- Capability probing (`detectCapabilities`, `createClusterClient`).

These are thin wrappers and must not become a cache, repository, serializer framework, or required runtime manager.

## 20.12 Resilient client facade

`createResilientRedis()` wraps an existing ioredis client and converts a supported subset of commands into `ResilienceOperation`s. When Redis is connected, commands run directly; connection failures mark the engine degraded and eligible operations follow local fallback/buffer/recovery policy. Optional at-least-once job processing can be attached through the same factory/client options.


## 20.13 Complete Feature Implementation Matrix

This section documents every feature shipped by the package, cross-referenced with the FEATURES.md matrix. Status: ✅ = dedicated API/contract, ⚠️ = pass-through or partial abstraction, ❌ = not implemented.

### 20.13.1 Core Redis Infrastructure

| Feature | Status | Implementation |
|---|---|---|
| Connection management — connect, reconnect, disconnect, lifecycle hooks | ✅ | `createClient`, `attachEvents` (`connect`, `ready`, `reconnecting`, `error`, `close`), `shutdown` |
| Client adapters — ioredis adapter | ✅ | Native `ioredis` client constructed and returned |
| Connection profile — standalone | ✅ | `createClient` returns standalone `Redis` client |
| Connection profile — Sentinel | ✅ | `createSentinelClient` plus pass-through options; config validation tested |
| Connection profile — Cluster | ✅ | Optional `createClusterClient` exported; basic connection tested |
| Namespace management — application, environment, service, tenant prefixes | ✅ | Optional `buildKey` and key validation |
| Key builder — consistent keys, validation, hash-tag support | ✅ | Optional `buildKey` |
| Serialization — JSON, strings, typed codecs, versioning | ✅ | Optional `serialize` / `deserialize` |
| TTL management — default TTLs, expiration, TTL jitter | ✅ | Raw commands plus optional `jitterTtl` |
| Atomic operations — transactions | ✅ | `runTransaction` wrapper with labelled steps, timeout, typed results |
| Atomic operations — conditional writes | ✅ | Optional `setIfAbsent` / `compareAndSwap` |
| Pipelines — batch commands, reduced round trips | ✅ | `runPipeline`, `pipelineValues`, labeled results, timeout, redaction |
| Error handling — typed errors | ✅ | Typed pipeline/timeout/step errors plus `classifyError`, `isRetryable`, `attachErrorHandling` |
| Error handling — timeout classification | ✅ | Health, pipeline, and shutdown are bounded |
| Error handling — retry policies | ✅ | ioredis/BullMQ pass-through plus optional `retryOperation` helper |
| Health checks — liveness, readiness, connectivity | ✅ | `health()` with bounded `PING` |
| Graceful shutdown — stop workers, close subscriptions, release connections | ✅ | `shutdown()`, queue/worker close guidance |
| Configuration validation — URLs, credentials, TLS, timeouts | ✅ | URL, `keyPrefix`, concurrency, TTL, and store validation |
| Capability detection — supported commands and Redis features | ✅ | Optional `detectCapabilities` |
| Resilience engine — transparent resilient client | ✅ | `createResilientRedis` and `createClient({ resilience, fallback, recovery })` |
| Job processing — optional at-least-once BullMQ integration | ✅ | `jobAtLeastOnce`, BullMQ queue/worker wrappers, retries, backoff, graceful shutdown |

### 20.13.2 Resilience Engine (detailed)

| Feature | Status | Implementation |
|---|---|---|
| In-memory buffering during Redis outages | ✅ | `createResilienceEngine`, bounded operation store, TTL-preserving recovery |
| Operation fallback policy | ✅ | Eligible commands buffered, non-idempotent/unsafe commands rejected |
| Bounded memory | ✅ | Max operation count, max payload bytes, max per-operation size, overflow policy |
| TTL preservation | ✅ | Absolute deadlines preserved across outage, remaining TTL applied on recovery |
| Single-worker recovery | ✅ | One recovery coordinator per process, per-key ordering, bounded retries |
| Ambiguous outcome handling | ✅ | Non-idempotent commands report AMBIGUOUS rather than blindly replaying |
| Degraded-mode local reads | ✅ | Eligible reads served from local state (HIT/MISS/UNKNOWN) during outage |
| Degraded-mode local writes | ✅ | Eligible mutations applied locally and journaled for reconciliation |
| Local tombstones | ✅ | Deletions recorded as tombstones, preventing stale reads |
| Local TTL preservation | ✅ | Original TTL deadlines preserved, remaining TTL served on read |
| Bounded local store | ✅ | Max entries, max payload bytes, max entry size, overflow policy |
| Read-your-writes | ✅ | Same-process local reads observe prior local mutations |
| Conflict detection | ✅ | Recovery detects keys modified by other writers; configurable policy |
| Shutdown reporting | ✅ | Shutdown reports discarded pending operations and local entries |
| Multi-instance | ❌ | Process-local only; no cross-instance shared state |
| Crash durability | ❌ | In-memory state lost on process crash |
| Local state cleared on shutdown | ✅ | `shutdown()` clears local store and stops connection |

### 20.13.3 Caching Infrastructure

| Feature | Status | Implementation |
|---|---|---|
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
| Recommended public API | ✅ | `get`, `set`, `getOrLoad`, `remember`, `invalidate`, `invalidateTag`, `wrap`, `warm`, `writeThrough`, `flushWriteBehind`, `writeBehindStats`, `l1Stats`, `clearL1`, `evictL1`, `shutdown` |

### 20.13.4 Rate Limiting, Quotas, and Traffic Control

| Feature | Status | Implementation |
|---|---|---|
| Fixed-window limiter | ✅ | `@oneunit/redis/rate-limit` |
| Sliding-window limiter | ✅ | |
| Token bucket | ✅ | |
| Leaky bucket | ✅ | |
| Multi-dimensional limiting | ✅ | |
| Weighted rate limiting | ✅ | |
| Concurrency limiter | ✅ | |
| Distributed semaphore | ✅ | |
| Daily/monthly quotas | ✅ | |
| Burst protection | ✅ | Sustained fixed-window + burst token-bucket, optional concurrency semaphore |
| Retry-after calculation | ✅ | |
| Rate-limit metadata | ✅ | |
| Fail-open/fail-closed policy | ✅ | |
| Adaptive throttling | ✅ | |
| Load shedding | ✅ | |
| Backpressure | ✅ | |

### 20.13.5 Distributed Coordination and Locking

| Feature | Status | Implementation |
|---|---|---|
| Distributed mutex | ✅ | `@oneunit/redis/coordination` |
| Lease-based lock | ✅ | |
| Lock renewal | ✅ | |
| Safe lock release | ✅ | |
| Lock timeout | ✅ | |
| Try-lock | ✅ | |
| Lock with callback | ✅ | |
| Distributed semaphore | ✅ | |
| Single-flight execution | ✅ | |
| Leader election | ✅ | |
| Singleton scheduler | ✅ | |
| Job claiming | ✅ | |
| Fencing tokens | ✅ | |
| Resource leases | ✅ | |
| Distributed barriers | ✅ | |

### 20.13.6 Queues and Background Jobs

| Feature | Status | Implementation |
|---|---|---|
| Queue factory | ✅ | `createQueue` |
| Worker factory | ✅ | `createWorker` |
| Scheduled jobs | ✅ | Delayed jobs via BullMQ |
| Recurring jobs | ✅ | `scheduleJob` / `removeJobScheduler` / `getJobSchedulers` wrappers |
| Retry and backoff policies | ✅ | Defaults + override merge |
| Job priorities | ⚠️ | BullMQ `priority` option |
| Job deduplication | ⚠️ | BullMQ `jobId` / deduplication pass-through |
| Concurrency controls | ✅ | `WorkerConfig.concurrency` |
| Job cancellation | ✅ | `cancelJob`/`cancelWorkerJob` wrappers |
| Job progress | ✅ | `getJobProgress` wrapper plus native progress |
| Job result storage | ✅ | `getJobResult` wrapper plus native BullMQ return values |
| Dead-letter handling | ✅ | `createDlqQueue`, `moveToDlq`, `replayDlqJob`, `getDlqEntries` |
| Stalled-job recovery | ✅ | BullMQ built-in |
| Graceful draining | ✅ | `worker.close(true)`, `queue.close()` |
| Queue pause/resume | ✅ | `pauseQueue`/`resumeQueue` wrappers |
| Queue rate limiting | ✅ | `WorkerConfig.limiter` |
| Delayed execution | ✅ | Job `delay` |
| Dependency workflows | ✅ | `createFlowProducer`, `addFlow`, `addBulkFlows` wrappers |
| Batch jobs | ✅ | `addBulkJobs`/`enqueueBulkJobs`/`addBulkFlows` high-level wrappers |
| Bulk enqueueing | ✅ | `addBulkJobs`/`enqueueBulkJobs`/`addBulkFlows` wrappers |
| Job retention policies | ✅ | Defaults (`removeOnComplete`, `removeOnFail`) + override |
| Queue health metrics | ✅ | `getQueueCounts`/`getQueueHealth`/`getWorkerHealth` wrappers |
| Worker heartbeats | ✅ | BullMQ built-in |
| Queue dashboard adapter | ❌ | None |
| Higher-level additions (middleware, typed registries, error classification, tracing, per-queue policies) | ✅ | `createWorker` middleware, `createJobRegistry`/`validateJobData`, `createErrorClassifier`, `createTracingMiddleware`, policy registry helpers |

### 20.13.7 Session, Identity, and Ephemeral State

| Feature | Status | Implementation |
|---|---|---|
| Session store (shared across instances) | ✅ | `createRedisSessionStore` |
| Session expiration | ⚠️ | Auth-side TTL handling; store tracks versions/revocation |
| Session revocation | ✅ | `revokeSession` / `isSessionRevoked` |
| Session versioning | ✅ | `getVersion` / `bumpVersion` |
| One-time token consumption | ✅ | `StateStore.consume` |
| Temporary workflow state | ✅ | `createRedisStateStore` |
| Short-lived authorization state | ⚠️ | State store with TTL |

### 20.13.8 Security Infrastructure

| Feature | Status | Implementation |
|---|---|---|
| TLS configuration | ⚠️ | Pass-through ioredis options |
| Secret redaction | ✅ | `redactError` in events and shutdown |
| Redis ACL compatibility | ⚠️ | Pass-through |
| Input validation | ⚠️ | URL, `keyPrefix`, concurrency guards |
| Secure temporary tokens | ⚠️ | State store with TTL/consume |
| Security event hooks | ⚠️ | Redacted connection/error events |

### 20.13.9 Deployment and Infrastructure Integration

| Feature | Status | Implementation |
|---|---|---|
| Environment-aware configuration | ⚠️ | `REDIS_URL`, logger detection |
| Sentinel support | ✅ | `createSentinelClient` pass-through; config validation tested |
| Readiness integration | ⚠️ | `health()` helper |
| Shutdown integration | ✅ | `shutdown()` |
| Integration-test environment | ✅ | Tests run against a real Redis service container |

### 20.13.10 Idempotency and Duplicate Prevention (gaps noted)

| Feature | Status | Notes |
|---|---|---|
| Idempotency keys | ❌ | |
| Request deduplication | ❌ | |
| Job deduplication | ⚠️ | BullMQ `jobId` / deduplication options pass-through only |
| Claim/complete states | ⚠️ | `createRedisStateStore` get/set/consume lifecycle |
| Idempotency TTL policies | ⚠️ | Store keys carry TTLs |

### 20.13.11 Messaging and Event Infrastructure (gaps noted)

| Feature | Status | Notes |
|---|---|---|
| Pub/Sub publisher | ⚠️ | `client.publish` on the native client |
| Pub/Sub subscriber | ⚠️ | `subscribe` / `on("message")` on the native client |
| Redis Streams producer | ⚠️ | Raw `XADD` via the client |
| Retry and dead-letter workflow | ⚠️ | Queue-events path only |

### 20.13.12 Observability and Diagnostics (gaps noted)

| Feature | Status | Notes |
|---|---|---|
| Structured logs | ⚠️ | Normalized logger with redaction |
| Queue metrics | ⚠️ | Native BullMQ counts/metrics |
| Connection metrics | ⚠️ | Connection event logs |

### 20.13.13 Features Folder (`src/features`) — Exported API

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
| `createClusterClient(nodes, options?)` | ✅ | Optional ioredis Cluster factory; exported and connection tested |
| `retryOperation(op, policy?)` / `retryOperationWithResult` | ✅ | Configurable retry helpers with exponential backoff and jitter |
| `isRetryClassifiedError(err)` | ✅ | Type guard for retry-classified errors |
| `RetryPolicy` / `RetryResult` | ✅ | TypeScript types for retry configuration and results |



## Final recommendation

Keep `@oneunit/redis` a **thin integration package**.

Prioritize, in order:

1. **Lifecycle correctness** (ownership, idempotent shutdown, no orphaned connections)
2. **Security-safe observability** (central redaction, no payload logging by default)
3. **Precise failure contracts** (bounded waits, honest timeout semantics)
4. **Subpath isolation** (client without BullMQ; auth truly optional)
5. **Release verification** (tarball-tested, CI-enforced integration tests)

Do **not** add a connection pool, custom retry engine, cache, generic repository layer, or broad abstraction framework without a demonstrated consumer requirement and an explicit architecture revision.

## 21. Optional core helper primitives

The package may also ship dependency-free helper primitives as **optional features**:

- Key/namespace builders that validate and join key segments.
- JSON string codec helpers.
- TTL jitter helpers.
- Compare-and-swap and conditional write helpers.
- Capability probing through standard Redis commands.

These remain thin wrappers. They must not introduce a cache, repository, serializer framework, rate limiter, lock, or required process/runtime manager. Helpers with network behavior must be explicit and bounded where the contract promises it.

## 22. Real-World Test Verification

All features have been validated against a production Redis Cloud instance:

**Target**: `redis-10952.crce194.ap-seast-1-1.ec2.cloud.redislabs.com:10952` (ap-southeast-1)
**Network RTT**: ~350-450ms

### Test Suite Results (707 tests)

| Module | Tests | Status |
|---|---|---|
| Core Redis (`test/redis/`) | 40 | ✅ Pass |
| Queue/Worker (`test/queue/`) | 22 | ✅ Pass |
| Pipeline (`test/pipeline/`) | 19 | ✅ Pass |
| Cache (`test/cache/`) | 70 | ✅ Pass |
| Rate Limit (`test/rate-limit/`) | 200+ | ✅ Pass |
| Coordination (`test/coordination/`) | 28 | ✅ Pass |
| Resilience (`test/resilience/`) | 67 | ✅ Pass |
| Jobs (`test/jobs/`) | 6 | ✅ Pass |
| Scheduled (`test/scheduled/`) | 10 | ✅ Pass |
| Security (`test/security/`) | 14 | ✅ Pass |
| Auth Adapter (`test/auth-adapter/`) | 3 | ✅ Pass |
| Examples (`test/examples/`) | 2 | ✅ Pass |

### Verified Architecture Guarantees

1. **Bounded Operations**: Health checks, pipelines, shutdown all settle within configured deadlines even under 380ms RTT
2. **Credential Redaction**: Passwords stripped from `AUTH`/`HELLO` errors in client events, queue events, shutdown, and rate limiter errors
3. **Ownership Contracts**: `shutdown()` is idempotent; queue/worker close their owned connections without affecting the shared client
4. **Subpath Isolation**: `@oneunit/redis/client` loads without BullMQ; `@oneunit/redis/queue` loads without cache/coordination
5. **Queue Option Merging**: Per-key merge preserves defaults; `null` values pass through for "keep forever" semantics
6. **Pipeline Validation**: One-command-per-step enforced at runtime; async steps rejected before EXEC
7. **Distributed Primitives**: All coordination uses atomic Lua scripts with server-side timestamps (`TIME` command) and hash tags for Cluster safety

### Performance Baselines (Cloud Redis)

| Operation | Latency (p50) | Notes |
|---|---|---|
| Health check | 380ms | Includes network RTT |
| Pipeline (5 cmds) | 380ms | Single round-trip |
| Cache miss (L2) | 380ms | First read from Redis |
| Cache hit (L1) | <1ms | In-memory |
| Queue enqueue | 380ms | BullMQ add |
| Lock acquire | 380ms | Lua script |
| Semaphore acquire | 380ms | Lua script |
| Leader election | 380ms | Lua script |

### Known Limitations

- **Performance test budget**: The `health() adds negligible overhead` test (25ms budget) fails with cloud Redis due to network latency. This is expected behavior and passes with local Redis.
- **Redis Cloud permissions**: Some `INFO` command restrictions affect BullMQ readiness checks (logged as warnings, not failures).
- **TLS**: Tested with TLS disabled (`redis://`); TLS support is pass-through to ioredis.
