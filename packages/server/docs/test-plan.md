# @oneunit/server Comprehensive Test Plan

This plan validates every public subsystem against boundary, adversarial, concurrency, failure, and performance conditions. Each scenario includes priority, reproducible steps, expected behavior, and automation hooks.

## Scope

- Bootstrap and lifecycle
- Configuration and environment
- HTTP built-ins: CORS, Helmet, compression, cookies, CSRF, multipart, rate limiting, Zod validation, request context
- Hooks
- Health checks and system health
- Error handling and response management
- Logging
- Serialization (MessagePack)
- Infrastructure: database, Redis, Kafka, realtime
- Plugin composition and optional dependencies
- Packaging, ESM, and built-module consumption

## Priority legend

| Priority | Meaning |
| :--- | :--- |
| P1 | Likely in production, high business impact |
| P2 | Moderate likelihood or impact |
| P3 | Rare but plausible, lower impact |
| P4 | Extreme corner or theoretical |

## Automation hooks

```bash
npm run typecheck
npm run build
npm test
npm run lint
npm run example:complete
npm run pack:check
```

CI should run these as separate jobs:

1. `unit`: `npm run typecheck && npm test`
2. `build-consumer`: `npm run build && npx tsc --noEmit -p tsconfig.examples.json`
3. `package`: `npm run pack:check`
4. `examples`: `npm run example:basic:js && npm run example:complete`
5. `stress`: `RUN_STRESS=1 vitest run test/stress`

Set `NODE_OPTIONS=--throw-deprecation` and `CI=true` for every job.

## Universal baseline limits

| Resource | Boundary |
| :--- | :--- |
| Server count per test | 64 |
| Concurrent in-flight requests | 1,000 |
| Request payload | 100 MB |
| Header count | 5,000 |
| Request path length | 64 KB |
| Shutdown timeout | 1 ms to 120,000 ms |
| Health check latency | 0 ms to 30,000 ms |
| Optional dependency failure rate | 0% to 100% |
| Open sockets during close | 0 to 500 |

## 1. Bootstrap

### B-P1-001 maximum request load against minimal server

- Priority: P1
- Steps:
  1. Disable logger, env, DB, Redis, Kafka, realtime, health.
  2. Start 16 bound servers on port `0`.
  3. Issue 10 requests to `/` per server concurrently.
  4. Assert all responses are 200.
- Expected: No crashes, no leaked sockets, all servers close within 5 s.

### B-P1-002 partial startup failure

- Priority: P1
- Steps:
  1. Register a plugin that throws after half of the built-ins are registered.
  2. Start through `createBootstrapServer`.
  3. Attempt `ready()` and `close()`.
- Expected: Error propagates; close can be called once without another throw; no repeated resource initialization.

### B-P1-003 close before ready and repeated close

- Priority: P1
- Steps:
  1. Create a server without `ready()`.
  2. Call `close()` 5 times concurrently and then again sequentially.
- Expected: All calls resolve; no double-cleanup exceptions.

### B-P1-004 graceful shutdown signal handling

- Priority: P2
- Steps:
  1. Start with `gracefulShutdown: true`.
  2. Send `SIGTERM` followed by `SIGINT` while 10 requests are in flight.
- Expected: Only one shutdown runs; process exits once; no duplicate listeners.

### B-P1-005 invalid options

- Priority: P2
- Input limits: port `-1`, `NaN`, `65536`; host empty string; `shutdownTimeout: 0`, negative, `Infinity`.
- Expected: Type-level rejection where possible and runtime no hang or crash.

### B-P2-001 memory pressure during startup

- Priority: P3
- Steps:
  1. Create 64 servers with all built-ins enabled but dependencies unavailable.
  2. Run `ready()` on all.
- Expected: Optional dependencies degrade gracefully; heap growth remains bounded.

## 2. Configuration and environment

### C-P1-001 missing `.env`

- Priority: P1
- Steps: Start with `env: false` and an absent `.env`.
- Expected: Server starts; no env mutation; defaults used.

### C-P1-002 malformed environment

- Priority: P2
- Adversarial inputs: values containing newlines, null bytes, quotes, shell metacharacters.
- Expected: Values are parsed literally; no command execution; startup either succeeds or fails clearly.

### C-P1-003 precedence

- Priority: P1
- Steps: Set `PORT`, `HOST`, `SERVICE_NAME`, pass explicit options, then a second options object.
- Expected: Last explicit source wins according to documented precedence.

### C-P2-001 locale/timezone hints

- Priority: P4
- Steps: Run under `TZ=America/New_York`, `TZ=UTC`, and invalid time zone strings.
- Expected: Timestamp formatting remains valid; no crash from locale initialization.

## 3. Hooks

### H-P1-001 hook ordering

- Priority: P1
- Steps: Register nested `onRequest`, `preHandler`, `onSend`, and `onResponse` callbacks that append to a shared array for 10,000 requests.
- Expected: Ordering is stable and identical for every request.

### H-P1-002 hook exceptions

- Priority: P1
- Steps: Throw from each hook phase; capture response.
- Expected: Error propagates through the error handler; server remains usable.

### H-P2-001 concurrency and closure capture

- Priority: P2
- Steps: Capture request-local mutable state without request context.
- Expected: No cross-request leakage.

## 4. HTTP built-ins

### HTTP-P1-001 malformed JSON body

- Priority: P1
- Inputs: trailing comma, empty body, wrong content type, 100 MB body, deeply nested object.
- Expected: 400/415 or validation error; server does not crash or exhaust memory.

### HTTP-P1-002 rate limit burst

- Priority: P1
- Steps: Send `(max + 1)` requests in parallel from one IP.
- Expected: Excess requests receive 429 with `Retry-After`.

### HTTP-P1-003 CSRF token boundary

- Priority: P1
- Inputs: missing token, stale token, token from another user session.
- Expected: Protected mutations return 403; safe validation failures do not leak secrets.

### HTTP-P1-004 multipart adversarial input

- Priority: P2
- Inputs: path traversal filename, executable file, oversized upload, malformed boundary.
- Expected: File metadata is sanitized; server remains stable.

### HTTP-P1-005 CORS preflight

- Priority: P2
- Inputs: arbitrary origin, credentials enabled, methods and headers omitted.
- Expected: Only configured origins receive allow headers.

### HTTP-P1-006 security headers

- Priority: P2
- Steps: Inspect all default response headers.
- Expected: Helmet defaults present unless explicitly disabled.

### HTTP-P2-001 compression thresholds

- Priority: P3
- Inputs: payloads below and above threshold, already-compressed data.
- Expected: Compression applied only when beneficial.

### HTTP-P2-002 locale in validation

- Priority: P4
- Steps: Validate Unicode, RTL text, zero-width characters, oversized fields.
- Expected: Validation errors are field-keyed and bounded.

### HTTP-P3-001 request context isolation

- Priority: P1, mocked in suite
- Steps: Run concurrent requests writing five different context keys.
- Expected: No leakage across requests and no undefined behavior when the optional plugin is absent.

### HTTP-P4-001 dependency degradation

- Priority: P2
- Steps: Remove optional request-context package while enabled.
- Expected: Startup reports missing dependency and skips the plugin; exception is explicit.

## 5. Zod and data validation

### V-P1-001 invalid primitive types

- Priority: P1
- Inputs: string port, numeric boolean, null arrays, undefined fields.
- Expected: HTTP 400 and `data.fields` contains safe messages only.

### V-P1-002 schema drift

- Priority: P2
- Steps: Register routes with outdated schemas and new payload.
- Expected: Validation failure; no silent acceptance.

### V-P2-001 injection attempts

- Priority: P1
- Inputs: SQL fragments, HTML/script tags, prototype pollution keys.
- Expected: Payload rejected or passed through as data without executing.

## 6. Health and system health

### 6.1 Check lifecycle and aggregation

- Priority: P1
- Tests:
  - Parallel slow providers.
  - Provider that throws.
  - Provider name collision.
  - Provider registration after app ready.
- Expected: Endpoint answers in time of slowest provider; errors reported as unhealthy; no duplicate health provider.

### 6.2 Health endpoint boundary conditions

- Priority: P1
- Inputs: 0 ms timeout, huge `timeoutMs`, invalid path, empty service name.
- Expected: Config validation or safe fallback; endpoint remains reachable.

### 6.3 Network partitions

- Priority: P1
- Steps: Register DB, Redis, Kafka, realtime health checks behind mock dependencies; disconnect them.
- Expected: System health reports degraded/unhealthy; overall HTTP status is policy-defined and deterministic. Note: live network tests are out of scope for default CI.

### 6.4 Regressions in system details

- Priority: P2
- Steps: Repeatedly call `/health/details` under load and compare open handles.
- Expected: No handle or listener leaks.

## 7. Response management

### RM-P1-001 status helpers

- Priority: P1
- Steps: Invoke every generated success/error helper once.
- Expected: Status code, `success`, `code`, and `msg` match contract.

### RM-P1-002 bodyless responses

- Priority: P1
- Statuses: 204, 205, 304.
- Expected: No response body is sent.

### RM-P1-003 metadata redaction and limits

- Priority: P1
- Inputs: values containing secrets, deeply nested objects, >1 MB metadata.
- Expected: Sensitive keys are masked and payload is bounded.

### RM-P1-004 request ID in metadata

- Priority: P2
- Steps: Issue requests with and without request ID.
- Expected: Request ID appears exactly once when enabled.

### RM-P2-001 pagination values

- Priority: P3
- Inputs: zero, negative, huge totals.
- Expected: Helpers accept them as supplied; application should validate separately.

## 8. Logging

### L-P1-001 logger disabled

- Priority: P1
- Steps: Start with `logger: false`.
- Expected: No logger plugin, no access logging, no errors from missing package.

### L-P1-002 absent logger package

- Priority: P2
- Steps: Force import failure of `@oneunit/logger`.
- Expected: Explicit skip warning; default Fastify logger stays in use.

### L-P1-003 sensitive data redaction

- Priority: P1
- Inputs: log objects containing passwords, tokens, cookies.
- Expected: Redaction rules are applied if configured.

### L-P2-001 high-frequency logging

- Priority: P2
- Stress: 50,000 requests, each logging an object.
- Expected: No dropped unhandled errors and bounded queue behavior.

### L-P2-002 locale and time zones

- Priority: P3
- Steps: Log under `TZ=UTC` and invalid locales.
- Expected: Timestamps remain ISO strings.

## 9. Serialization (MessagePack)

### M-P1-001 encode/decode round trip

- Priority: P1
- Inputs: primitives, arrays, nested objects, buffers, BigInt-compatible structures.
- Expected: Round-trip data is identical.

### M-P1-002 Accept header variants

- Priority: P1
- Headers: `application/msgpack`, `application/x-msgpack`, array headers, wildcard.
- Expected: MsgPack content type only when requested.

### M-P2-001 malformed msgpack payload

- Priority: P2
- Input: truncated bytes, random bytes, oversized decoder input.
- Expected: 400; Fastify error handler answers; server remains stable.

### M-P3-001 concurrency

- Priority: P3
- Steps: 5,000 parallel requests using MsgPack.
- Expected: No buffer reuse races or corrupted responses.

## 10. Infrastructure: database

### D-P1-001 connection lifecycle

- Priority: P1
- Steps: Enable database with available test Postgres; run query then close.
- Expected: Client logs successful connection and cleanup called once.

### D-P1-002 startup dependency failure

- Priority: P1
- Steps: Enable with invalid connection string.
- Expected: Health degrades; server does not crash.

### D-P2-001 schema drift

- Priority: P2
- Steps: Add a column after server init, then roll back.
- Expected: Query helper updates are application responsibility; package does not hide database errors.

### D-P2-002 connection exhaustion

- Priority: P2
- Stress: Queries beyond pool size.
- Expected: Queue or error, no crash; pool drains on close.

## 11. Redis

### R-P1-001 connect and close

- Priority: P1
- Expected: No double close, no reconnect after close.

### R-P1-002 retry strategy

- Priority: P2
- Steps: Connect to a blocked Redis port then restore.
- Expected: Retry behavior respects configured delay and maximum retries.

### R-P2-001 malformed key operations

- Priority: P3
- Inputs: very long keys, binary keys, missing keys.
- Expected: Redis client errors are returned and returned through application code.

## 12. Kafka

### K-P1-001 producer/consumer startup

- Priority: P1
- Expected: Clean skip if dependency absent; connect when available.

### K-P1-002 broker unavailable

- Priority: P2
- Expected: Health degrades; startup may still complete for optional message flows.

### K-P2-001 malformed messages

- Priority: P2
- Inputs: invalid JSON, null payloads, unknown schema, wrong codec.
- Expected: Errors are surfaced; server does not crash.

## 13. Realtime/WebSocket

### RT-P1-001 handshake and health

- Priority: P1
- Expected: Plugin registers only when enabled and logger available.

### RT-P1-002 channel flood and backpressure

- Priority: P2
- Stress: 10,000 concurrent clients, rapid fanout.
- Expected: No unbounded memory growth; policy applies backpressure.

### RT-P2-001 network partitions

- Priority: P2
- Steps: Drop WebSocket connections mid-message.
- Expected: Heartbeat detects closure and releases memory.

## 14. Plugin composition and optional dependencies

### P-P1-001 array and object plugin forms

- Priority: P1
- Steps: Pass array, object, and both plugin shapes.
- Expected: Validation error for mixed forms; correct deterministic merge.

### P-P1-002 duplicate plugin registration

- Priority: P2
- Expected: Fastify registration error is surfaced cleanly.

### P-P1-003 partial plugin option merge

- Priority: P2
- Quantity: 1,000 nested override keys.
- Expected: Base keys remain present unless overridden.

### P-P2-001 privilege escalation via unsafe plugins

- Priority: P1
- Steps: Register application plugin that attempts to access arbitrary built-ins.
- Expected: Only the exposed application APIs can be accessed; no accidental internal decorator leakage.

## 15. Packaging and consumer behavior

### PKG-P1-001 ESM subpath imports

- Priority: P1
- Imports: `.`, `./bootstrap`, `./config`, `./hooks`, `./plugins`, `./routes`, `./lib`.
- Expected: Types resolve and built artifacts execute.

### PKG-P1-002 built package only

- Priority: P1
- Steps: Run tests against `dist` after `npm pack`.
- Expected: No source-only imports.

### PKG-P1-003 package contents

- Priority: P1
- Expected: `npm pack --dry-run` includes dist, examples, README, docs; excludes src, test, agent.md.

### PKG-P2-001 browser or bundler assumptions

- Priority: P3
- Expected: Package declares Node-only consumers; ESM exports remain intact.

## 16. Repro steps template

For every scenario, use:

```ts
import { createBootstrapServer, startBootstrapServer } from "@oneunit/server";

const server = await createBootstrapServer({
  logger: false,
  env: false,
  database: false,
  redis: false,
  kafka: false,
  realtime: false,
  health: false,
});
await server.ready();
// scenario-specific request...
await server.close();
```

## 17. Evidence and reporting

Each automated test should report:

- scenario ID
- priority
- pass/fail/skip
- duration
- open handles delta
- max RSS
- failure root cause class

## 18. New test suite layout recommendation

```text
test/
├── unit/
├── integration/
├── stress/
├── package/
└── architecture/
```

New scenarios in this plan should be added under `test/integration` and `test/stress`, not under temporary debug files.
