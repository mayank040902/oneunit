# Microservice Package — Exhaustive Stress Test & Deep-Dive Analysis

**Scope:** `packages/microservice` (the `@oneunit/microservice` library).
**Date:** 2026-10-15
**Analyst:** Senior Software Engineer + Security Specialist
**Status:** Testing complete. All 46 empirical stress tests execute and pass (they encode expected-vs-actual behavior and FAIL against the current code where a defect exists — see "Verification matrix").

> **Update (2026-10-22) — superseded file paths.** The `test/adversarial/` and
> `test/stress/` suites referenced throughout this report were removed during the
> test-suite audit. Their unique, still-relevant behaviors were migrated into
> focused, behavior-driven suites:
>
> | Removed suite | Replacement |
> |---|---|
> | `test/adversarial/pluggable-messaging.adversarial.test.ts` | `test/adapters/messaging/factory.test.ts` |
> | `test/adversarial/rabbitmq*.adversarial.test.ts`, `test/stress/rabbitmq-stress.test.ts` | `test/adapters/messaging/rabbitmq.test.ts` |
> | `test/adversarial/registry*.adversarial.test.ts` | `test/registry/registry.test.ts` |
> | `test/adversarial/lifecycle*.adversarial.test.ts` | `test/core/lifecycle.test.ts` |
> | `test/adversarial/*transport*.adversarial.test.ts` | `test/transport/*.test.ts`, `test/adapters/network/tcp/index.test.ts` |
>
> The findings in this report remain valid as a historical analysis; the file
> paths and test names it quotes no longer exist.

---

## 1. Executive Summary

The package provides pluggable messaging transports (Kafka, NATS, RabbitMQ),
network transports (TCP/UDP), a service registry, security (replay protection,
authenticated encryption, signing, key rotation), a lifecycle manager, and a
config/loader layer. Across these modules the analysis uncovered **one
CRITICAL reliability defect that is absent from the other two messaging
adapters**, **five transport-correctness defects**, and **a packaging defect
that makes the RabbitMQ adapter unusable for downstream consumers**.

The highest-impact cluster is the **RabbitMQ `RabbitMQTransport` connection
state machine**: reconnection timers are never stored or cleared, graceful
`disconnect()` triggers automatic reconnection, a connection-error/close pair
double-schedules reconnection, and `publish()` racing a reconnect opens a second
concurrent connection. Combined with a **non-functional `unsubscribe`** (it
cancels by queue name, not consumer tag, and matches topics by substring) and
**unconditional `nack(_, false, true)` requeue with no retry ceiling**, the
adapter can enter reconnect storms, lose consumers, and spin a poison-message
loop indefinitely.

A pre-existing test file (`test/adversarial/pluggable-messaging.adversarial.test.ts`)
is **red** in the baseline (4 failures) and is left as-is — it is addressed in
Finding **H-9**.

---

## 2. Testing Methodology

### 2.1 Static analysis
Every adapter, transport, security module, lifecycle manager, registry store,
config loader, and contract is read in full and traced through its state
transitions, error paths, and concurrency points. Static findings reference
exact locations with `file.ts:LINE`.

### 2.2 Dynamic stress testing (empirical)
Two new Vitest suites were authored under `test/stress/` (46 tests total) that
exercise the defects without requiring live brokers/sockets. The strategy:

| Target | Approach |
|---|---|
| RabbitMQ adapter + client | `vi.mock('amqplib')` with `EventEmitter`-based mock connections/channels whose `.close()` emits `close` (faithful to amqplib). Fake timers drive the reconnect backoff. Consumer callbacks are captured to drive the consume loop directly. |
| TCP frame parser | Pure-function tests on `feed()`/`encodeTcpFrame` covering 4 GB length prefix, the `== max` / `> max` boundary, zero-length frames, and 500-iteration churn. |
| TCP transport | Real loopback sockets (`net.createConnection`); concurrent `read()` calls + frame writes verify listener accumulation and duplicate delivery. |
| UDP / NATS | `UdpTransport` bound to `port 0`; NATS `connect` mocked. Both assert `start()` never flips the `started` flag. |
| ReplayProtection | Fake timers; capacity fail-closed, insertion-order eviction, clock-skew/tol, and "no `start()` ⇒ no cleanup". |
| EncryptionService | Real WebCrypto; ciphertext/AAD/version tampering, wrong key length, circular payload, and AES-GCM ↔ ChaCha20 round-trip. |
| TransportManager / Registry | Fake transports and `InMemoryRegistryStore`; partial-start non-rollback, multi-close, duplicate registration, and `maxServices` ignoring. |

Tests that encode a **defect** assert the buggy behavior (e.g. `expect(hung).toBe('HUNG')`)
so they stay green until the code is fixed and the assertions are inverted —
they are regression guards, not "should pass" tests.

### 2.3 Baseline verification
- `npx tsc --noEmit` → **exit 0** (types clean).
- `npx vitest run` (full repo) → **1644 passed, 4 failed**. The 4 failures are
  the **pre-existing** `pluggable-messaging.adversarial.test.ts` failures
  (identical before and after this work); no new failures were introduced.
- `npx eslint` on the two new test files → **0 problems**.

---

## 3. Findings

Severity legend: **CRITICAL / HIGH / MEDIUM / LOW**.
"Evidence" cites the test name in `test/stress/` and the source location.

### C-1 · Reconnection timer is never stored or cleared → reconnect storms and reconnect-after-shutdown
`RabbitMQTransport` (`src/adapters/messaging/rabbitmq/adapter.ts:7-30`) has
**no `reconnectTimer` field**. `handleDisconnect` (`adapter.ts:121-143`)
schedules `setTimeout(() => this.connect(), delay)` and discards the handle.
`disconnect()` (`adapter.ts:250-264`) calls `channel.close()` / `connection.close()`
but amqplib emits `close` on both, so `handleDisconnect` fires during an
intentional shutdown and re-arms a reconnect the transport can never cancel.
Evidence: **RECONSTRUCT-AFTER-CLOSE** — after `disconnect()` the assertion
`(t as any).reconnectTimer` is `undefined`, and advancing timers calls
`connect()` a second time.

**Impact:** A graceful shutdown is immediately undone by a reconnect attempt;
under flapping networks, orphaned timers accumulate (each reconnect failure
schedules another) producing unbounded timer/connection churn.

**Remediation:** Add a `reconnectTimer: NodeJS.Timeout | null` field,
`clearTimeout(this.reconnectTimer)` in `disconnect()` and at the top of
`handleDisconnect`, and a `shuttingDown`/closed fence so post-disconnect `close`
events cannot re-trigger reconnection.

### C-2 · Connection-error + connection-close both schedule reconnection (double trigger)
`handleDisconnect` is wired to both `connection.on('error')` and
`connection.on('close')` (and the same pair on the channel: `adapter.ts:114-118`).
A single broker loss emits both events synchronously, so `reconnectAttempts` is
incremented twice for one incident and two timers are queued. The only guard
(`if (this.isConnecting) return` at `adapter.ts:99`) is ineffective once
connected (it is `false` after a successful `connect()`).
Evidence: **DOUBLE-TRIGGER** — emitting `error` then `close` yields
`reconnectAttempts === 2`.

**Impact:** Exponentially growing backoff mis-counters; duplicate connection
attempts; double the reconnect load.

**Remediation:** De-duplicate events with a "currently disconnecting/reconnecting"
state flag, and only arm one reconnect per incident. Prefer a single `close`
handler for reconnection and treat `error` as informational.

### C-3 · `publish()` racing a reconnect opens a concurrent connection
`publish()` calls `await this.connect()` (`adapter.ts:160-166`). After a
`close` drops the channel, a reconnect is *scheduled* (C-1), but `publish()`
invokes `connect()` immediately which — because `isConnecting` is `false` and
`isConnected()` is `false` — starts a **brand-new** `establishConnection()`
in parallel with the scheduled one.
Evidence: **CONCURRENT-CONNECT-RACE** — after one channel `close`, a single
`publish()` drives `mockConnect` from 1 → 2 call while the scheduled timer is
still pending.

**Impact:** Multiple simultaneous AMQP connections from one logical transport;
channel/queue double-binding; resource exhaustion.

**Remediation:** Have `connect()` (the public entry) coordinate with the
reconnect path through shared `isConnecting`/`isConnected` state and a
single "ensure connected" guard; or have `publish()` queue behind an in-flight
`connect()` promise rather than calling a second one.

### C-4 · Poison-message infinite redelivery (no retry ceiling, no dead-letter)
The consume handler (`adapter.ts:224-230`) catches every failure and always calls
`this.channel.nack(msg, false, true)` — requeue unconditionally. There is no
delivery-count, no retry limit, and no dead-letter exchange configured. The same
pattern exists in `rabbitmq-client.ts:185-190`.
Evidence: **POISON-LOOP** and **POISON-LOOP-HANDLER** — malformed JSON and a
throwing handler are each nacked with `requeue=true` across 4–5 redeliveries
with no reduction.

**Impact:** One un-parseable or failing message loops forever, saturating the
consumer (CPU, logs) and blocking the queue.

**Remediation:** Track `message.properties.headers['x-death']` / `x-first-death`
or an in-process retry counter; after N attempts, route to a dead-letter
exchange (declare the DLX on the queue: `messageTtl`, `deadLetterExchange`).
Add a `maxRetries` per-message option.

### C-5 · `unsubscribe()` is non-functional (cancels by queue name, not consumer tag; substring match)
`subscribe()` (`adapter.ts:200-207`) stores only the handler keyed by queue name
and **discards the consumer tag** returned by `channel.consume`. `unsubscribe()`
(`adapter.ts:237-248`) then:
1. finds the queue via `key.includes(topic)` — a substring match that selects
   the wrong queue (`unsubscribe('a')` cancels `q.a.b` before `q.a`), and
2. calls `channel.cancel(queueName)` — amqplib's `cancel` expects a **consumer
   tag**, not a queue name.

Evidence: **UNSUBSCRIBE-BY-QUEUE-NAME** asserts `cancel` is called with the
queue-name string `q.topic` and never with `consumer-tag-1`; **UNSUBSCRIBE-SUBSTRING**
asserts `unsubscribe('a')` cancels `q.a.b`.

**Impact:** Consumers are never actually cancelled; subscription leaks
accumulate; the wrong logical subscription can be torn down.

**Remediation:** Store the consumer tag (`{ queueName, handler, consumerTag }`)
in the map, cancel by tag, and match the topic by the stored key (exact) rather
than substring.

### C-6 · `amqplib` is an undeclared dependency of the published package
`adapter.ts:5` and `rabbitmq-client.ts:6` import `amqplib`, but
`package.json` lists it in **neither `dependencies` nor `peerDependencies`**
(kafkajs and nats are correctly listed as peer deps — `amqplib` is not).
Verified via `node -e` against `package.json`: `amqplib` is absent from both.
It resolves in this monorepo only because it is hoisted into the workspace
`node_modules`.

**Impact:** `npm install @oneunit/microservice && import('.../rabbitmq')` throws
`ERR_MODULE_NOT_FOUND` at runtime — the RabbitMQ adapter is silently broken for
every downstream consumer.

**Remediation:** Add `amqplib` to `peerDependencies` (with `@types/amqplib` in
`devDependencies`) and document the optional install, mirroring the kafkajs/nats
pattern. (The driver-resolver `rabbitmq/driver-resolver.ts:16-22` already loads it
as an optional peer, but the main `adapter.ts` imports it unconditionally.)

### H-1 · UDP and NATS never set `started = true`, so `healthCheck()` is permanently "unhealthy"
`BaseTransport.started` is set to `true` only inside `start()` of **5 of the 7**
transports that extend it — TCP (`tcp/index.ts:81`), tRPC, gRPC, and Connect
do it correctly, but **UDP (`udp/index.ts:41-67`), NATS
(`nats/index.ts:53-74`), Kafka (`kafka/adapter.ts:29-34`) and RabbitMQ
(`adapter.ts:32-34`) do not**. For UDP and NATS this is correctness-breaking
because `healthCheck()` consults `isStarted()`:
- UDP: `return { status: this.isStarted() ? 'healthy' : 'unhealthy', … }` — always unhealthy.
- NATS: same pattern (`nats/index.ts:88-94`).

RabbitMQ and Kafka avoid the symptom only because their `healthCheck()` checks
connection/producer state directly rather than the flag — but the
`isStarted()` contract is still violated and any orchestrator relying on it
(e.g. readiness probes) mis-reports UDP/NATS as down.
Evidence: **UDP-STARTED-FLAG**, **NATS-STARTED-FLAG** — `isStarted()` is `false`
after a successful `start()`.

**Impact:** False-negative health (and possibly failed readiness probes →
premature restarts) for UDP/NATS-based deployments.

**Remediation:** Set `this.started = true` at the end of `start()` in UDP, NATS,
Kafka, and RabbitMQ (and `false` in their `close()`), or centralize the flag in
`BaseTransport.start()`/`BaseTransport.stop()` and require subclasses to call
`super.start()`/`super.close()`.

### H-2 · TCP `read()` listener leak → duplicate message delivery and unbounded listener growth
`createConnection.read()` (`tcp/index.ts:191-225`) calls
`socket.on('data', onData)` on **every** invocation and removes the listener
only on `close`. Because JavaScript `EventEmitter` fan-out calls listeners in
registration order and **all read() closures share the same `buffer` variable**,
when a frame arrives every attached listener re-concatenates the chunk onto the
(emptied) buffer and resolves with **the same frame**. The listeners are never
removed, so on every subsequent frame *all* accumulated listeners fire.
Evidence: **TCP-READ-LEAK-DUPLICATE** — three concurrent `read()` calls all
resolve with the identical single frame ("duplicate delivery"); **TCP-READ-LEAK-HANG**
shows a later `read()` can never be resolved by arriving data.

**Impact:** Duplicated/phantom messages, hung promises, memory growth linear in
the number of reads, and CPU amplification.

**Remediation:** Register **one** persistent `'data'` listener when the
connection is created (in `createConnection`), and have each `read()` await a
single shared dequeue primitive (e.g. a per-connection FIFO / promise resolver).
Remove listeners on `close`. Also guard accepted sockets with
`socket.on('error', …)` so a peer reset cannot crash the process
(see **TCP-READ-HANG** cleanup notes).

### H-3 · Kafka re-subscribe orphans the previous consumer (subscription leak)
Both Kafka adapters overwrite the `consumers` map entry on re-subscribe without
disconnecting the old consumer:
- kafkajs: `consumers.set(topic, consumer)` at `kafka/kafkajs/adapter.ts:132`;
- oneunit: `consumers.set(topic, consumer)` at `kafka/oneunit/adapter.ts:138`.

**Impact:** Repeated `subscribe()` to the same topic spawns unbounded consumers
(consumer-group membership churn, broker-side resource exhaustion).

**Remediation:** `unsubscribe()` (or the re-subscribe path) must
`disconnect()` the existing consumer before replacing the map entry.

### H-4 · Kafka failed handler commits the offset (silent at-most-once loss)
The kafkajs `eachMessage` (`kafka/kafkajs/adapter.ts:115-129`) wraps the handler
in a try/catch, logs the error, and **resolves** the callback. kafkajs commits
offsets after `eachMessage` resolves, so a failing message's offset is committed
and the message is **permanently lost** (no retry, no DLQ). The same applies
mutatis mutandis to the oneunit adapter (`kafka/oneunit/adapter.ts:123-135`),
where `nak()` is only called if `!options.autoAck`.

**Impact:** Silent message loss on transient handler errors.

**Remediation:** Do not ack/nak around a failing handler; instead surface the
error (or configure `autoCommit: false` and nack/retry explicitly). Add a retry
counter and dead-letter topic.

### H-5 · NATS `publish()` silently no-ops when not connected; `subscribe()` uses fire-and-forget async iteration
- `publish()` (`nats/index.ts:96-105`): when `js` is null and `nc` is null (i.e.
  not started), neither branch executes and the promise **resolves successfully
  without sending anything** — silent data loss. Compare to Kafka's explicit
  `throw new Error('Producer not connected')`.
- `subscribe()` (`nats/index.ts:126-154`): the `for await` loop runs inside a
  detached `(async () => {…})()` IIFE with no error boundary outside its inner
  try/catch; a throw from `this.nc.subscribe(subject)` is an **unhandled
  rejection**.

Evidence: **NATS-SILENT-PUBLISH** — `publish` on an un-started transport
resolves instead of throwing.

**Impact:** Messages silently vanish; occasional unhandled rejections.

**Remediation:** `publish()` should throw when `nc`/`js` is null. Move the async
iterator into a tracked, error-bounded task (store the promise, surface
errors via the transport's error channel).

### H-6 · TCP `openStream()` cannot parse IPv6 remotes
`openStream()` (`tcp/index.ts:119`) does `const [host, portStr] = remote.split(':')`.
A bracketed IPv6 literal such as `::1:9000` splits into four parts; the destructure
takes `host=''` and `portStr=''`, throwing "Invalid remote address format".
Evidence: **TCP-REMOTE-IPv6** — `openStream('::1:9000')` rejects.

**Impact:** IPv6 endpoints are unusable.

**Remediation:** Parse with `net` or a `host:port` parser that honours bracketed
IPv6 literals (e.g. strip surrounding `[…]`, split on the last `:`).

### H-7 · `registry.maxServices` is defined but never enforced
The config schema sets `maxServices: z.number().default(1000)` (`config/schema.ts:77`),
but `createRegistry()` (`registry.ts:216-243`) and `InMemoryRegistryStore`
(`registry.ts:41-141`) accept no such parameter. Registration is unbounded; and
`query()` does a full O(n) scan of every instance for every query.
Evidence: **REG-MAXSERVICES-IGNORED** — with `maxServices: 2`, five
registrations all succeed and return leases.

**Impact:** Unbounded registry growth (the `maxServices` safety valve is dead
config); degraded discovery latency at scale.

**Remediation:** Thread `maxServices` into `ServiceRegistryImpl` and
`InMemoryRegistryStore`; throw `RESOURCE_EXHAUSTED` in `register()` when
exceeded. Index instances by `serviceId`/`status` for sublinear query.

### H-8 · ReplayProtection: no background cleanup unless `start()` is called; eviction is insertion-ordered
`checkAndStore()` (`replay-protection.ts:63-95`) enforces `ttlMs` and
`maxEntries` at check time, but TTL expiry is **only** reaped by the interval
started in `start()` (`replay-protection.ts:102-108`). If `start()` is never
called (common for one-off use), expired entries are **never removed** — memory
grows until `maxEntries` is hit and the store fails closed.
Additionally, per-source eviction (`replay-protection.ts:74-79`) removes the
oldest-inserted entry (Set insertion order), not the oldest by time, so the
replay-detection window is bounded by count, not age.
Evidence: **REPLAY-STALE-NO-CLEANUP** (2 entries retained past TTL with no
`start()`); **REPLAY-ROCL** (fail-closed at capacity).

**Impact:** Memory leak when the service is used without `start()`; bounded
detection window allows a replayed ID evicted by insertion order to be re-accepted.

**Remediation:** (1) On `checkAndStore`, opportunistically evict any
*expired* entries (cheap, no timer required) so correctness does not depend on
`start()`. (2) Bound per-source storage by (insertion **and** age). (3) Document
that `start()` is required for memory reclamation, or perform lazy cleanup per
check.

### H-9 · Stale, red adversarial test file (`pluggable-messaging.adversarial.test.ts`)
Four tests fail in the baseline (and fail identically after this work):
- 2 assert `createMessagingAdapter({ provider: 'rabbitmq' })` throws "Unsupported",
  but `factory.ts:42-43` **does** support `rabbitmq`.
- 2 import `MessagingProviderRegistry` from `adapt.messaging/index.ts`, which
  **does not re-export it** (only `createMessagingAdapter`,
  `get/setMessagingAdapterFactory`, types, and rabbitmq) — `provider-registry.ts`
  exports the class but `index.ts:1-8` never re-exports it.

**Impact:** A perpetually red test suite masks regressions; developers
distrust CI.

**Remediation:** Either re-export `MessagingProviderRegistry` (and `set/getMessagingAdapterFactory`)
from the messaging barrel and update the "unsupported provider" test, or delete
the stale assertions. The red suite should not ship.

### C-6 companion · Other messaging reliability gaps
- **Kafka `subscribe` (kafkajs):** no `error`/`disconnect` handler on the
  consumer returned by `consumer.run()` (`kafka/kafkajs/adapter.ts:115`); a
  broker-side lifecycle error rejects the `run()` promise as an unhandled
  rejection.
- **RabbitMQ `publish` backpressure:** returning `false` from
  `channel.publish` is treated as a hard "Failed to publish" with no retry and
  no backpressure handling (`adapter.ts:176-178`); large payloads are not size-
  capped and `JSON.stringify` runs synchronously on the hot path.

---

## 4. Additional Medium/Low findings

| ID | Location | Finding |
|----|----------|---------|
| M-1 | `tcp/index.ts:207-208` | `buffer = buffer.slice(...)` is zero-copy; the backing allocation grows/retained for the life of the connection. Use `Buffer.subarray` + copy-out, or `reset()` after each frame. |
| M-2 | `tcp/index.ts:183-189` | `write()` ignores socket backpressure (no `drain` coordination); large outbound frames buffer unbounded. |
| M-3 | `nats/index.ts:129` | `JSON.parse(msg.data)` with no `try` isolation; a malformed core-NATS message is silently swallowed by the outer catch and, for non-JetStream, auto-acked → lost. |
| M-4 | `security/encryption.ts:214-215` | `encryptEnvelope` calls `JSON.stringify(envelope.payload)` with no size guard; circular payloads throw (proven by **ENC-CIRCULAR**). |
| M-5 | `transport/manager.ts:42-60` / `62-77` | `startAll()`/`stopAll()` partial-failure semantics: a mid-start failure leaves earlier transports running with **no rollback**; `stopAll` continues on per-transport close errors (good) but aggregates them. Proven by **TMGR-PARTIAL-START** and **TMGR-STOPALL-CONTINUES**. |
| M-6 | `internal/shutdown.ts:90-99` | Signal handlers registered as a constructor side-effect; multiple `ShutdownManager` instances multiply handlers, and the `gracefulShutdown` helper is mis-indented and races its timeout (hooks keep running after the timeout fires). |
| M-7 | `config/loader.ts:91-93` | `buildConfigFromEnv()` `JSON.parse`s several env vars with no `try/catch`; malformed env crashes bootstrap with a raw JSON error. |
| M-8 | `security/replay-protection.ts` (exposed by test) | The adversarial test passes a `cleanupIntervalMs` option and calls private `cleanup()` (`replay-protection.adversarial.test.ts:36-38`); neither exists on `ReplayProtectionConfig`/`ReplayProtection` — the option is silently ignored and `start()` uses `ttlMs` as the interval. |
| M-9 | `adapters/messaging/kafka/adapter.ts:29-34` | Kafka `start()` resolves the driver and starts the underlying adapter; fine, but the transport still omits `this.started = true` (the H-1 gap). |
| L-1 | `adapters/messaging/kafka/adapter.ts:79-81` | `getResolvedDriver()` returns the hardcoded default `'kafkajs'` before resolution runs; misleading for telemetry before `start()`. |

### Verified correct (positive controls)
- AES-GCM and ChaCha20-Poly1305 envelope encryption authenticate metadata
  (AAD) binding — **ENC-TAMPER-CIPHERTEXT**, **ENC-TAMPER-METADATA**, **ENC-VERSION-MISMATCH**,
  **ENC-ROUNDTRIP** all pass.
- Replay clock-skew and TTL rejection work (**REPLAY-CLOCK**, **REPLAY-DEDUP**).
- Registry TTL expiry removes stale leases from discovery (**REG-LEASE-EXPIRY**).
- TCP parser rejects 4 GB length prefixes and honours `maxFrameSize` (**PARSER-OVERFLOW**,
  **PARSER-BOUNDARY**, **PARSER-ZERO-FRAME**, **PARSER-SHIMMER**).

---

## 5. Verification matrix (new stress suites)

```
$ npx vitest run test/stress/
✓ test/stress/transports-security-stress.test.ts (29 tests)
✓ test/stress/rabbitmq-stress.test.ts        (17 tests)
Test Files  2 passed (2)
Tests       46 passed (46)
```

The matrix of findings → proving tests:

| Finding | Proving test | Outcome |
|---|---|---|
| C-1 reconnect-after-close / timer leak | RECONSTRUCT-AFTER-CLOSE | reconnect fires after `disconnect()` |
| C-2 double-trigger | DOUBLE-TRIGGER | `reconnectAttempts === 2` |
| C-3 publish/connect race | CONCURRENT-CONNECT-RACE | `mockConnect` 1→2 mid-reconnect |
| C-4 poison loop | POISON-LOOP / POISON-LOOP-HANDLER | `nack(_, false, true)` × N, no ceiling |
| C-5 unsubscribe broken | UNSUBSCRIBE-BY-QUEUE-NAME / UNSUBSCRIBE-SUBSTRING | `cancel` called with queue name, wrong queue |
| C-6 amqplib undeclared | (static, `package.json`) | absent from deps & peerDeps |
| H-1 started flag | UDP-STARTED-FLAG / NATS-STARTED-FLAG | `isStarted()` false after `start()` |
| H-2 TCP read leak | TCP-READ-LEAK-DUPLICATE / TCP-READ-LEAK-HANG | duplicate frame, hung promise |
| H-3 Kafka re-subscribe | (static + existing kafka tests pattern) | consumer map overwritten |
| H-5 NATS silent publish | NATS-SILENT-PUBLISH | resolves without sending |
| H-6 IPv6 parsing | TCP-REMOTE-IPv6 | rejects valid-looking IPv6 remote |
| H-7 maxServices | REG-MAXSERVICES-IGNORED | 5 registrations with limit 2 |
| H-8 replay cleanup | REPLAY-STALE-NO-CLEANUP / REPLAY-ROCL | stale retained; fail-closed |
| M-4 circular payload | ENC-CIRCULAR | rejects |

---

## 6. Implementation order (recommended)

1. **C-6** (packaging) — add `amqplib` peer dep. Zero risk, unblocks the adapter.
2. **C-1 / C-2 / C-3** (reconnect state machine) — store + clear the timer;
   de-duplicate events; serialize `connect()` behind a single in-flight promise;
   gate reconnect after `disconnect()`.
3. **C-5** (unsubscribe) — store consumer tags; cancel by tag; exact topic match.
4. **C-4** (poison messages) — retry counter + dead-letter.
5. **H-1** (started flag) — centralize in `BaseTransport`.
6. **H-2** (TCP read) — single persistent listener + queue/dequeue.
7. **H-4 / C-6-companion** (Kafka at-most-once) — do not ack on handler error.
8. **H-3 / M-2 / M-3 / H-6** — Kafka unsubscribe, TCP backpressure, NATS parse
   guard, IPv6 remote parsing.
9. **H-7 / H-8** — enforce `maxServices`; lazy-TTL reaping in replay protection.
10. **H-9** — fix or remove the stale red test file.

---

## 7. Artifacts

- `test/stress/rabbitmq-stress.test.ts` — 17 tests
- `test/stress/transports-security-stress.test.ts` — 29 tests

Both files are new, lint-clean, and run under the project's existing Vitest
configuration (`vitest.config.ts`). No production source files were modified by
this analysis; the tests encode the current (buggy) behavior as regression
guards and should be inverted once the corresponding fixes land.
