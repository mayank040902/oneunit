# Architecture — `@oneunit/microservice`

**Package version:** 1.0.0 (documented package version; verify against `package.json` before release)
**Architecture status:** Existing implementation documented; target-state requirements and release blockers are specified in this revision.
**Production status:** NOT VERIFIED. This document is not a security certification or a declaration that every described capability is production-ready.
**Companion documents:** `AGENTS.md` (agent working rules), `docs/security/SECURITY-VERIFICATION-REPORT.md`, `docs/testing/TEST-MATRIX.md`, `REFACTOR_REPORT.md` (dependency-inversion refactor)

This document separates **current implementation facts** from **required target
behavior**. A documented defect remains a defect until the source code, tests,
and integration checks demonstrate that it has been corrected. Do not interpret
a proposed design, interface, configuration option, or passing unit test as
proof that a capability is complete.

**Status vocabulary used throughout:**

- **Implemented:** present in source and covered by relevant tests.
- **Partial:** some behavior exists, but one or more contract requirements are missing.
- **Known defect:** current behavior is incorrect or misleading and requires a fix.
- **Target requirement:** behavior the architecture requires before the stated readiness level can be claimed.
- **Release blocker:** a defect or missing verification that must be resolved before a production-readiness claim.

The architectural priority is correctness and security at contract boundaries, not
adding more protocols. Keep the public API stable where possible, but prefer an
explicit breaking change over silently preserving a misleading security or
transport contract.

---

## 0. Architecture decisions and release gate

### 0.1 Architectural direction

Preserve the package's adapter-based architecture and public composition root,
but make its contracts authoritative. The package must not advertise behavior
that the runtime does not implement.

The target architecture has these boundaries:

1. **Public API and composition:** validate final configuration, construct
   dependencies, expose the application runtime, and coordinate lifecycle.
2. **Core contracts and policies:** transport-specific interfaces, routing
   decisions, normalized errors, lifecycle state, authorization policy, and
   service-discovery contracts. This layer must not depend on concrete broker
   clients.
3. **Providers and adapters:** registry stores, RPC/network transports,
   messaging drivers, and logging integrations. Each adapter must satisfy its
   declared contract and expose its real capabilities.
4. **External infrastructure:** Redis, Kafka, NATS, remote RPC servers, and
   network endpoints. The package is a client/library and adapter layer, not
   a replacement for those systems.
5. **Cross-cutting contracts:** configuration, identity, security, telemetry,
   and audit interfaces have explicit ownership and must not create circular
   dependencies.

### 0.2 Non-negotiable invariants

- Validate the **final effective configuration** before creating runtime
  resources. Invalid configuration must fail before opening sockets or clients.
- Authentication and authorization must be enforced at every applicable
  inbound server boundary; defining an authenticator or policy is not enough.
- No cryptographic API may imply authenticated peer identity unless peer
  authentication is actually performed.
- Capability declarations must be truthful. A client must not route to an
  adapter based solely on a boolean when the required operation is not supported.
- Registry updates must address the canonical record and preserve lease
  consistency under concurrent updates.
- Startup failure must clean up resources already started; shutdown must attempt
  every cleanup action and report aggregate failures.
- Optional dependencies must remain optional in both package metadata and the
  runtime import graph.
- Retries must not be claimed or enabled without bounded policy, cancellation,
  deadline handling, and an explicit idempotency/retry-safety rule.
- Tests using mocks/fakes are unit tests, not evidence of real-infrastructure
  interoperability.
- Documentation, runtime behavior, types, configuration schemas, examples, and
  package exports must describe the same public contract.

### 0.3 Readiness gates

**Unit-tested** means local tests pass. **Integration-tested** means supported
external systems have been exercised in CI or a reproducible release workflow.
**Production-ready** requires both, plus the security and release gates in
§21. Do not use these labels interchangeably.

**Current release posture:** HOLD any unconditional production-security or
production-readiness claim until all P0/P1 items in §21 are resolved or
explicitly scoped out of the supported public contract, and the evidence is
recorded in the security verification report and test matrix.

---

## 1. System overview

`@oneunit/microservice` is a secure, extensible communication layer for
distributed services in the OneUnit ecosystem. It provides:

- a **composition root** (`createMicroservice`) that wires configuration,
  identity, authorization, registry, lifecycle, logging, and optional
  messaging into one application object with deterministic startup/shutdown;
- **capability-based transport abstractions** (`Transport`, `RpcClient`,
  `RpcServer`, `MessagePublisher`, `MessageSubscriber`, `StreamTransport`,
  `DatagramTransport`) that adapters implement;
- **protocol adapters** for tRPC, gRPC, Connect RPC, TCP, UDP, Kafka, and
  NATS;
- **service registry** with time-bounded leases, renewal, discovery with
  client-side caching, and health metadata, backed by in-memory or Redis
  stores;
- **identity, authentication, and authorization building blocks** (X.509,
  JWT, API keys, allowlist, RBAC, composite policies, default-deny; effective
  enforcement depends on correct integration at each transport boundary);
- **cryptographic primitives and security extension points** (AES-256-GCM
  AEAD, Ed25519 signing, X25519 key agreement, HKDF-SHA-256 key separation,
  replay protection, and key-rotation APIs; see §8 and §21 for limitations);
- **observability contracts** (framework-owned `Logger` contract, in-memory
  metrics/tracing/audit implementations);
- a **normalized error model** (`MicroserviceError` with 20 categories and
  retryability metadata).

The package is an ESM-only (`"type": "module"`) TypeScript library targeting
Node.js ≥ 20. It is published with declaration files and a strict `exports`
map (§17).

### What this package is not

- It is **not** a Kafka/NATS/Redis broker or server. Kafka, NATS, and Redis
  are always external infrastructure accessed through client integrations.
- It does **not** provide a universal wire format. Each adapter preserves the
  native semantics of its protocol library.
- It does **not** claim exactly-once processing. Kafka adapters preserve the
  native acknowledgment semantics of the selected driver.

---

## 2. Technology stack

| Layer | Technology | Notes |
|---|---|---|
| Runtime | Node.js ≥ 20 (`engines: { node: ">=20" }`) | ESM only; workspace `.nvmrc` pins 24.19.0 |
| Language | TypeScript 5.3+ (devDependency `^5.3.3`; workspace root `^5.9.2`) | `strict`, `isolatedModules`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature` |
| Compiler target | ES2022, module ESNext, `moduleResolution: node` | Path aliases `@/*`, `@crypto/*`, `@transport/*`, `@registry/*`, `@config/*`, `@adapters/*` |
| Build | `tsc && tsc-alias` | `tsc-alias` rewrites `@/…` aliases to relative paths in `dist/` so the published ESM artifact resolves |
| Tests | Vitest 1.6 (`vitest run`), `@vitest/coverage-v8` | `pool: "forks"`, `singleFork: true`, `include: test/**/*.test.ts` |
| Lint | ESLint 8 + `@typescript-eslint` 7 (`eslint src`) | |
| Runtime validation | Zod 3.22 (`zod` in `dependencies`) | All configuration sections are Zod-validated at load time |
| Cryptography | Node.js Web Crypto API (`globalThis.crypto.subtle`) + `node:crypto` (`X509Certificate`) | No third-party crypto libraries |
| RPC client libraries | `@trpc/client` + `@trpc/server` 11, `@grpc/grpc-js` 1.10 + `@grpc/proto-loader` 0.7, `@connectrpc/connect` + `@connectrpc/connect-node` 1.5 | Hard `dependencies`; loaded lazily inside adapter methods, never at module load |
| JWT | `jose` 5.2 | Used by `JwtAuthenticator` via dynamic import |
| Optional peers | `@oneunit/kafka`, `kafkajs`, `nats`, `@oneunit/redis`, `ioredis`, `redis` (node-redis), `@oneunit/logger`, `pino`, `pino-pretty` | All marked `optional: true` in `peerDependenciesMeta`; loaded via ESM dynamic `import()` inside driver resolvers |

**Declared but unused:** `uuid` (^11.1.1) and `ws` (^8.16.0) are listed in
`dependencies` but no source file imports them. Identifiers are generated
with the global `crypto.randomUUID()`; no WebSocket transport exists. Both
packages remain install-time dependencies of the published artifact and are
candidates for removal.

---

## 3. Layered architecture

The package follows the layering mandated by `AGENTS.md` §4. Ownership is
strict: lower layers never import higher layers, and concrete optional
clients are confined to adapter/driver modules.

```text
1. core/            application composition, lifecycle, capability contracts, error model
2. config/          Zod schemas + file/env loader
3. contracts/       shared message/event/procedure types, Zod registration schemas, versioning
4. identity/        service identity, credential stores, authenticators, authorization policies
5. security/        AEAD encryption, key agreement, signing, key provider/rotation, replay protection
6. registry/        registry service, leases, discovery, health, Redis store (multi-driver)
7. transport/       BaseTransport abstract class, TransportManager, capability re-exports
8. adapters/        protocol adapters (rpc/, network/, messaging/, logging/)
9. observability/   Logger contract, metrics, tracing, audit
10. internal/       ID generators, shutdown coordination
11. crypto/         interface-only crypto provider abstractions (no implementation)
```

Import direction is one-way (higher → lower). The only cross-cutting imports
are:

- `core/application.ts` imports `registry`, `identity`, `observability`,
  `config`, and the Kafka adapter factory (to auto-initialize `app.kafka`
  when `adapters.kafka.enabled` is set). The Kafka adapter module itself
  imports only `transport`, `core/capabilities`, and `observability` — its
  driver clients load lazily.
- `registry/registry.ts` imports the Redis store class for the
  `backend: "redis"` branch.
- `adapters/*` import `transport/transport`, `core/capabilities`,
  `observability/logger`, and `config/schema` — never each other's
  internals.

---

## 4. Core subsystem (`src/core/`)

### 4.1 `application.ts` — composition root

`createMicroservice(options?: CreateAppOptions): Promise<MicroserviceApp>`

`CreateAppOptions`: `{ configPath?: string; config?: Partial<MicroserviceConfig>; logger?: Logger }`.

Construction sequence (current behavior followed by the required target):

1. **Load configuration** — `loadConfig(configPath ?? undefined)`.
   Programmatic overrides from `createMicroservice({ config })`
   are applied with `mergeConfig(loaded, overrides)`: plain
   objects deep-merge field by field (precedence: schema
   defaults < environment < config file < programmatic
   overrides), while arrays, scalars, and security-sensitive
   objects (`service.credentials`) are replaced wholesale so an
   override cannot produce a hybrid credential block. The merged
   result is validated once more with `MicroserviceConfigSchema`
   **before any runtime resource is constructed** and is returned
   frozen. `CreateAppOptions.config` is typed
   `DeepPartial<MicroserviceConfig>` so every field at every
   depth is overridable. Invalid configuration fails with
   formatted `path: message` errors before sockets or clients
   open.
2. **Identity** — `createServiceIdentity(config.service)`.
3. **Registry** — `createRegistry(config.registry)` (in-memory, or Redis
   wrapped in a lazy-connect `Proxy`, §9.4).
4. **Authorization** — `createAuthorizationPolicy(config.auth.type, …)`.
5. **Lifecycle** — `new LifecycleManager(config.registry.healthCheckIntervalMs ?? 30000)`.
6. **Logger** — `createAppLogger` resolves in order:
   1. `options.logger` if provided (application-owned; the framework never
      configures it);
   2. if `observability.logging` is falsy → `createLogger({ level: 'info' })`
      (a `FrameworkLogger` no-op);
   3. otherwise the `@oneunit/logger` adapter (`createOneUnitLogger`, mode
      `development` for trace/debug levels, else `production`);
   4. on any failure (e.g. `@oneunit/logger` not installed) →
      `createLogger({ level, serviceId, instanceId })` (a `FrameworkLogger`
      no-op with base bindings). The framework **never** instantiates Pino.
7. **Kafka messaging** — if `config.adapters.kafka.enabled`,
   `createKafkaMessaging` builds a `KafkaMessaging` facade over
   `createKafkaClient`. Initialization failure is logged and **re-thrown**
   (fail-closed, never silently skipped). Note: `createKafkaClient` only
   supports the `@oneunit/kafka` driver — the `driver` field of the Kafka
   config is ignored at this layer (see §11.1).

`MicroserviceApp` exposes `service`, `config`, `registry`, `identity`,
`authorization`, `lifecycle`, `logger`, optional `kafka`, plus
`start()`, `stop()`, `getTransport(name)`, `registerTransport(transport)`,
`unregisterTransport(name)`.

`app.start()`:

1. `registry.register(identity.getRegistration())` — registers the service
   lease.
2. `lifecycle.setHooks({ onStop })` where `onStop` deregisters the lease and
   disconnects Kafka messaging.
3. `lifecycle.start()`.

`app.stop()`: disconnects Kafka messaging, then `lifecycle.stop()`.

### 4.2 `lifecycle.ts` — state machine

`LifecycleManager extends EventEmitter`.

**States** (`LifecycleState`): `initialized` → `starting` → `running` →
`stopping` → `stopped`, with `failed` reachable from `starting`. There is
**no `degraded` state**; degradation is reported through the `degraded`
**event**, which is emitted with the list of unhealthy transport names when
a periodic health check finds `status: 'unhealthy'` transports.

**Transitions and events:**

| Method | Behavior |
|---|---|
| `start()` | Allowed only from `initialized` or `stopped` (else `INVALID_STATE`/`CONFIGURATION` error). Sets `starting`, runs `hooks.onStart`, starts transports, starts the periodic health-check timer, sets `running`, emits `started`. On transport failure: emits `transportStartError`, wraps in `TRANSPORT_START_FAILED`/`TRANSPORT` (non-retryable), sets `failed`, re-throws. |
| `stop()` | Idempotent from `stopping`/`stopped`. Sets `stopping`, stops the health-check timer, closes transports in **reverse start order**, runs `hooks.onStop`, sets `stopped`, emits `stopped`. Close errors are collected; if any occurred, throws `STOP_ERRORS`/`INTERNAL` aggregating all messages. |
| `healthCheck()` | Returns `Record<string, TransportHealth>`; per-transport failures map to `unhealthy` entries; `hooks.onHealthCheck` result is published under the `'application'` key. |

**Events:** `stateChange`, `started`, `stopped`, `transportStarted`,
`transportStartError`, `transportStopped`, `transportStopError`,
`healthCheck`, `healthCheckError`, `degraded`.

**Transport ordering:** `sortByDependencies` performs a DFS over transport
names; the `capabilities.bidirectional` branch is a documented no-op
placeholder, so the effective order is **registration order**. There is no
real topological sort in the current implementation.

**Health-check timer:** `setInterval(healthCheckIntervalMs)` (default 30000);
emits `healthCheck` with the full map and `degraded` with unhealthy names.

### 4.3 `capabilities.ts` — capability contracts

- `TransportCapabilities`: six booleans — `requestResponse`, `streaming`,
  `publishSubscribe`, `durableDelivery`, `orderedDelivery`, `bidirectional`.
  Every adapter declares its capabilities statically (§11).
- `Transport`: `{ readonly name; readonly capabilities; start(); close();
  healthCheck(): Promise<TransportHealth> }`.
- `TransportHealth`: `{ status: 'healthy'|'degraded'|'unhealthy'; checkedAt;
  details? }`.
- `TransportMetrics`: counters (`messagesSent/Received`, `bytesSent/Received`,
  `errors`) and a `latencyMs` histogram object (`min/max/avg/p50/p95/p99`).
- RPC contracts: `RpcClient.call/stream`, `RpcServer.registerMethod/
  unregisterMethod`, `RpcMethodHandler`, `RpcContext` (`serviceId`,
  `correlationId`, `headers`, `metadata`).
- Messaging contracts: `MessagePublisher.publish`, `MessageSubscriber.subscribe/
  unsubscribe`, `MessageHandler`, `MessageContext` (`topic`, `correlationId`,
  `traceContext`, `headers`), `PublishOptions` (`key`, `headers`,
  `priority`), `SubscribeOptions` (`groupId`, `fromBeginning`, `autoAck`).
- Stream/datagram contracts: `StreamTransport.openStream` → `DuplexStream`
  (`write/read/close`); `DatagramTransport.send/onMessage`.

### 4.4 `errors.ts` — error model

`MicroserviceError` (interface) and `MicroserviceErrorImpl` (class) carry:
`code` (string), `category` (union of 20 categories), `retryable` (boolean),
`retryableRecommendation?`, `details?`, `nativeCode?`, `nativeDetails?`,
`operationId?`, `correlationId?`, `retryAfterMs?`. Stack traces are captured
via `Error.captureStackTrace`.

**Categories (20):** `UNAUTHENTICATED`, `AUTHENTICATION`, `FORBIDDEN`,
`AUTHORIZATION`, `INVALID_ARGUMENT`, `VALIDATION`, `NOT_FOUND`,
`DEADLINE_EXCEEDED`, `TIMEOUT`, `UNAVAILABLE`, `RESOURCE_EXHAUSTED`,
`CONFLICT`, `RATE_LIMITED`, `CANCELLED`, `INTERNAL`, `CONFIGURATION`,
`DEPENDENCY_UNAVAILABLE`, `CONNECTION`, `TRANSPORT`, `PROTOCOL`.

Helpers: `createMicroserviceError`, `ErrorCodes` map, `isMicroserviceError`
(duck-typed on `code`/`category`/`retryable`), `isRetryableError`,
`isRetryableRecommendation`, `getErrorCategory`, `mapNativeError` (wraps a
native error, preserving `{ message, name }` as `nativeDetails` via
`sanitizeErrorDetails` — stack traces are never serialized).

### 4.5 `client.ts` / `server.ts`

- `MicroserviceClient` implements `RpcClient`, `MessagePublisher`,
  `MessageSubscriber`. It holds a transport map and selects transports
  **by capability**: `getRpcTransport()` returns the first transport with
  `requestResponse: true`; `getMessagingTransport()` returns the first with
  `publishSubscribe: true`. Selection is by insertion order; before use, the
  selected transport is **verified at runtime** to actually implement
  `RpcClient.call`/`stream`, `MessagePublisher.publish`, or
  `MessageSubscriber.subscribe`/`unsubscribe` — an over-advertised
  capability fails with a clear error naming the transport instead of an
  unchecked-cast `TypeError`. `RetryPolicy`
  (`maxRetries`, `baseDelayMs`, `maxDelayMs`, `jitter`,
  `retryableCategories`) is accepted in `ClientOptions` but **no retry loop
  is implemented** — calls are single-shot.
- `MicroserviceServer` implements `RpcServer`: a `Map<service,
  Map<method, handler>>` registry with `registerMethod`, `unregisterMethod`,
  `getMethodHandler`, `getAllMethods`. It does not host a network server;
  adapters own their server implementations.

---

## 5. Configuration subsystem (`src/config/`)

### 5.1 `schema.ts` — Zod schemas

`MicroserviceConfigSchema` requires `service`, `security`, `registry`,
`auth`, `observability`, `crypto`; `adapters` is optional (defaults applied
per adapter). Key defaults:

| Section | Defaults |
|---|---|
| `service` | `instanceId` auto-generated UUID; `endpoints: []`; `capabilities: []`; `metadata: {}`; `credentials.type ∈ {x509, jwt, api-key, mtls}` with required `issuedAt`, `issuer` |
| `security` | `authenticationEnabled: true`, `encryptionMode: 'selective'`, `keyRotationIntervalMs: 86400000`, `sessionTimeoutMs: 3600000` |
| `registry` | `backend: 'memory'`, `ttlMs: 30000`, `heartbeatIntervalMs: 10000`, `healthCheckIntervalMs: 30000`, `maxServices: 1000`; `redis.driver ∈ {oneunit, ioredis, node-redis, auto}` default `auto`, host `localhost`, port `6379`, Sentinel fields optional |
| `auth` | `type: 'allowlist'`, `entries: []`, `defaultPolicy: 'deny'`, optional `roles`/`serviceRoles` maps |
| `observability` | all four flags `true`, `logLevel: 'info'` (no `fatal`), `prettyLogs: false` |
| `crypto` | `rootKey` (string ≥ 32 chars), `algorithm: 'aes-256-gcm'`, `keyDerivation: 'hkdf-sha256'`, rotation/session timeouts |
| `adapters.kafka` | `enabled: false`, `driver: 'auto'`, `brokers: ['localhost:9092']`, `clientId: 'microservice'`, `topics.prefix: 'microservice'`, optional `security.{ssl, sasl}` |
| `adapters.nats` | `servers: ['nats://localhost:4222']`, `subjects.prefix: 'microservice'`, optional `jetstream.{enabled, streamName}`, `auth.{user, pass, token, nkey, creds}`, `tls: false` |
| `adapters.tcp` | `host: '0.0.0.0'`, `port: 8080`, `maxFrameSize: 16777216` (16 MiB), `connectionTimeout: 5000`, `idleTimeout: 60000` |
| `adapters.udp` | `port: 8081`, `maxPacketSize: 65507`, `ttl: 1`, optional `multicast.{address, interface}` |
| `adapters.trpc` | `endpoint: 'http://localhost:3000/trpc'`, `cors: false` |
| `adapters.grpc` | `endpoint: 'localhost:50051'` |
| `adapters.connect` | `endpoint: 'http://localhost:3000'` |

**Algorithm note:** `crypto.algorithm` accepts `'aes-256-gcm'` and
`'chacha20-poly1305'`; both are functional AEAD choices. Node.js Web Crypto
cannot **import raw** ChaCha20-Poly1305 keys (`importKey` rejects the raw
format), so `EncryptionService` implements `chacha20-poly1305` with the
stable `node:crypto` stream ciphers (`createCipheriv`/`createDecipheriv`,
16-byte auth tag) while returning the same `{ ciphertext, nonce, tag }`
result shape as AES-GCM.

### 5.2 `loader.ts` — loading precedence

`loadConfig(configPath?)`:

1. Path resolution: `configPath` → `process.env.CONFIG_PATH` →
   `resolve(cwd, 'config.json')`.
2. `readFileSync` + `JSON.parse`. On `ENOENT`, falls back to
   `buildConfigFromEnv()`; other parse/read errors throw.
3. `MicroserviceConfigSchema.safeParse` — validation errors are formatted as
   `path: message` lines and thrown.

`buildConfigFromEnv()` maps environment variables: `SERVICE_*`,
`SECURITY_*`, `REGISTRY_*`, `REDIS_*`, `AUTH_*`, `OBSERVABILITY_*`,
`CRYPTO_*`, `KAFKA_*`, `NATS_*`, `TCP_*`, `UDP_*`, `TRPC_*`, `GRPC_*`,
`CONNECT_*` (comma-separated lists for brokers/servers/endpoints).

**Current effective precedence:** config file (or env-built config when the file is
absent) → Zod schema defaults → programmatic overrides from
`createMicroservice({ config })` (shallow, post-validation). Environment
variables are **not** merged on top of an existing config file — they are the
fallback when no file exists.

**Implemented policy:** deterministic precedence — schema defaults <
environment < config file < explicit programmatic overrides
(`mergeConfig` in `src/config/loader.ts`). Plain objects deep-merge
field by field; arrays, scalars, and security-sensitive objects
(`credentials`) are replaced deliberately. The final normalized
configuration is validated once more with the full schema and
returned frozen (`DeepPartial<MicroserviceConfig>` overrides).

`createDefaultConfig(overrides?)` = `mergeConfig(loadConfig(),
overrides)`.

---

## 6. Contracts subsystem (`src/contracts/`)

- **`messages.ts`** — `MessageEnvelope<TPayload>`: `version: 1`, `messageId`,
  `type`, `schemaVersion`, `source: { serviceId, instanceId }`, optional
  `destination`, `timestamp`, optional `correlationId`/`traceContext`,
  `payload`. `createMessageEnvelope` factory (UUID messageId, default
  schemaVersion 1). `validateMessageEnvelope` performs structural (non-Zod)
  validation of the envelope shape. `EncryptedEnvelope` (`cipherSuite`, `keyId`,
  `nonce`, `ciphertext`, `tag`, `authenticatedMetadata`, optional `signature`)
  is produced by `EncryptionService.encryptEnvelope` from a
  `MessageEnvelope`: the payload is encrypted and the canonical envelope
  metadata is authenticated as associated data, so routing fields cannot be
  modified without failing authentication. `decryptEnvelope` recovers the
  original envelope. The optional `signature` field is **reserved** for
  signed envelopes and is not populated by the current implementation;
  `keyId` defaults to `'default'` and is not yet bound to `KeyProvider`
  key versions (see §21.2 envelope integration).
- **`events.ts`** — `Event<TPayload>` (`eventId`, `eventType`,
  `schemaVersion`, `source`, `timestamp`, optional correlation/trace,
  `payload`), `EventSubscription` with optional `filter`, `SystemEvents`
  constants (`system.service.registered/deregistered/health_changed`,
  `system.configuration.changed`, `system.security.alert`), `createEvent`
  factory.
- **`procedures.ts`** — `ProcedureContract` (service, method, Zod
  `inputSchema`/`outputSchema`, `description`, `deprecated`, `version`),
  `ProcedureContext`, `createProcedureContract`, `validateProcedureInput/Output`
  (safeParse wrappers returning discriminated results).
- **`schemas.ts`** — Zod schemas for registry data: `ServiceRegistration`
  (UUID serviceId/instanceId, endpoints with `protocol ∈ {tcp, udp, trpc,
  grpc, connect, kafka, nats}`, capabilities, metadata, `registeredAt`),
  `ServiceInstance` (adds `status: {healthy, degraded, unhealthy}`,
  `lastHeartbeat`, `leaseExpiresAt`), `HealthCheck`, `ServiceQuery`
  (`serviceId`, `serviceName`, `status`, `capability`, `limit`), and a `Schemas`
  constant map.
- **`versions.ts`** — `ContractVersion { major, minor, patch }`,
  `parseVersion`/`formatVersion` (strict `major.minor.patch`), `isCompatible`
  (same major, client minor ≤ server minor), `getLatestVersion`,
  `isDeprecated` (same major.minor).

---

## 7. Identity & authorization (`src/identity/`)

### 7.1 `service-identity.ts`

`ServiceIdentity`: `{ serviceId, serviceName, instanceId, credentials }` with
`getRegistration()`, `sign(data)`, `verify(data, signature)`.

- `createServiceIdentity(config)` **preserves the configured
  `config.credentials` block verbatim** — the credential `type` and
  every field (`certificate`, `privateKey`, `jwtSecret`, `apiKey`,
  `caCert`, `issuedAt`, `issuer`, `expiresAt`) survive into the
  identity. Supplied credentials are validated per type at
  construction: `x509`/`mtls` require both `certificate` and
  `privateKey`; `jwt` requires `jwtSecret`; `api-key` requires
  `apiKey`; any other type is rejected. When no credentials are
  configured, a placeholder `x509` block (with `issuedAt`/`issuer`
  defaults) is created whose sign/verify operations fail until
  material is supplied. `instanceId` is always freshly generated
  (the schema default is overridden), so each process instance
  registers a unique instance.
- `sign`/`verify` use Web Crypto `RSASSA-PKCS1-v1_5` with SHA-256.
  Key material may be **PEM text** (decoded from the Base64 payload
  between `-----BEGIN…-----`/`-----END…-----` headers to DER) or,
  for backwards compatibility, a string holding raw DER bytes. For
  full X.509 certificate parsing use `X509Authenticator` (§7.3),
  which uses `node:crypto`'s `X509Certificate`.
- `createIdentityFromCredentials(serviceId, serviceName, credentials)` builds an
  identity from an explicit credential object (registration has empty
  endpoints/capabilities/metadata).

### 7.2 `credentials.ts`

`CredentialProvider` (`getCredentials`, `rotateCredentials`,
`revokeCredentials`) and `CredentialStore` (`store`, `retrieve`, `delete`,
`list`) with two implementations: `MemoryCredentialStore` (Map) and
`FileCredentialStore` (`{basePath}/{serviceId}.json`, lazy `fs/promises`
imports, tolerant reads/deletes). `createCredentialProvider('memory' | 'file',
{ path })` factory; rotation refreshes `issuedAt` and shifts `expiresAt` by the
original validity window.

### 7.3 `authentication.ts`

`Authenticator` interface (`authenticate(credentials) → AuthenticationResult`,
`validateIdentity(identity) → boolean`) with three implementations:

- `X509Authenticator(trustedCAs)` — accepts `X.509`/`mtls` credentials; parses
  with `X509Certificate`; rejects expired certificates (`validTo`); when
  trusted CAs are configured, verifies the chain via
  `cert.verify(ca.publicKey)` against each CA; extracts identity from the
  subject `CN` (`CN=([^,]+)`); unknown CN → `'unknown'`.
- `JwtAuthenticator(secret, issuer, audience)` — `jose` `jwtVerify` with
  issuer/audience checks; identity from `sub`/`name`/`jti` claims.
- `ApiKeyAuthenticator` — in-memory `Map<apiKey, {serviceId, serviceName}>`
  with `addKey`/`removeKey`.

`createAuthenticator('x509' | 'jwt' | 'api-key', options)` factory (JWT
requires secret, issuer, audience).

### 7.4 `authorization.ts`

`AuthorizationPolicy.evaluate(context: AuthorizationContext) →
AuthorizationDecision { allowed, reason?, obligations? }` where context is
`{ caller: ServiceIdentity, targetService?, operation, resource?, attributes }`.

- `AllowlistPolicy` — `Map<serviceId, AllowlistEntry>`; an entry must list
  the operation (or `'*'`); optional `allowedTargets`/`allowedResources` are
  checked when present; services without entries fall back to `defaultPolicy`
  (`'deny'` by default). `addEntry`/`removeEntry`/`setDefaultPolicy` mutators.
- `RbacPolicy` — `roles → permissions → operations` maps plus
  `serviceRoles: Map<serviceId, Set<role>>`; a service with no roles is
  denied; first matching role-permission-operation wins.
- `CompositePolicy` — chained policies evaluated in order; the first denial
  short-circuits (logical AND across policies).
- `createAuthorizationPolicy(type, options)` wires entries/roles/serviceRoles
  from config; `composite` chains an `AllowlistPolicy` (if entries given) and
  an `RbacPolicy` (if roles given).

---

## 8. Security & cryptography (`src/security/`)

All primitives use the **Web Crypto API** (`crypto.subtle`). The module
performs no custom cryptography.

### 8.1 `encryption.ts` — AEAD

`SUPPORTED_ALGORITHMS`: `aes-256-gcm` and `chacha20-poly1305` (both
32-byte key, 12-byte nonce, 16-byte tag). AES-GCM runs on Web Crypto;
ChaCha20-Poly1305 runs on `node:crypto` (see the algorithm note in §5.1)
because Web Crypto rejects raw ChaCha20-Poly1305 key import.

`EncryptionService`:

- `create(algorithm, keyMaterial)` imports a raw 32-byte key (non-extractable,
  `['encrypt','decrypt']`); for `chacha20-poly1305` it validates the key
  length and retains the raw key for `node:crypto` instead.
- `generateKey(algorithm)` generates a fresh random key and exports it raw.
- `encrypt(plaintext, associatedData?)` — random 12-byte nonce via
  `crypto.getRandomValues`, AAD passed as `additionalData`; the Web Crypto
  output is split so the **last 16 bytes are the tag** and the preceding
  bytes are the ciphertext; returns `{ ciphertext, nonce, tag }`.
- `decrypt(input)` reassembles ciphertext‖tag and verifies the tag inside
  `crypto.subtle.decrypt` (constant-time; throws on mismatch — unauthenticated
  plaintext is never returned).

`deriveKey(algorithm, password, salt, iterations = 100000)` — **PBKDF2-SHA-256**
key derivation (the only password-based derivation implemented; the config's
`keyDerivation: 'hkdf-sha256'` option is realized separately in
`KeyExchangeService.deriveSessionKeys`).

**Payload size limit:** Node's SubtleCrypto rejects operations over 65,536
bytes; applications must chunk larger messages (documented in the security
verification report, FIND-002).

### 8.2 `key-exchange.ts` — key agreement & session keys

`KeyExchangeService` (static):

- `generateX25519KeyPair()` / `generateEd25519KeyPair()` — Web Crypto key
  pairs with raw-exported public keys.
- `computeSharedSecret(privateKey, peerPublicKey, ownPublicKey)` — raw X25519
  ECDH (32-byte shared secret). **Unauthenticated**: an active MITM can
  substitute public keys. Every method carries JSDoc warnings; the security
  report records this as FIND-001. **Target requirement:** do not use this API
  alone to establish a trusted session. Before production use, bind peer keys
  to verified identities using an authenticated key-exchange protocol or rely
  on a correctly configured TLS 1.3/mTLS channel. Keep raw X25519 explicitly
  labeled as a low-level primitive, not a secure-channel abstraction.
- `deriveSessionKeys(sharedSecret, salt, info)` — HKDF-SHA-256 from the
  shared secret with **purpose separation**: `info ‖ 0x01` → AES-256-GCM
  encryption key, `info ‖ 0x02` → HMAC-SHA-256 signing key, `info ‖ 0x03` →
  HMAC-SHA-256 auth key. Keys are **extractable** (legacy API).
- `deriveSessionKeysNonExtractable(...)` — same derivation returning
  **non-extractable `CryptoKey` objects** (export throws); recommended for new
  code (FIND-006 mitigation).
- `AuthenticatedKeyExchange` interface — extension point for authenticated
  protocols (Noise IK/XX, TLS 1.3, SIGMA, PAKE/OPAQUE) returning
  `AuthenticatedKeyExchangeResult` (non-extractable keys, verified peer static
  public key, transcript hash, protocol identifier). No implementation ships.

### 8.3 `signing.ts`

- `Ed25519SigningService` — sign/verify with Ed25519 (64-byte signatures);
  `create(keyPair?)` generates a fresh pair when omitted.
- `RsaSigningService` — RSASSA-PKCS1-v1_5 SHA-256, default 2048-bit;
  `getPublicKeyPem()` exports SPKI as PEM (via `btoa`).

### 8.4 `key-provider.ts` / `key-rotation.ts`

- `KeyProvider` interface: per-service `getEncryptionKey` (returns an
  `EncryptionService`), `getSigningKey` (`Ed25519SigningService`),
  `getKeyExchangeKey`, `storeKeys`, `rotateKeys`, `revokeKeys`,
  `getKeyVersion`.
- `MemoryKeyProvider(defaultTtlMs = 24h)` — Map-backed; expired keys return
  `null`; `rotateKeys` generates a fresh encryption key + Ed25519 pair +
  X25519 pair, increments `version`, sets `expiresAt = now + TTL`.
- `CompositeKeyProvider` — first-match reads, fan-out writes/rotations/
  revocations.
- `KeyRotationManager(provider, policy)` — per-service `setInterval` timers;
  `rotate()` emits `KeyRotationEvent { serviceId, oldVersion, newVersion,
  rotatedAt }` to listeners (listener exceptions are caught and logged);
  `rotateAll()`, `setPolicy`, `isRunning`. Defaults: `intervalMs` 24h,
  `gracePeriodMs` 1h, `maxVersions` 3, `autoRotate` true. **`gracePeriodMs`
  and `maxVersions` are policy metadata only — they are not enforced** (no
  version history is retained).

### 8.5 `replay-protection.ts`

`ReplayProtection` — sliding-window duplicate detection:

- Storage: `Map<source, Set<`${source}:${id}`>>` plus a `timestamps` map.
- `checkAndStore(messageId: { id, timestamp, source })` rejects timestamps
  older than `ttlMs` (default 5 min) and newer than `futureSkewMs` (default
  10 s); duplicates are rejected; when a source reaches `maxEntries`
  (default 100,000) the oldest 50% of that source's entries are evicted.
- Periodic cleanup timer at `ttlMs` intervals purges expired entries and
  empty source sets.
- `isReplay`, `getStats`, `start`/`stop`.
- `windowSize` (default 10,000) is accepted in config but **unused** — only
  `maxEntries` bounds storage.

### 8.6 `crypto-types.ts` and `src/crypto/`

`crypto-types.ts` defines branded types (`SymmetricKey`, `Nonce`, `AuthTag`)
and a parallel `SUPPORTED_ALGORITHMS` table (adds `x25519`, `ed25519`,
`hkdf-sha256` rows). It is **not** re-exported from `security/index.ts`.
`src/crypto/index.ts` declares interface-only abstractions (`KeyManager`,
`EncryptionService`, `SigningService`, `KeyExchangeService`, `CryptoProvider`,
`CryptoConfig`, `CRYPTO_EVENTS`) with **no implementation** — a seam for a
future unified crypto provider.

---

## 9. Registry & discovery (`src/registry/`)

### 9.1 `registry.ts`

`ServiceRegistry` interface: `register(registration) → ServiceLease`,
`renew(leaseId)`, `discover(query)`, `deregister(leaseId)`,
`getInstance(leaseId)`, `updateHealth(health)`. `ServiceLease` = `{ leaseId,
serviceId, instanceId, expiresAt, ttlMs }`.

`ServiceRegistryImpl(store, defaultTtlMs = 30000)`:

- `register` mints a UUID `leaseId`, computes `expiresAt = now + ttlMs`,
  writes a `ServiceInstance` with `status: 'healthy'` to the store.
- `renew` delegates to the store's atomic renewal and throws
  `Lease not found` / `Lease expired` / `Lease renewal conflict` on the
  corresponding store results, otherwise extends
  `lastHeartbeat`/`leaseExpiresAt`.
- `updateHealth` delegates to `store.updateInstanceHealth`, which finds the
  canonical record matching `serviceId` + `instanceId` and updates its
  `status` and `lastHeartbeat` **in place** under the original `leaseId`
  key. Unknown or expired instances are a no-op (the registry resolves
  without throwing).

`RegistryStore` interface: `set/get/delete/query/expire/renew/
updateInstanceHealth`. `renew` returns a `LeaseRenewalResult`
(`'renewed' | 'not-found' | 'expired' | 'conflict'`);
`updateInstanceHealth` returns whether a matching live instance was found.

`InMemoryRegistryStore`: Map + per-lease `setTimeout` expiry timers (cleared
on delete); renewal reschedules the expiry timer; `query` filters by
`serviceId`, `serviceName`, `status`, `capability`, drops expired leases,
honors `limit`. `serviceName` is an optional `ServiceInstance` field
(`ServiceInstanceSchema`), so `serviceName` queries match instances that
declare one.

### 9.2 `leases.ts`

`DefaultLeaseManager` adapts `ServiceRegistry` to a `LeaseManager` interface
(`acquire`/`renew`/`release`/`getLease`/`isExpired`); `getLease` computes
remaining `ttlMs` from `leaseExpiresAt`.

### 9.3 `discovery.ts`

`ServiceDiscovery(registry, { cacheTtlMs = 5000, maxCacheSize = 100 })`:

- Client-side cache keyed by `JSON.stringify(query)`; entries younger than
  `cacheTtlMs` are returned with `fromCache: true`.
- Eviction is FIFO when `maxCacheSize` is reached.
- `getInstance`, `getHealthyInstances` (status filter), `invalidateCache`,
  `getCacheStats`.
- Results are snapshots and may be stale — callers must handle endpoint
  churn (per AGENTS.md §8.1).

### 9.4 `health.ts`

`DefaultHealthChecker(registry)`: per-service checker functions
(`registerChecker`) take precedence; otherwise the instance is looked up and
`healthy` if `now - lastHeartbeat < 60000`, else `degraded`; missing
instances are `unhealthy`. `checkAll` aggregates, mapping checker exceptions
to `unhealthy`.

### 9.5 Redis backend (`src/registry/redis/`)

- `types.ts` — `RedisDriver = 'oneunit' | 'ioredis' | 'node-redis' | 'auto'`,
  `RedisAdapterConfig` (host, port, password, db, tls, keyPrefix, Sentinel
  fields), `RedisDriverModule { createStore }`.
- `driver-resolver.ts` — `resolveRedisDriver(config)`: explicit values are
  honored; `auto` tries **oneunit → ioredis → node-redis**, aggregating all
  three failure messages into a single error. Each loader verifies the
  expected exports (`@oneunit/redis`: `createClient` — the current package
  export — with `createRedisClient`/`RedisClient` accepted as aliases;
  ioredis: default/`Redis`; node-redis: `createClient`) and throws an
  actionable "not installed" message on module-resolution failure. No silent
  fallback after explicit selection.
- `adapter.ts` — `RedisRegistryStore`: driver-agnostic facade with **lazy
  connection**; every operation throws `'Redis store not connected'` until
  `connect()` resolves the driver and creates the driver store.
  `createRedisStore(config)` connects eagerly.
- Driver adapters (`oneunit/`, `ioredis/`, `node-redis/adapter.ts`) share
  identical semantics: key = `${keyPrefix ?? 'microservice:registry:'}${leaseId}`;
  `set` writes `JSON.stringify(instance)` with `EX ceil(remaining ttl)` (atomic
  per key); `get`/`delete` map to `GET`/`DEL`; `query` runs `KEYS prefix*`
  then a `MULTI`/`EXEC` pipeline of `GET`s and filters **client-side** by
  serviceId/serviceName/status/capability/expiry/limit. `KEYS` can block Redis
  and scale poorly with a large keyspace; **target requirement:** use a bounded
  scan or, preferably, maintained indexes designed for the supported query
  patterns. ioredis supports Sentinel
  (`sentinels`, `name`, `sentinelPassword`) with `lazyConnect: true`.
  **Lease renewal is atomic:** a Lua script (`EVAL`) performs the
  existence check, expiry check, field update, and TTL reset in a single
  server-side evaluation, so concurrent renewals cannot interleave a stale
  read with a write. `updateInstanceHealth` scans keys, matches the
  canonical `serviceId` + `instanceId` record, and rewrites it with the
  remaining TTL (health writes are idempotent; last writer wins).
- `redis-client.ts` — an alternative `RedisClient` facade over
  `@oneunit/redis` only, with module-level caching
  (`cachedRedisClient`, `resetRedisClient`, `getCachedRedisClient`) and
  key-prefixing helpers. Its `isRedisAvailable()` uses the synchronous
  `import.meta.resolve` ESM check (`require.resolve` is not part of
  the ESM module system). Under module runners that do not expose
  `import.meta.resolve` (e.g. bundler test pipelines) the check
  conservatively reports unavailable.

**Lazy-connect proxy:** `createRegistry` wraps `RedisRegistryStore` in a
`Proxy` that calls `connect()` on the first method invocation, so constructing
the app does not open a socket until the registry is actually used.

---

## 10. Transport abstraction (`src/transport/`)

- `transport.ts` — `BaseTransport` abstract class: stores `name`,
  `capabilities`, a `started` flag; declares abstract `start`/`close`/
  `healthCheck`; provides `isStarted()`. All adapters extend it.
- `manager.ts` — `TransportManager`: registration with duplicate-name
  detection (plain `Error`), `get`/`getAll`/`getByCapability`, `startAll`/
  `stopAll` with error aggregation, `healthCheckAll`, per-transport metrics
  records, optional periodic health checks. `send(protocol, to, message)` and
  `broadcast(protocol, message, exclude)` are **stubs** (`send` throws
  `'not implemented on base transport'`; `broadcast` is a no-op loop) —
  routing is the application's responsibility.
- `capabilities.ts` — re-exports the core capability types.

---

## 11. Protocol adapters (`src/adapters/`)

All adapters extend `BaseTransport` and declare static capabilities. Client
libraries are imported with **dynamic `await import()` inside methods**, so
importing the package never loads them (§17).

### 11.1 Kafka (`adapters/messaging/kafka/`)

**Two drivers, explicit selection, no silent switch:**

| `driver` | Behavior |
|---|---|
| `oneunit` | Loads `@oneunit/kafka`; fails clearly if absent |
| `kafkajs` | Loads `kafkajs` regardless of `@oneunit/kafka` presence |
| `auto` | Tries `@oneunit/kafka` → `kafkajs`, aggregating both errors |

- `adapter.ts` — `KafkaTransport` (name `'kafka'`; capabilities:
  `publishSubscribe`, `durableDelivery`, `orderedDelivery` = true). `start()`
  resolves the driver, creates the driver adapter, and starts it; `publish`/
  `subscribe`/`unsubscribe` require a started transport; `healthCheck`
  reports `unhealthy` when not started. `getResolvedDriver()` exposes the
  resolved driver (class field initializes to `'kafkajs'` before `start()`).
- `driver-resolver.ts` — validates driver exports (`@oneunit/kafka` must
  export `createKafkaClient` or `KafkaClient`; `kafkajs` must export
  `Kafka`) and throws actionable messages on missing packages.
- `oneunit/adapter.ts` — wraps `createKafkaClient({ brokers, clientId, ssl?,
  sasl? }, { logger })`, `getProducer(config.producer)`, and
  `consume(topic, handler, { groupId })`. Topic names are prefixed
  (`${topics.prefix}.${topic}`); default consumer group is
  `${clientId}-${topic}`. The handler receives `{ topic, partition, offset,
  headers }`; on success the message is **acknowledged via `payload.ack()`**
  and on failure **`payload.nak()`** — unless `options.autoAck` is set, in
  which case the application owns acknowledgment.
- `kafkajs/adapter.ts` — `new Kafka({ brokers, clientId, ssl?, sasl? })`;
  `start()` connects a producer; `publish` sends
  `{ topic, messages: [{ key, value: JSON.stringify(message), headers }] }`
  (**JSON serialization** — the oneunit driver passes the message object
  through); `subscribe` connects a consumer, subscribes with
  `fromBeginning`, and runs `eachMessage` with `JSON.parse`; KafkaJS
  auto-acknowledges natively and the `autoAck` option is not implemented.
- `kafka-client.ts` — high-level `KafkaClient` facade (module-level cache
  with `resetKafkaClient`/`getCachedKafkaClient`). **Honors the
  `driver` config field**: the facade resolves the driver through the
  same `resolveKafkaDriver` used by the transport (`oneunit` →
  `@oneunit/kafka`, `kafkajs` → KafkaJS, `auto` → oneunit then
  kafkajs) and delegates `publish`/`subscribe`/`unsubscribe`/
  `disconnect` to the resolved driver adapter. An explicit selection
  never silently falls back to another driver; failures are cached and
  rethrown. `isKafkaAvailable()` uses the synchronous
  `import.meta.resolve` ESM check.

### 11.2 NATS (`adapters/messaging/nats/`)

`NatsTransport` — **single-driver** integration (no driver selection; the
`nats` package is imported statically at module top level, so this adapter is
only reachable via the `./adapters/messaging/nats` subpath export).

- `start()` connects with `servers`, `name`, and any of `user`/`pass`/
  `token`/`nkey`/`creds`, plus `tls`; obtains a JetStream context when
  `jetstream.enabled`.
- Capabilities: `requestResponse: false` — **`request()` is
  not implemented**, so the transport advertises
  publish/subscribe only. **Target requirement (for a
  future change):** implement request/reply with timeout,
  cancellation, correlation, and error semantics before
  advertising `requestResponse: true`.
- `publish` — subject `${subjects.prefix}.${topic}`, JSON-encoded; JetStream
  publish when enabled, core publish otherwise.
- `subscribe` — JetStream: durable consumer named
  `${clientName}-${topic}` with `ackPolicy: 'explicit'` (or `'none'` when
  `autoAck`); core: plain subscribe. Messages are JSON-decoded and acked
  (`msg.ack()`) or nacked (`msg.nak()`) after handler completion when the
  application does not own acknowledgment.
- `close()` unsubscribes all subscriptions and **drains** the connection.

### 11.3 TCP (`adapters/network/tcp/`)

`TcpTransport` (capabilities: `requestResponse`, `streaming`,
`orderedDelivery`, `bidirectional`):

- `start()` dynamically imports `net`, `tls`, `fs`. TLS mode requires `cert`
  + `key` (throws otherwise); a configured `ca` enables
  `requestCert`/`rejectUnauthorized` (mTLS). Listens on `host:port`.
- **Framing:** 4-byte big-endian unsigned length prefix followed by exactly
  `length` payload bytes. `maxFrameSize` (default 16 MiB) is enforced
  **before** slicing; an oversized frame destroys the socket. Partial
  headers/payloads and multiple frames per chunk are handled by an internal
  accumulation buffer per connection.
- `openStream(remote)` dials `host:port` (TLS when configured) with
  `connectionTimeout` via `socket.setTimeout`; returns a `TcpConnection`
  (`write` prepends the length header and updates metrics; `read` returns
  one complete frame per call, `null` on close/oversize; `close` destroys).
- Metrics: `messagesSent/Received`, `bytesSent/Received` (including the 4-byte
  header), `errors`.
- **Not implemented:** `idleTimeout` (accepted in config, never applied) and
  explicit backpressure/`drain` handling (writes are fire-and-forget).
- `frame-parser.ts` — a socket-independent `TcpFrameParser` (`feed(chunk) →
  { frames, error }`, `bufferedBytes`, `reset`) and `encodeTcpFrame(data)`;
  unit-tested directly against raw byte sequences.

### 11.4 UDP (`adapters/network/udp/`)

`UdpTransport` (capabilities: `publishSubscribe`, `bidirectional`; no
ordering/durability):

- `start()` creates a `udp4` socket with `reuseAddr`, binds, and — when
  `multicast` is configured — joins the group, sets multicast TTL
  (`ttl`, default 1) and enables loopback.
- `send(data, target, port)` rejects packets larger than `maxPacketSize`
  (default 65,507) before calling `socket.send`.
- `onMessage(handler)` receives `{ data, source: { address, port } }`.
- `close()` drops multicast membership and closes the socket.

### 11.5 tRPC (`adapters/rpc/trpc/`)

`TrpcTransport` (capabilities: `requestResponse`, `orderedDelivery`):

- `start()` uses `initTRPC().router(config.router)` and the standalone
  `createHTTPServer` adapter, then `listen(endpoint)`. `createContext`
  returns `{}` — **authentication context must be supplied by the
  application's own middleware**, not client-supplied context.
- `call()` lazily builds a `createTRPCProxyClient` with `httpBatchLink`
  and invokes `client[service][method](input)`.
- `stream()` throws `'Streaming not supported in tRPC transport'`.
- `registerMethod`/`unregisterMethod` store handlers in a map, but they are
  **not wired into the tRPC router** (the router comes from `config.router`).

### 11.6 gRPC (`adapters/rpc/grpc/`)

`GrpcTransport` (capabilities: `requestResponse`, `streaming`,
`orderedDelivery`, `bidirectional`):

- `start()` loads the proto with `@grpc/proto-loader` (`loadSync` with
  `keepCase: true`, `longs: String`, `enums: String`, `defaults: true`,
  `oneofs: true`), `loadPackageDefinition`, and registers
  `methodHandlers` onto `grpc.Server` via `addService`. Server credentials:
  `ServerCredentials.createSsl(null, [], true)` when `tls`, else
  `createInsecure()`; binds with `bindAsync` and `start()`.
- Registered handlers are wrapped into gRPC handlers that build an
  `RpcContext` (`correlationId` from the `correlation-id` metadata entry or
  a fresh UUID) and bridge callback-style gRPC calls to the promise-based
  `RpcMethodHandler`.
- `call()` lazily constructs the client constructor for the service with
  `credentials.createSsl()`/`createInsecure()` and bridges the callback to a
  promise; `stream()` returns an `AsyncIterable` over the client stream.
- `close()` uses `tryShutdown` and closes the client.

### 11.7 Connect RPC (`adapters/rpc/connect/`)

`ConnectTransport` (capabilities: `requestResponse`, `streaming`,
`orderedDelivery`, `bidirectional`):

- `start()` creates a `createPromiseClient` from `@connectrpc/connect`
  using the application-supplied `transport` (from
  `@connectrpc/connect-node`, e.g. `createGrpcTransport`/`createConnectTransport`)
  and converts `config.services` (a `Map`) into a service-definition object.
- `call()`/`stream()` invoke the promise client; `stream()` iterates the
  returned stream.
- `registerMethod`/`unregisterMethod` store handlers, but the transport
  **does not host a server** — server hosting is the application's
  responsibility through `@connectrpc/connect-node`.

### 11.8 Logging adapters (`adapters/logging/`)

- `shared/adapter-utils.ts` — normalization helpers
  (`normalizeArgs` handles message-first and context-first call forms),
  `createLogFn`, `createErrorFn`/`createFatalFn` (detect `Error`
  instances and forward them positionally), `createChildFn`, and
  `adaptLogger` (assembles the `Logger` contract object).
- `pino/adapter.ts` — `createPinoLogger(config)`: accepts an existing
  Pino instance (`config.logger`) or lazily imports `pino`; configures
  **secret redaction** on `*.password`, `*.secret`, `*.token`, `*.apiKey`,
  `*.privateKey`, `*.credentials`, `*.authorization`,
  `req.headers.authorization`, `req.headers.cookie` (censor
  `[REDACTED]`); `pretty: true` wires `pino-pretty` as a transport when
  installed (silently skipped otherwise); `serviceId`/`instanceId` become
  Pino child bindings.
- `oneunit/adapter.ts` — `createOneUnitLogger(config)`: lazily imports
  `@oneunit/logger` and adapts it (`mode` development/production/test,
  `serializers`, `childBindings`, `destination`, `pino` options). The
  `@oneunit/logger` import is **type-only**, so loading this module does
  not require the package.

---

## 12. Observability (`src/observability/`)

### 12.1 `logger.ts` — the Logger contract

`Logger` interface: six levels (`trace`…`fatal`), each with **dual
overloads** — `(message, context?)` and `(context, message)` — plus
`error(err, message)` / `fatal(err, message)`; `child(bindings)` returns a
child `Logger`; `level: LogLevel`. Numeric level map: trace 10, debug 20,
info 30, warn 40, error 50, fatal 60.

Implementations:

- `FrameworkLogger` — framework-owned **no-op sink** with level gating and
  immutable base bindings (merged in `child`). This is what
  `createLogger()` returns by default: the framework never creates or
  configures a concrete logger.
- `NoopLogger` — completely silent; `child()` returns `this`.
  `noopLogger` singleton.
- `createLogger(config)` — returns `config.logger` when supplied, else a
  `FrameworkLogger` with optional serviceId/instanceId bindings.
- `createChildLogger(logger, bindings)`.

### 12.2 `metrics.ts`

`InMemoryMetricsCollector` — `incrementCounter` (accumulates into a
counters map **and** appends a sample), `setGauge`, `recordHistogram`,
`recordSummary`; `getMetrics()` returns all recorded samples plus current
counter/gauge totals; per-name sample buffers are capped at **1,000
entries** (FIFO `shift`); label keys are sorted to produce stable
Prometheus-style keys (`name{k="v",…}`). Not wired into transports —
adapters track their own metrics.

### 12.3 `tracing.ts`

`SpanContext`/`Span`/`SpanEvent`/`SpanStatus`/`Tracer` types;
`NoopTracer`; `InMemoryTracer` (tracks `currentSpan`, stores ended spans,
`getSpansByTraceId`); `createTracer('noop' | 'memory')`.
`extractTraceContext(headers)` reads the W3C `traceparent`
(`00-{traceId}-{spanId}-01`) with `x-trace-id`/`x-span-id`/
`x-parent-span-id` fallbacks; `injectTraceContext` writes both formats.
**These helpers are standalone — no adapter currently propagates trace
context**, so end-to-end tracing requires the application to call them.

### 12.4 `audit.ts`

`AuditEvent` (`eventId`, `eventType`, `timestamp`, `actor { serviceId,
instanceId, userId? }`, `action`, `resource { type, id }`, `outcome ∈
{success, failure, partial}`, `details`, `riskLevel ∈ {low, medium, high,
critical}`); `InMemoryAuditLogger` (default cap **10,000 events**, FIFO;
`query` filters by eventType/actor/resource/time window/outcome/riskLevel,
sorted newest-first, with `limit`); `AuditEventTypes` constants
(`service.registered/deregistered`, `credential.rotated`,
`authorization.denied`, `configuration.changed`, `security.alert`,
`data.access/modified`).

---

## 13. Internal utilities (`src/internal/`)

- `ids.ts` — prefixed ID generators: `generateId` (bare UUID),
  `generateServiceId` (`svc-` + 8 hex), `generateInstanceId` (`inst-`),
  `generateMessageId` (`msg-` + UUID), `generateCorrelationId` (`corr-`),
  `generateTraceId`, `generateSpanId` (16 hex chars), `generateLeaseId`
  (`lease-`), `generateKeyId` (`key-` + 12 hex), `generateSessionId`
  (`sess-`).
- `shutdown.ts` — `ShutdownManager extends EventEmitter`: hooks are
  `{ name, priority, handler }` sorted **descending by priority**;
  `shutdown(reason?)` races hook execution against a timeout (default
  **30,000 ms**) and emits `shutdown:started/completed/error` and
  `hook:start/complete/error`; the timeout timer is cleared on both
  the success and failure paths so it cannot fire after a completed
  shutdown; registers process handlers for **SIGTERM,
  SIGINT, SIGUSR2** by default. `gracefulShutdown(services, { timeoutMs })`
  stops services sequentially with a per-service remaining-time budget,
  clears each per-service timeout timer, and aggregates errors.

---

## 14. Data flows & component interactions

### 14.1 Application bootstrap

```text
createMicroservice({ configPath, config, logger })
  │
  ├─ loadConfig()  ── file (CONFIG_PATH / ./config.json)
  │                   └─ ENOENT → buildConfigFromEnv() → Zod defaults
  ├─ Object.assign(config, options.config)   (shallow, post-validation)
  ├─ createServiceIdentity(config.service)
  ├─ createRegistry(config.registry)
  │     ├─ memory → InMemoryRegistryStore (setTimeout expiries)
  │     └─ redis  → RedisRegistryStore wrapped in lazy-connect Proxy
  ├─ createAuthorizationPolicy(config.auth.type, …)
  ├─ new LifecycleManager(healthCheckIntervalMs)
  ├─ createAppLogger()  ── injected logger → @oneunit/logger adapter → FrameworkLogger
  ├─ [adapters.kafka.enabled] createKafkaClient(driver-aware via resolveKafkaDriver) → KafkaMessaging facade
  └─ MicroserviceApp { …, start, stop, registerTransport, … }
```

### 14.2 Startup / shutdown

```text
app.start()                                    app.stop()
  │                                            │
  ├─ registry.register(identity.getRegistration())   ├─ kafkaMessaging.disconnect()
  │    └─ leaseId = uuid; expiresAt = now + ttlMs    │
  ├─ lifecycle.setHooks({ onStop })                  ├─ lifecycle.stop()
  │    onStop: deregister(leaseId) + kafka.disconnect│    ├─ stopHealthChecks()
  └─ lifecycle.start()                               │    ├─ reverse-order transport.close()
       ├─ state=starting; emit                       │    ├─ hooks.onStop() → deregister
       ├─ hooks.onStart()                            │    ├─ state=stopped; emit stopped
       ├─ for name of registration-order:            │    └─ throw STOP_ERRORS if any close failed
       │    transport.start()                        │
       ├─ startHealthChecks() (interval)             └─ (errors during stop are aggregated,
       ├─ state=running; emit started                   never silently dropped)
       └─ on failure → state=failed; throw TRANSPORT_START_FAILED
```

Periodic health check (every `healthCheckIntervalMs`):
`healthCheck()` → per-transport `healthCheck()` + `hooks.onHealthCheck` →
emit `healthCheck` → unhealthy names emitted via `degraded`.

### 14.3 RPC call flow (capability-based routing)

```text
MicroserviceClient.call(service, method, input)
  └─ getRpcTransport(): first registered transport with capabilities.requestResponse
       └─ runtime check: transport implements RpcClient.call/stream
            └─ transport.call(service, method, input)   (tRPC / gRPC / Connect adapter)
```

### 14.4 Messaging flow (Kafka example)

```text
app.kafka.publish('users.created', msg, { key, headers })
  └─ KafkaClient.publish
       └─ topic = `${config.topics.prefix}.users.created`
       └─ oneunit driver: producer.send(topic, msg, { send: { key, headers } })

app.kafka.subscribe('users.created', handler, { groupId })
  └─ groupId default: `${config.clientId}.${topic}`
  └─ client.consume(fullTopic, async payload => {
        try { await handler(payload.message.value, { topic, partition, offset, headers })
              if (!autoAck) await payload.ack()        // oneunit driver
        } catch { logger.error(…); if (!autoAck) await payload.nak() }
     }, { groupId })
```

KafkaJS driver differences: `producer.send({ topic, messages: [{ key,
value: JSON.stringify(message), headers }] })`; consumer uses
`eachMessage` with `JSON.parse(message.value.toString())`; acknowledgment
is native to KafkaJS (no ack/nak control).

NATS flow: subject `${subjects.prefix}.${topic}`, JSON-encoded payload;
JetStream adds durable subscription (`${clientName}-${topic}`) with
explicit ack policy and `msg.ack()`/`msg.nak()` after handler completion.

### 14.5 Registry flow

```text
register:  registration → leaseId(uuid) → instance{status:healthy, leaseExpiresAt: now+ttlMs}
           ├─ memory: store.set + setTimeout(expiry)
           └─ redis:  SET ${prefix}${leaseId} <json> EX <remaining-ttl>

renew:     get(leaseId) → check expiry → set(leaseId, {…instance, lastHeartbeat: now,
           leaseExpiresAt: now+ttlMs})          (read-then-write; not atomic in Redis)

discover:  ServiceDiscovery.discover(query)
           ├─ cache hit (< 5s old) → { instances, fromCache: true }
           └─ registry.discover → store.query(filters) → cache (FIFO evict at 100)
```

### 14.6 Error normalization flow

Adapters throw native errors or `MicroserviceError`s. `mapNativeError`
wraps a native error into `MicroserviceError` preserving
`nativeDetails: { message, name }` (never stack traces) plus optional
`operationId`/`correlationId`/`retryAfterMs`. Consumers branch on
`isMicroserviceError` → `category`/`retryable`/`retryableRecommendation`.

---

## 15. Design patterns & implementation conventions

1. **Dependency inversion** — core owns contracts (`Logger`, `Transport`,
   `RegistryStore`, `AuthorizationPolicy`, `MessagePublisher/Subscriber`);
   applications inject concrete loggers; adapters own concrete client
   imports behind optional boundaries.
2. **Driver-resolver pattern** (Kafka, Redis) — a `resolveXDriver(config)`
   function maps an explicit `driver` value to a lazily-imported adapter
   module; `auto` tries candidates in a documented order and **aggregates
   all failure messages**; explicit selection is never silently switched.
3. **Lazy ESM dynamic import** — every optional peer dependency is imported
   with `await import()` inside a function, keeping the core entry loadable
   without any optional package installed (verified by
   `test/packaging.test.ts` and static analysis of `dist/`).
4. **Lazy-connect proxy** — `createRegistry` wraps the Redis store in a
   `Proxy` that connects on first operation, so construction has no side
   effects.
5. **Capability-based transport selection** — `MicroserviceClient` selects
   transports by `TransportCapabilities` booleans rather than concrete types.
6. **Factory + class duality** — every subsystem ships both a class and a
   `createX()` factory (`createRegistry`, `createAuthorizationPolicy`,
   `createAuthenticator`, `createTracer`, …).
7. **Event-emitter lifecycle** — `LifecycleManager` and `ShutdownManager`
   extend `EventEmitter` with typed event names for observability hooks.
8. **Module-level caches with reset hooks** — `KafkaClient` and
   `RedisClient` cache instances module-globally and expose
   `resetKafkaClient()`/`resetRedisClient()` for test isolation.
9. **Structural sharing across driver adapters** — the three Redis driver
   adapters and the two Kafka driver adapters implement identical
   `RegistryStore`/`KafkaDriverAdapter` interfaces, so semantics (key
   prefixing, TTL computation, query filtering) are identical across drivers.
10. **Path aliases resolved at build time** — `@/…` aliases are rewritten by
    `tsc-alias` into relative ESM imports in `dist/` (the published
    artifact contains no alias specifiers).

---

## 16. Security model

- **Default-deny authorization** — `auth.defaultPolicy: 'deny'`; unknown
  services, unlisted operations, and unassigned roles are denied.
- **Authentication before authorization (target invariant)** — authenticators
  verify X.509/mTLS chains (against trusted CAs), JWTs (issuer/audience via
  `jose`), or API keys before policy evaluation. The architecture must verify
  that each inbound adapter actually invokes authentication and authorization;
  standalone authenticator/policy classes do not establish enforcement.
- **AEAD encryption** — AES-256-GCM with random 12-byte nonces and 16-byte
  tags; AAD supported; tag verification is constant-time inside Web Crypto.
- **Key separation** — HKDF-SHA-256 with distinct `info` suffixes
  (`0x01`/`0x02`/`0x03`) for encryption/signing/auth keys; non-extractable
  key variants available.
- **Replay protection** — per-source sliding windows with TTL, future-skew
  tolerance, and bounded storage.
- **Secret hygiene** — Pino adapter redacts the documented secret paths;
  error details are sanitized to `{ message, name }`; audit events never
  contain secret material.
- **Documented residual risks** (from `docs/security/SECURITY-VERIFICATION-REPORT.md`):
  unauthenticated X25519 (FIND-001, extension point via
  `AuthenticatedKeyExchange`), Web Crypto 64 KB payload limit (FIND-002),
  extractable legacy derived keys (FIND-006, mitigated by
  `deriveSessionKeysNonExtractable`).

---

## 17. Packaging & dependency boundaries

**`package.json` exports map (the complete subpath surface):**

| Export | Target |
|---|---|
| `.` | `dist/index.js` (composition root + all core modules + RPC/network adapters) |
| `./adapters/logging/pino` | `dist/adapters/logging/pino/index.js` |
| `./adapters/logging/oneunit` | `dist/adapters/logging/oneunit/index.js` |
| `./adapters/messaging/kafka` | `dist/adapters/messaging/kafka/index.js` |
| `./adapters/messaging/nats` | `dist/adapters/messaging/nats/index.js` |
| `./registry/redis` | `dist/registry/redis/index.js` |

There are **no other subpath exports** — TCP, UDP, tRPC, gRPC, and Connect
adapters are imported from the **main entry** (e.g.
`import { TcpTransport } from '@oneunit/microservice'`), not from subpaths.
The internal barrels (`src/adapters/index.ts`, `src/adapters/messaging/index.ts`)
are not exposed in the exports map.

**Main-entry import graph (static analysis of `dist/`):** the entry
statically imports only internal modules. `kafkajs`, `nats`, `pino`,
`@oneunit/*` appear only as dynamic `await import()` calls inside driver
resolvers/adapters, or in modules unreachable from the entry (the NATS
adapter and the KafkaJS driver adapter are statically imported only within
their own subpath entry points). The unused `import Redis from 'ioredis'` in
`redis-client.ts` is elided by the compiler.

**`.npmignore`** excludes `src/`, `test/`, `coverage/`, source maps, config
files, lockfiles, `AGENTS.md`, `ARCHITECTURE.md`, `docs/`.

**Build:** `tsc && tsc-alias` → `dist/` with `.js`, `.d.ts`, `.d.ts.map`,
`.js.map` per module.

---

## 18. Directory structure

```text
src/
├── index.ts                        # Main entry: re-exports core, contracts, security,
│                                   # registry, transport, rpc+network adapters,
│                                   # observability, internal, config, identity
├── core/                           # Composition root & lifecycle
│   ├── application.ts              # createMicroservice(), MicroserviceApp, KafkaMessaging facade
│   ├── lifecycle.ts                # LifecycleManager state machine + health-check loop
│   ├── capabilities.ts             # Transport/RPC/messaging/stream/datagram contracts
│   ├── errors.ts                   # MicroserviceError, 20 categories, native error mapping
│   ├── client.ts                   # MicroserviceClient (capability-based transport selection)
│   ├── server.ts                   # MicroserviceServer (method registry, no networking)
│   └── index.ts
├── config/                         # Configuration
│   ├── schema.ts                   # Zod schemas for every config section + defaults
│   ├── loader.ts                   # loadConfig (file → env fallback), buildConfigFromEnv,
│   │                               # createDefaultConfig
│   └── index.ts
├── contracts/                      # Shared contracts
│   ├── messages.ts                 # MessageEnvelope, EncryptedEnvelope, validation
│   ├── events.ts                   # Event, EventSubscription, SystemEvents
│   ├── procedures.ts               # ProcedureContract (Zod in/out), validation helpers
│   ├── schemas.ts                  # ServiceRegistration/Instance/HealthCheck (Zod), ServiceQuery
│   ├── versions.ts                 # ContractVersion, compatibility, deprecation
│   └── index.ts
├── identity/                       # Identity, authn, authz
│   ├── service-identity.ts         # ServiceIdentity, createServiceIdentity, x509 sign/verify
│   ├── credentials.ts              # CredentialProvider/Store, memory + file stores
│   ├── authentication.ts           # X509/JWT/API-key authenticators, createAuthenticator
│   ├── authorization.ts            # Allowlist/RBAC/Composite policies, factory
│   └── index.ts
├── security/                       # Cryptographic primitives (Web Crypto only)
│   ├── encryption.ts               # EncryptionService (AES-256-GCM), PBKDF2 deriveKey
│   ├── key-exchange.ts             # X25519/Ed25519, HKDF session keys, AuthenticatedKeyExchange
│   ├── signing.ts                  # Ed25519SigningService, RsaSigningService
│   ├── key-provider.ts             # Memory/Composite key providers
│   ├── key-rotation.ts             # KeyRotationManager (interval timers, events)
│   ├── replay-protection.ts        # Sliding-window replay detection
│   ├── crypto-types.ts             # Branded crypto types (not re-exported from index)
│   └── index.ts
├── registry/                       # Service registry & discovery
│   ├── registry.ts                 # ServiceRegistry, InMemoryRegistryStore, RegistryStore,
│   │                               # createRegistry (lazy Redis proxy)
│   ├── leases.ts                   # DefaultLeaseManager
│   ├── discovery.ts                # ServiceDiscovery (TTL cache, FIFO eviction)
│   ├── health.ts                   # DefaultHealthChecker (60s heartbeat threshold)
│   ├── index.ts
│   └── redis/                      # Redis backend (multi-driver)
│       ├── adapter.ts              # RedisRegistryStore (driver-agnostic, lazy connect)
│       ├── driver-resolver.ts      # resolveRedisDriver (oneunit/ioredis/node-redis/auto)
│       ├── redis-client.ts         # Alternative RedisClient facade (@oneunit/redis only)
│       ├── types.ts                # RedisDriver, RedisAdapterConfig, RedisDriverModule
│       ├── index.ts
│       ├── oneunit/adapter.ts      # @oneunit/redis driver
│       ├── ioredis/adapter.ts      # ioredis driver (Sentinel support)
│       └── node-redis/adapter.ts   # node-redis driver
├── transport/                      # Transport abstraction
│   ├── transport.ts                # BaseTransport abstract class
│   ├── manager.ts                  # TransportManager (registration, health, metrics)
│   ├── capabilities.ts             # Re-exports core capability types
│   └── index.ts
├── adapters/
│   ├── index.ts                    # Internal barrel (not a package export)
│   ├── rpc/
│   │   ├── trpc/index.ts           # TrpcTransport (standalone HTTP server + proxy client)
│   │   ├── grpc/index.ts           # GrpcTransport (proto-loader, callback↔promise bridge)
│   │   ├── connect/index.ts        # ConnectTransport (promise client; no hosted server)
│   │   └── index.ts
│   ├── network/
│   │   ├── tcp/index.ts            # TcpTransport (4-byte BE framing, TLS/mTLS, 16MiB limit)
│   │   ├── tcp/frame-parser.ts     # TcpFrameParser, encodeTcpFrame (socket-independent)
│   │   ├── udp/index.ts            # UdpTransport (multicast, TTL, 65507 limit)
│   │   └── index.ts
│   ├── messaging/
│   │   ├── kafka/
│   │   │   ├── adapter.ts          # KafkaTransport (driver-agnostic)
│   │   │   ├── driver-resolver.ts  # resolveKafkaDriver (oneunit/kafkajs/auto)
│   │   │   ├── kafka-client.ts     # KafkaClient facade (@oneunit/kafka only, cached)
│   │   │   ├── types.ts            # KafkaDriver, KafkaAdapterConfig, KafkaDriverAdapter
│   │   │   ├── index.ts
│   │   │   ├── oneunit/adapter.ts  # @oneunit/kafka driver (ack/nak control)
│   │   │   └── kafkajs/adapter.ts  # KafkaJS driver (JSON serialization)
│   │   ├── nats/index.ts           # NatsTransport (Core + JetStream, single driver)
│   │   └── index.ts
│   └── logging/
│       ├── shared/adapter-utils.ts # Logger adaptation helpers
│       ├── pino/                   # Pino adapter (secret redaction, pino-pretty)
│       ├── oneunit/                # @oneunit/logger adapter (modes, type-only import)
│       └── index.ts
├── observability/
│   ├── logger.ts                   # Logger contract, FrameworkLogger, NoopLogger
│   ├── metrics.ts                  # InMemoryMetricsCollector (1000-sample cap)
│   ├── tracing.ts                  # Noop/InMemory tracers, W3C extract/inject helpers
│   ├── audit.ts                    # InMemoryAuditLogger (10k-event cap)
│   └── index.ts
├── internal/
│   ├── ids.ts                      # Prefixed ID generators
│   ├── shutdown.ts                 # ShutdownManager (priority hooks, signals), gracefulShutdown
│   └── index.ts
└── crypto/
    └── index.ts                    # Interface-only crypto provider abstractions (no impl)
```

---

## 19. Testing architecture

- **Framework:** Vitest 1.6, node environment, `forks` pool with
  `singleFork`, `sequence.hooks: 'list'`; v8 coverage
  (`text`/`json`/`html` reporters).
- **Layout mirrors `src/`:** `test/{adapters,config,contracts,core,identity,
  internal,observability,registry,security,transport}` plus
  `test/packaging.test.ts`.
- **Scale:** 54 test files, ~1,427 tests, all passing
  (`npm test` → `Test Files 54 passed (54); Tests 1427 passed (1427)`).
  One **known pre-existing unhandled rejection** in
  `test/internal/shutdown.test.ts` ("Shutdown timeout") — documented in
  `REFACTOR_REPORT.md` §F and unrelated to feature work.
- **Security tests:** adversarial suites for encryption (bit-flip on
  ciphertext/tag/nonce, AAD mismatch), key exchange (MITM demonstration,
  non-extractable keys), signing, replay protection (future timestamps,
  duplicates, concurrency), authentication/authorization negative cases.
- **Adapter tests:** Kafka (transport + both driver adapters with fakes),
  NATS, TCP framing, RPC adapters (tRPC/gRPC/Connect), logging adapters,
  Redis driver adapters (ioredis/node-redis/@oneunit with fakes).
- **Packaging tests** (`test/packaging.test.ts`): ESM module type,
  `main`/`types` mappings, optional-peer classification of
  `@oneunit/kafka`/`@oneunit/redis`, script contract, main entry loads,
  `npm pack` tarball contains `dist/` entry + declarations and **no**
  `src/`, `coverage/`, or source maps.
- **Coverage hot spots:** security (~341 tests), adapters (~205), core
  (~163), registry (~146), identity (~150). Per-module coverage for the
  security subsystem is 91–98% (see the security verification report).

---

## 20. Implementation status & known limitations

This section records the behavior described by the current implementation
snapshot. It must be updated after source changes and verified by tests.

**Implemented and unit-tested (per the current document):** composition root,
lifecycle state machine, capability contracts, error model, configuration
(Zod + environment), contracts (envelopes, events, procedures, versions),
identity/authentication/authorization building blocks, AEAD encryption, key
agreement, signing, key provider/rotation, replay protection, in-memory and
Redis registry stores, discovery caching, health checking, transport base and
manager, TCP/UDP adapters, Kafka (two drivers), NATS, tRPC/gRPC/Connect
adapters, logger contract and adapters, in-memory metrics/tracing/audit, ID
generators, and shutdown coordination.

This list means the features exist in the implementation; it does **not**
assert complete end-to-end integration or production readiness.

**Known gaps in the current snapshot:**

1. ~~No `degraded` lifecycle state (event only).~~ **Fixed:** `LifecycleState` includes `degraded` as a sub-state of `running`; the health-check loop transitions `running`→`degraded` when any transport reports `unhealthy` and `degraded`→`running` when every transport recovers; `stop()` is valid from `degraded`; `start()` is rejected from `degraded`.
2. ~~Transport startup ordering is registration order; dependency sorting is a placeholder.~~ **Fixed:** the placeholder sort was removed; startup order is registration order (documented), and shutdown runs in reverse registration order. Transport dependencies are not a public concept.
3. ~~NATS advertises `requestResponse` without implementing request/reply.~~ **Fixed:** the NATS transport advertises `requestResponse: false`; `MicroserviceClient` verifies at runtime that the selected transport implements the required interface before use.
4. ~~TCP `idleTimeout` is not applied.~~ **Fixed:** established connections apply the configured `idleTimeout` (`socket.setTimeout`); explicit backpressure/`drain` handling is still absent.
5. ~~Redis health updates write a shadow entry; `serviceName` queries do not match.~~ **Fixed:** health updates modify the canonical record in place; `serviceName` is a first-class optional `ServiceInstance` field and is filtered in every store implementation.
6. Redis lease renewal is read-then-write, not atomic; Redis query uses `KEYS`. **Renewal fixed:** atomic Lua-script renewal in all three Redis driver adapters. **KEYS fixed:** discovery queries and health updates now page through cursor-based `SCAN` (`MATCH`/`COUNT 100`) in all three driver adapters and the client wrapper, so a full keyspace scan never blocks the Redis server.
7. ~~`chacha20-poly1305` is accepted by configuration but unsupported by the current Web Crypto implementation.~~ **Fixed:** `EncryptionService` implements ChaCha20-Poly1305 with `node:crypto` (`createCipheriv`/`createDecipheriv`) because Web Crypto cannot import raw ChaCha20-Poly1305 keys; both configured AEAD algorithms are functional.
8. `deriveKey` implements PBKDF2; HKDF is implemented separately for session-key derivation.
9. ~~Key-rotation `gracePeriodMs`/`maxVersions` are not enforced; replay `windowSize` is unused.~~ **Fixed:** replay protection enforces `windowSize` as a per-source sliding window (oldest entry evicted when a new distinct message arrives) with `maxEntries` as a global fail-closed capacity bound; key-rotation `gracePeriodMs`/`maxVersions` are delegated to the key provider via `setRetentionPolicy` (retention enforcement is provider-owned), and `autoRotate` gates the rotation timer.
10. ~~ESM availability checks use `require.resolve` and are broken in ESM contexts.~~ **Fixed:** both `isKafkaAvailable()` and `isRedisAvailable()` use the synchronous `import.meta.resolve` ESM resolution check.
11. ~~`RetryPolicy` is accepted but not executed; `TransportManager.send/broadcast` are stubs.~~ **Fixed:** `MicroserviceClient.call` executes the configured `RetryPolicy` (bounded retries, exponential backoff capped at `maxDelayMs`, optional jitter; only `MicroserviceError` categories listed in `retryableCategories` are retried — errors outside the normalized model fail fast; configure only for idempotent operations). Messaging `publish` is deliberately never retried because delivery is non-idempotent. `TransportManager.send` routes through a transport implementing the new `PointToPointTransport` capability interface; `broadcast(protocol, message, exclude)` publishes the message to the channel named `protocol` on every non-excluded transport implementing `MessagePublisher`; both fail with clear errors instead of unconditional throws.
12. ~~App-level `app.kafka` supports only the `@oneunit/kafka` driver; its `driver` setting is ignored there.~~ **Fixed:** the app-level Kafka facade resolves the configured driver through `resolveKafkaDriver` and delegates to the resolved driver adapter; explicit selections are honored and never silently fall back.
13. Trace propagation is not wired through adapters; metrics and audit are standalone.
14. ~~`uuid` and `ws` are declared but unused; no WebSocket transport is implemented.~~ **Fixed:** both unused runtime dependencies were removed (all identifiers use `crypto.randomUUID()` / Zod `.uuid()`); no WebSocket transport is implemented.
15. ~~`EncryptedEnvelope` is not produced by `EncryptionService`.~~ **Fixed:** `EncryptionService.encryptEnvelope` produces the standard `EncryptedEnvelope` wire contract from a `MessageEnvelope` (payload encrypted, canonical envelope metadata authenticated as AAD, `cipherSuite`/`keyId` recorded); `decryptEnvelope` verifies the tag and metadata authentication and recovers the original envelope.
16. ~~`ServiceIdentity.sign/verify` expect DER key bytes, not PEM; identity construction hardcodes X.509.~~ **Fixed:** PEM key material is decoded to DER before Web Crypto import (legacy DER-byte strings still accepted); configured credential blocks are preserved verbatim and validated per type.
17. tRPC/Connect method registration is not connected to a hosted server/router.
18. External-infrastructure integration tests are not executed in CI.
19. ~~A known unhandled rejection remains in the shutdown timeout test.~~ **Fixed:** the shutdown timeout race now clears its timer on both success and failure paths (no dangling timer after a completed shutdown), and the timeout test attaches its rejection handler before advancing fake timers. The full suite runs with no unhandled rejections.
20. ~~Programmatic configuration overrides are shallow and are not revalidated.~~ **Fixed:** `mergeConfig` deep-merges overrides (arrays/scalars/credentials replaced wholesale), revalidates the final effective configuration with the full schema before any resource is constructed, and returns it frozen.
21. ~~`MicroserviceClient` selects transports with unchecked interface casts.~~ **Fixed:** the client verifies at runtime that the selected transport implements `RpcClient`/`MessagePublisher`/`MessageSubscriber` before use, failing with a clear error instead of an unchecked cast.
22. Key exchange does not authenticate the peer; this is a security risk, not merely a documentation limitation.

---

## 21. Target architecture requirements and remediation plan

The following requirements are normative for future implementation. They are not claims that the current source already satisfies them.

### 21.1 P0 — Correctness and security boundaries

These items block an unconditional production-readiness claim.

- **Authenticated communication:** raw X25519 must not be presented as an authenticated secure channel. Use authenticated key exchange or a correctly configured TLS 1.3/mTLS boundary.
- **Identity correctness:** ~~configured credential types must be preserved and validated. Key formats must be explicit, parsed correctly, and rejected when unsupported.~~ **Resolved:** configured credential blocks are preserved verbatim, per-type required fields are validated at construction, unsupported types are rejected, and PEM key material is decoded to DER for Web Crypto import. Remaining: real X.509 chain validation happens in `X509Authenticator` at transport boundaries (§21.1 inbound enforcement).
- **Registry correctness:** ~~health updates must modify the canonical registered record. Lease renewals must be concurrency-safe.~~ **Resolved:** health updates modify the canonical record in place (in-memory and all three Redis driver adapters); Redis lease renewal is an atomic server-side Lua evaluation; regression tests cover expiry, renewal outcomes (renewed/not-found/expired), health updates, deregistration, and re-registration. Remaining: real-Redis integration tests for renewal races (§21.5).
- **Truthful capabilities:** ~~a transport must advertise only capabilities for which it implements the required operation. Replace unchecked capability-to-interface casts with typed capability interfaces or runtime-validated adapters.~~ **Resolved:** NATS no longer advertises `requestResponse`; `MicroserviceClient` verifies the selected transport implements `RpcClient`/`MessagePublisher`/`MessageSubscriber` at runtime before use, failing with a clear error instead of an unchecked cast.
- **Final configuration validation:** ~~resolve precedence and merge semantics, validate the final object, and fail before creating external resources.~~ **Resolved:** `mergeConfig` implements the documented precedence and merge semantics, validates the final effective configuration with `MicroserviceConfigSchema` before any runtime resource is constructed, and returns a frozen normalized object.
- **Inbound enforcement:** define the authentication and authorization hooks required for every server-capable adapter. Any adapter that cannot enforce the policy must document that limitation and must not be represented as a secure server boundary.
- **Shutdown correctness:** ~~fix the known unhandled rejection and verify cleanup after partial startup, timeouts, and multiple close failures.~~ **Resolved:** the `ShutdownManager` timeout race clears its timer on both the success and failure paths (deterministic timer cleanup per §21.4); the timeout test attaches its rejection handler before advancing fake timers; the full suite runs with no unhandled rejections. Cleanup-after-partial-startup is covered by `LifecycleManager.stop()` aggregating close errors in reverse start order (§4.2).

### 21.2 P1 — Reliability and operational correctness

- Replace Redis `KEYS` queries with a bounded/indexed discovery strategy.
- Correct ESM dependency checks.
- Implement or remove unsupported configuration settings (`idleTimeout`, `windowSize`, rotation grace/version limits, unsupported algorithms).
- ~~Implement dependency-aware transport startup only if transport dependencies are a supported public concept; otherwise remove the placeholder and document registration order.~~ **Resolved:** the placeholder dependency sort was removed; startup order is registration order and shutdown order is its reverse.
- Define routing by target service, endpoint/protocol, required operation, and policy—not merely first matching capability. **Partially resolved:** `TransportManager.send` routes by registered protocol name and verifies the `PointToPointTransport` interface; `broadcast` routes through every transport implementing `MessagePublisher`. Routing by target service endpoint/protocol and policy-based transport selection in `MicroserviceClient` remains first-capability-match.
- ~~Define deadlines, cancellation, error propagation, and retry safety before implementing retries.~~ **Resolved:** retries are bounded (`maxRetries`), use exponential backoff capped at `maxDelayMs` with optional jitter, apply only to `MicroserviceError` categories listed in `retryableCategories`, and are restricted to request/response calls; non-idempotent messaging publishes are never retried. **Retry safety requirement:** the application must configure `retryPolicy` only for idempotent operations — a retried `call` may execute more than once at the remote service, so callers that need exactly-once semantics must implement idempotency keys at the operation level.
- ~~Make Kafka driver selection consistent between `KafkaTransport` and the app-level messaging facade.~~ **Resolved:** both honor the `driver` config field through the shared `resolveKafkaDriver`; explicit selections never silently fall back.
- Define whether `registerMethod` is a local handler registry or a server-registration API. Do not use one method name for behavior that differs between adapters without explicit documentation.
- Define message-envelope/encryption integration and versioning before presenting `EncryptedEnvelope` as the standard encrypted wire contract. **Partially resolved:** `EncryptionService.encryptEnvelope`/`decryptEnvelope` produce and consume the contract with metadata authenticated as AAD. Remaining: `keyId` is not yet bound to `KeyProvider`/`KeyRotationManager` key versions, and the optional `signature` field is reserved but unpopulated.

### 21.3 P2 — Observability and maintainability

- Define common metric names/labels and wire instrumentation into lifecycle, registry, and adapters where supported.
- ~~Remove unused runtime dependencies (`uuid`, `ws`) unless a documented feature requires them.~~ **Resolved:** both were removed from `dependencies`; all identifiers use `crypto.randomUUID()` or Zod `.uuid()`.
- Propagate W3C trace context across supported RPC and messaging adapters. **Not yet implemented:** `injectTraceContext`/`extractTraceContext` helpers exist in `observability/tracing.ts` and `MessageEnvelope` carries a `traceContext` field, but adapters do not yet propagate context automatically.
- Clearly distinguish in-memory audit/metrics/tracing implementations from production persistence/exporters.
- Keep the package's public export map deliberate and test every documented entry point.
- Avoid creating a second crypto abstraction layer unless it has a concrete consumer and a migration plan.

### 21.4 Dependency and lifecycle rules

- Core owns interfaces and policies; adapter implementations depend inward on those contracts.
- The composition root owns construction and lifecycle coordination, not protocol-specific behavior.
- Adapter modules must not import one another's private implementation details.
- Optional infrastructure clients are loaded only when the selected adapter is constructed or started.
- A startup failure must close already-started resources in reverse start order, continue cleanup after an individual close failure, and preserve both the original startup error and cleanup errors.
- `stop()` must be idempotent and safe when startup only partially completed.
- Timers, listeners, sockets, and client connections must have explicit owners and deterministic cleanup.

### 21.5 Required integration and release evidence

Before a production-ready release is declared, record all of the following:

- Clean unit-test run with no unhandled rejections.
- Typecheck, lint, build, and coverage reports.
- Real Redis integration tests for lease TTL, renewal races, query behavior, health updates, and driver compatibility.
- Real Kafka and NATS tests for serialization, acknowledgments, reconnect behavior, and shutdown.
- RPC interoperability tests for each supported server/client mode, including TLS where supported.
- Security tests for credential validation, unauthorized operations, key substitution, replay, malformed messages, and encryption authentication failures.
- Package-consumer tests against the actual `npm pack` tarball, including ESM imports, TypeScript declarations, optional dependencies, and all documented exports.
- Updated `docs/security/SECURITY-VERIFICATION-REPORT.md` and `docs/testing/TEST-MATRIX.md`.
- A release checklist confirming that README, examples, architecture, runtime behavior, and types agree.

### 21.6 Definition of done

A requirement is complete only when all relevant conditions hold:

1. The implementation satisfies the documented contract.
2. A regression test proves the intended behavior and failure cases.
3. Integration tests cover external behavior where mocks are insufficient.
4. Types and runtime validation reject unsupported states.
5. Documentation and examples match the actual implementation.
6. The package consumer test passes against the packed artifact.
7. Any accepted residual security risk is explicitly recorded with scope, impact, mitigation, and owner.

Until these conditions are met for the P0/P1 requirements, describe the package as **implemented with known limitations and pending production verification**, not as unconditionally production-ready.