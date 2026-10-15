# @oneunit/microservice

**Secure, extensible communication layer for distributed services in the OneUnit ecosystem.**

Provides a consistent application API and shared infrastructure for configuration, identity, authentication, authorization, lifecycle management, observability, and protocol integration. ESM-only, TypeScript strict mode, Node.js ≥ 20.

## Technology Stack

| Layer | Technologies |
|-------|--------------|
| **Runtime** | Node.js ≥ 20 (ESM only, `"type": "module"`); workspace `.nvmrc` pins 24.19.0 |
| **Language** | TypeScript 5.3+ (strict, `isolatedModules`, `noUncheckedIndexedAccess`, `noImplicitOverride`) |
| **Package Manager** | pnpm 11.9.0 |
| **Build** | `tsc && tsc-alias` — `tsc-alias` rewrites `@/*`, `@crypto/*`, `@transport/*`, `@registry/*`, `@config/*`, `@adapters/*` path aliases to relative ESM imports in `dist/` |
| **Testing** | Vitest 3.2 (v8 coverage, `forks` pool, single fork) — 73 test files |
| **Validation** | Zod 3.22 — every configuration section is Zod-validated at load time |
| **Cryptography** | Node.js Web Crypto API (`crypto.subtle`) + `node:crypto` (`X509Certificate`) — no third-party crypto libraries |
| **Logging Contract** | Framework-owned `Logger` interface (6 levels, dual overloads, `child(bindings)`); concrete loggers are application-injected or loaded via optional adapters |

**Runtime dependencies (always installed):**
- `@trpc/client` + `@trpc/server` v11 — tRPC (dynamically imported inside adapter methods)
- `@grpc/grpc-js` v1.10 + `@grpc/proto-loader` v0.7 — gRPC (dynamically imported)
- `@connectrpc/connect` + `@connectrpc/connect-node` v1.5 — Connect RPC (dynamically imported)
- `jose` v5.2 — JWT verification (dynamically imported)
- `zod` v3.22 — runtime config validation

> **Note:** `uuid` and `ws` were removed from `dependencies`. All identifiers use `crypto.randomUUID()`; no WebSocket transport exists.

**Optional peer dependencies (all `optional: true`, lazily loaded via dynamic `import()`):**
- `@oneunit/kafka` v1 — OneUnit-native Kafka client (driver: `oneunit`)
- `kafkajs` v2.2 — standard Kafka client (driver: `kafkajs`)
- `nats` v2.28 — NATS Core & JetStream (single-driver NATS adapter)
- `@oneunit/redis` v1 — OneUnit Redis client (driver: `oneunit`)
- `ioredis` v5 — ioredis with Sentinel/Cluster support (driver: `ioredis`)
- `redis` v4 — node-redis (driver: `node-redis`)
- `@oneunit/logger` v1 — OneUnit logger (default logger adapter when installed)
- `pino` v8.19 / `pino-pretty` v10.3 — Pino logging adapter

## Features

### Application Lifecycle
- `createMicroservice()` — loads/validates config, then composes identity, registry, authorization, lifecycle, logger, and optional Kafka messaging
- `LifecycleManager` — state machine: `initialized` → `starting` → `running` → `stopping` → `stopped`, with `failed` reachable from `starting` and `degraded` as a sub-state of `running` (entered automatically when a health check reports an unhealthy transport, left automatically when every transport recovers; the `degraded` event carries the unhealthy transport names)
- Transport startup in **registration order** (transport dependencies are not a public concept; shutdown runs in reverse registration order)
- Graceful shutdown in reverse start order with error aggregation (`STOP_ERRORS`)
- Periodic health checks (default 30 s) emitting `healthCheck` and `degraded` events; per-transport plus application-level (`hooks.onHealthCheck`) checks

### Multi-Protocol Adapters

**RPC (native contracts preserved):**
- **tRPC** — `initTRPC` routers hosted via the standalone HTTP server adapter; client via `createTRPCProxyClient` + `httpBatchLink`; streaming explicitly unsupported
- **gRPC** — `@grpc/grpc-js` server/client, `@grpc/proto-loader` dynamic loading (`keepCase`, `longs: String`, `enums: String`, `defaults`, `oneofs`), TLS/mTLS server credentials, callback↔promise bridging, streaming via `AsyncIterable`, `correlation-id` metadata extraction
- **Connect RPC** — `createPromiseClient` over an application-supplied `@connectrpc/connect-node` transport; client-side only (no hosted server)

**Network (raw sockets):**
- **TCP** — length-prefixed framing (4-byte big-endian), frame-size enforcement (16 MiB default) **before** buffer slicing, partial header/payload handling, TLS/mTLS (`ca` enables `requestCert`/`rejectUnauthorized`), `connectionTimeout` (5 s default). **Not implemented:** `idleTimeout` and explicit backpressure/`drain` handling
- **UDP** — datagram transport, max packet size 65,507 enforced before send, multicast with configurable TTL (default 1) and loopback

**Messaging:**
- **Kafka** — dual driver (`oneunit` | `kafkajs` | `auto`), topic prefixing (`{prefix}.{topic}`), SASL/SSL, consumer groups (default `{clientId}-{topic}`). The `@oneunit/kafka` driver supports explicit `ack()`/`nak()` after handler completion; the KafkaJS driver serializes with `JSON.stringify` and relies on KafkaJS-native auto-ack
- **NATS** — Core pub/sub and JetStream durable consumers (durable name `{clientName}-{topic}`, explicit ack policy, `ack()`/`nak()` after handler), subject prefixing, user/pass, token, nkey, and creds auth, TLS. **Request/reply is not implemented** (the `requestResponse` capability flag is declared but no `request()` method exists)

### Service Registry
- **In-memory backend** — development/testing, per-lease `setTimeout` expiry timers
- **Redis backend** — multi-driver (`oneunit` | `ioredis` | `node-redis` | `auto`), key prefixing (default `microservice:registry:`), `SET … EX` with remaining TTL, cursor-paged `SCAN` (`MATCH`/`COUNT`) + `MULTI`/`EXEC` pipeline queries filtered client-side, ioredis Sentinel support, lazy connect via a `Proxy` (no socket until first operation)
- Lease registration, renewal, discovery with filtering (`serviceId`, `status`, `capability`, `limit`), health metadata, automatic stale-lease expiration
- **Limitations:** renewal is read-then-write (not atomic — no Lua script); `updateHealth` writes a shadow entry under `{serviceId}:{instanceId}` rather than the lease key; `serviceName` queries never match (field absent on `ServiceInstance`)
- Client-side discovery cache: 5 s TTL, 100-entry FIFO eviction

### Security
- **Transport Security** — TLS/mTLS across TCP, gRPC, NATS, Kafka
- **Service Authentication** — x509/mTLS (chain verification against trusted CAs via `X509Certificate`), JWT (`jose`, issuer/audience), API keys
- **Authorization** — three policies: `allowlist` (serviceId + operations/targets/resources, `*` wildcard), `rbac` (roles → permissions → operations), `composite` (chained allowlist + RBAC); default-deny
- **Application-level Encryption** — AES-256-GCM and ChaCha20-Poly1305 (both 12-byte random nonce, 16-byte tag, AAD support; ChaCha20-Poly1305 runs on `node:crypto` because Web Crypto cannot import raw ChaCha20-Poly1305 keys); PBKDF2-SHA-256 password-based derivation (100k iterations)
- **Key Exchange** — X25519 (unauthenticated, MITM risk documented with `AuthenticatedKeyExchange` extension point for Noise/TLS/SIGMA/PAKE), HKDF-SHA-256 session-key derivation with purpose separation (`info ‖ 0x01/0x02/0x03`), non-extractable key variants
- **Signing** — Ed25519 and RSA (RSASSA-PKCS1-v1_5, 2048-bit default)
- **Key Rotation** — per-service interval timers (24 h default), versioned rotation events; `gracePeriodMs`/`maxVersions` are delegated to the key provider via `setRetentionPolicy` (provider-enforced retention); `autoRotate` gates the timer
- **Replay Protection** — per-source sliding windows, TTL 5 min, future-skew tolerance 10 s, max 100k entries per source (oldest 50% evicted when full)

### Observability
- **Logger Contract** — `Logger` interface with 6 levels, context-first/message-first overloads, `error(err, message)`, `child(bindings)`; `FrameworkLogger` (framework-owned no-op with level gating), `NoopLogger`
- **Logger Adapters** — Pino (secret redaction on `*.password`, `*.secret`, `*.token`, `*.apiKey`, `*.privateKey`, `*.credentials`, `*.authorization`, `req.headers.authorization`, `req.headers.cookie`; optional `pino-pretty` transport) and `@oneunit/logger` (development/production/test modes; type-only import so the core never requires it)
- **Metrics** — in-memory `InMemoryMetricsCollector`: counters, gauges, histograms, summaries; 1,000-sample FIFO cap per metric name; sorted-label keys. Standalone — not wired into transports
- **Tracing** — `NoopTracer`/`InMemoryTracer` plus W3C `traceparent` extract/inject helpers. Standalone — adapters do not currently propagate trace context
- **Auditing** — `InMemoryAuditLogger`: structured security events, 10,000-event FIFO cap, filtered queries (eventType, actor, resource, time window, outcome, risk level)
- **Health Checks** — per-transport + application-level, interval configurable (30 s default)

### Dependency Inversion
- Core defines contracts (`Logger`, `Transport`, `RegistryStore`, `AuthorizationPolicy`, `MessagePublisher/Subscriber`, capability interfaces)
- Application injects a concrete logger via `createMicroservice({ logger })`; the framework never creates or configures a concrete logger
- Adapters own concrete client imports (Kafka, Redis, NATS, Pino) — loaded lazily inside functions, never at module load; static analysis of `dist/` confirms the main entry has no static import of any optional peer (only dynamic `await import()` inside driver resolvers), so the core installs and imports without them (see `test/packaging.test.ts`)

## Installation

```bash
# Core package (no optional adapters)
pnpm add @oneunit/microservice

# With optional integrations (install the drivers you select)
pnpm add @oneunit/microservice @oneunit/kafka @oneunit/redis @oneunit/logger ioredis kafkajs nats pino pino-pretty
```

## Quick Start

```typescript
import { createMicroservice } from '@oneunit/microservice';

// Configuration precedence: config file (CONFIG_PATH or ./config.json)
// → env-built config when the file is absent → Zod schema defaults
// → programmatic overrides (deep-merged via mergeConfig, then re-validated).
const app = await createMicroservice({
  config: {
    service: {
      id: crypto.randomUUID(),
      name: 'my-service',
    },
    adapters: {
      kafka: {
        enabled: true,
        driver: 'oneunit',  // or 'kafkajs', 'auto'
        brokers: ['localhost:9092'],
        clientId: 'my-service',
        topics: { prefix: 'myapp' },
      },
    },
    registry: {
      backend: 'redis',
      redis: { driver: 'ioredis', host: 'localhost', port: 6379 },
    },
  },
});

// Kafka messaging (app-level facade — @oneunit/kafka driver only;
// the `driver` field is honored by KafkaTransport, not here)
await app.kafka?.publish('users.created', { userId: '123' });
await app.kafka?.subscribe('users.created', async (msg, ctx) => {
  console.log('Received:', msg, 'on', ctx.topic);
});

await app.start();   // registers the service lease, starts transports
// ... application runs ...
await app.stop();    // disconnects Kafka, closes transports in reverse order,
                     // deregisters the lease; aggregates shutdown errors
```

Configuration merging uses `mergeConfig`: plain objects are deep-merged field by field; arrays, scalars, and security-sensitive objects (`service.credentials`) are replaced wholesale. The merged result is re-validated with the full Zod schema before any runtime resource is constructed, and the final config is returned frozen. Required sections are `service`, `security`, `registry`, `auth`, `observability`, `crypto` — supply them or let the file/env/defaults provide them.

## Public Exports

### Main Entry Point (`@oneunit/microservice`)

| Export | Description |
|--------|-------------|
| `createMicroservice(options)` | Create and configure the application |
| `MicroserviceApp`, `CreateAppOptions`, `KafkaMessaging` | Application interface (`start()`, `stop()`, `kafka`, `logger`, `registry`, `identity`, `authorization`, `lifecycle`, transport management) |
| `MicroserviceConfig`, `ServiceConfig` + all section types | Configuration types (Zod-inferred) |
| `loadConfig(path?)`, `buildConfigFromEnv()`, `createDefaultConfig()` | Configuration loading |
| `ServiceIdentity`, `createServiceIdentity()`, `createIdentityFromCredentials()` | Service identity (x509 sign/verify via Web Crypto) |
| `AuthorizationPolicy`, `createAuthorizationPolicy()`, `AllowlistPolicy`, `RbacPolicy`, `CompositePolicy` | Authorization policies |
| `Authenticator`, `createAuthenticator()`, `X509Authenticator`, `JwtAuthenticator`, `ApiKeyAuthenticator` | Authentication |
| `Logger`, `createLogger()`, `createChildLogger()`, `NoopLogger`, `noopLogger`, `FrameworkLogger` | Logger contract and built-ins |
| `Transport`, `TransportCapabilities`, `TransportHealth`, `TransportMetrics`, `PointToPointTransport` | Transport abstractions |
| `LifecycleManager`, `LifecycleState` (incl. `degraded`), `LifecycleHooks`, `createLifecycleManager()` | Application lifecycle |
| `ServiceRegistry`, `createRegistry()`, `InMemoryRegistryStore`, `ServiceLease` | Service registry and discovery with leases |
| `LeaseManager`, `createLeaseManager()`, `ServiceDiscovery`, `createDiscovery()`, `HealthChecker`, `createHealthChecker()` | Registry subsystems |
| `EncryptionService` (AEAD + `encryptEnvelope`/`decryptEnvelope`), `deriveKey()`, `SUPPORTED_ALGORITHMS` | Application-level encryption |
| `KeyExchangeService`, `AuthenticatedKeyExchange`, `Ed25519SigningService`, `RsaSigningService` | Key exchange and signing |
| `KeyProvider`, `createKeyProvider()`, `KeyRotationManager`, `createKeyRotationManager()` | Key management |
| `ReplayProtection`, `createReplayProtection()` | Replay detection |
| `MicroserviceError`, `MicroserviceErrorImpl`, `ErrorCategory`, `ErrorCodes`, `createMicroserviceError()`, `mapNativeError()`, `isMicroserviceError()`, `isRetryableError()` | Common error model |
| `MessageEnvelope`, `EncryptedEnvelope`, `createMessageEnvelope()`, `Event`, `SystemEvents`, `ProcedureContract`, `ContractVersion` | Messaging/contract types |
| `MicroserviceClient` (retry policy on `call`), `createClient()`, `MicroserviceServer`, `createServer()` | RPC client/server composition helpers |
| `BaseTransport`, `TransportManager`, `createTransportManager()` | Transport layer |
| `TcpTransport`, `UdpTransport`, `TrpcTransport`, `GrpcTransport`, `ConnectTransport` + `createXTransport()` factories | Protocol adapters (main entry) |
| `InMemoryMetricsCollector`, `createMetricsCollector()`, `Tracer`, `NoopTracer`, `InMemoryTracer`, `createTracer()`, `extractTraceContext()`, `injectTraceContext()`, `AuditLogger`, `InMemoryAuditLogger`, `createAuditLogger()` | Observability |
| `ShutdownManager`, `createShutdownManager()`, `gracefulShutdown()`, ID generators (`generateId`, `generateCorrelationId`, …) | Internal utilities |

### Subpath Exports (complete list — exactly these five)

| Subpath | Purpose |
|---------|---------|
| `@oneunit/microservice/adapters/logging/pino` | `createPinoLogger` — Pino adapter with secret redaction |
| `@oneunit/microservice/adapters/logging/oneunit` | `createOneUnitLogger` — `@oneunit/logger` adapter (development/production/test modes) |
| `@oneunit/microservice/adapters/messaging/kafka` | `KafkaTransport`, `createKafkaTransport`, `createKafkaClient`, `isKafkaAvailable`, `resetKafkaClient` |
| `@oneunit/microservice/adapters/messaging/nats` | `NatsTransport`, `createNatsTransport` |
| `@oneunit/microservice/registry/redis` | `RedisRegistryStore`, `createRedisStore`, `resolveRedisDriver`, Redis driver types |

TCP, UDP, tRPC, gRPC, and Connect adapters have **no subpath exports** — import them from the main entry.

## Kafka Integration (Dual Driver)

```typescript
import { createKafkaClient, isKafkaAvailable, KafkaTransport } from '@oneunit/microservice/adapters/messaging/kafka';

// Standalone usage
if (isKafkaAvailable()) {   // NOTE: uses require.resolve — always false in ESM contexts
  const kafka = await createKafkaClient({
    config: { brokers: ['localhost:9092'], clientId: 'app', topics: { prefix: 'app' } },
    logger: app.logger,
  });
  await kafka.publish('topic', { data: 'hello' });
}

// Or use the transport directly for lifecycle management (both drivers)
const transport = new KafkaTransport(kafkaConfig, logger);
await transport.start();          // resolves the configured driver here
await transport.publish('topic', { data: 'hello' });
await transport.subscribe('topic', async (msg, ctx) => { ... });
await transport.close();
```

**Driver Selection:**

| Config value | Behavior |
|--------------|----------|
| `driver: "oneunit"` | Selects `@oneunit/kafka`; fails clearly if unavailable |
| `driver: "kafkajs"` | Selects KafkaJS whether or not `@oneunit/kafka` is installed |
| `driver: "auto"` | Tries `@oneunit/kafka` first, then KafkaJS (documented precedence) |

**Rules:**
- Explicit selection is always honored — never silently switch drivers; all candidate failures are aggregated into one actionable error
- Both drivers are optional peer dependencies
- Topic prefixing applied automatically (`{prefix}.{topic}`)
- `@oneunit/kafka` driver: explicit `ack()`/`nak()` control after handler completion (unless `autoAck`); KafkaJS driver: JSON serialization, native auto-ack

## Redis Registry (Multi-Driver)

```typescript
import { createRedisStore, resolveRedisDriver } from '@oneunit/microservice/registry/redis';

const redis = await createRedisStore({
  driver: 'ioredis',           // 'oneunit' | 'ioredis' | 'node-redis' | 'auto'
  host: 'localhost',
  port: 6379,
  keyPrefix: 'myapp:registry:',
});
```

**Driver Selection:**

| Config value | Behavior |
|--------------|----------|
| `driver: "oneunit"` | Uses `@oneunit/redis` |
| `driver: "ioredis"` | Uses ioredis (supports Sentinel via `sentinels` + `sentinelName`) |
| `driver: "node-redis"` | Uses node-redis (`redis` v4+) |
| `driver: "auto"` | Tries `@oneunit/redis` → ioredis → node-redis |

All three drivers implement identical `RegistryStore` semantics: `SET key JSON EX <remaining-ttl>`, `GET`/`DEL`, and cursor-paged `SCAN` (`MATCH` pattern, `COUNT 100`) + `MULTI`/`EXEC` pipeline reads with client-side filtering.

## Logger Integration

```typescript
import { createMicroservice, createLogger, FrameworkLogger } from '@oneunit/microservice';
import { createPinoLogger } from '@oneunit/microservice/adapters/logging/pino';

// 1. Inject any Logger implementation (application owns configuration)
const app = await createMicroservice({ config: { ... }, logger: myLogger });

// 2. Default when observability.logging is true: @oneunit/logger adapter
//    (falls back to a no-op FrameworkLogger if not installed)
const app = await createMicroservice({ config: { ... } });

// 3. Explicit Pino (requires `pino` installed)
const pinoLogger = await createPinoLogger({ level: 'info', pretty: true });
```

**Logger Contract** (`Logger` interface):
- `trace|debug|info|warn|error|fatal(message, context?)` — overloaded for context-first or message-first calls
- `error(err: Error, message)` / `fatal(err: Error, message)` — Error-instance forms
- `child(bindings)` — child logger with additional context
- `level` — current log level (`trace` | `debug` | `info` | `warn` | `error` | `fatal`; numeric map 10–60)

**Built-in implementations:**
- `FrameworkLogger` — framework-owned no-op sink with level gating and base bindings (the default)
- `NoopLogger` — completely silent; `child()` returns itself
- `PinoLogger` adapter — wraps Pino with secret redaction and optional `pino-pretty`
- `OneUnitLogger` adapter — wraps `@oneunit/logger` with mode support

## Configuration

All configuration is Zod-validated. Key sections and defaults:

```typescript
{
  service: {
    id: 'uuid', name: 'string',
    instanceId: 'uuid (auto-generated)',
    credentials: { type: 'x509'|'jwt'|'api-key'|'mtls', issuedAt, issuer, ... },
    endpoints: [{ protocol: 'tcp'|'udp'|'trpc'|'grpc'|'connect'|'kafka'|'nats', host, port, tls }],
    capabilities: [], metadata: {},
  },
  security: { authenticationEnabled: true, encryptionMode: 'disabled'|'selective'|'required' (default 'selective'), keyRotationIntervalMs: 86400000, sessionTimeoutMs: 3600000 },
  adapters: {
    kafka: { enabled: false, driver: 'auto', brokers: ['localhost:9092'], clientId: 'microservice', topics: { prefix: 'microservice' }, security: { ssl, sasl: { mechanism, username, password } } },
    nats: { enabled: false, servers: ['nats://localhost:4222'], subjects: { prefix: 'microservice' }, jetstream: { enabled: false, streamName }, auth: { user, pass, token, nkey, creds }, tls: false },
    tcp: { enabled: false, host: '0.0.0.0', port: 8080, tls: false, cert, key, ca, maxFrameSize: 16777216, connectionTimeout: 5000, idleTimeout: 60000 (declared, not enforced) },
    udp: { enabled: false, host: '0.0.0.0', port: 8081, maxPacketSize: 65507, ttl: 1, multicast: { address, interface } },
    trpc: { enabled: false, endpoint: 'http://localhost:3000/trpc', router, cors: false },
    grpc: { enabled: false, endpoint: 'localhost:50051', protoPath, packageName, credentials, tls: false },
    connect: { enabled: false, endpoint: 'http://localhost:3000', transport, services, interceptors },
  },
  registry: { backend: 'memory'|'redis', redis: { driver: 'auto', host, port, password, db, tls, keyPrefix, sentinels, sentinelName, sentinelPassword }, ttlMs: 30000, heartbeatIntervalMs: 10000, healthCheckIntervalMs: 30000, maxServices: 1000 },
  auth: { type: 'allowlist'|'rbac'|'composite' (default 'allowlist'), entries: [{ serviceId, allowedOperations, allowedResources, allowedTargets }], defaultPolicy: 'deny', roles, serviceRoles },
  observability: { logging: true, metrics: true, tracing: true, audit: true, logLevel: 'info', prettyLogs: false },
  crypto: { rootKey: 'string ≥ 32 chars', keyRotationInterval: 86400000, sessionTimeout: 3600000, algorithm: 'aes-256-gcm'|'chacha20-poly1305' (both functional; CHACHA via node:crypto), keyDerivation: 'hkdf-sha256'|'pbkdf2' },
}
```

See `config.example.json` for a complete example.

### Configuration Loading

1. **Configuration file** — explicit `configPath`, `CONFIG_PATH` env var, or `./config.json`
2. **Environment fallback** — if no file exists, config is built from `SERVICE_*`, `SECURITY_*`, `REGISTRY_*`, `REDIS_*`, `AUTH_*`, `OBSERVABILITY_*`, `CRYPTO_*`, `KAFKA_*`, `NATS_*`, `TCP_*`, `UDP_*`, `TRPC_*`, `GRPC_*`, `CONNECT_*` variables (env vars are not merged on top of an existing file)
3. **Zod schema defaults** — applied during validation
4. **Programmatic overrides** — `createMicroservice({ config })` deep-merges overrides (plain objects merged field by field; arrays, scalars, and `service.credentials` replaced wholesale) **then re-validates the full merged result** with `MicroserviceConfigSchema` before constructing any runtime resources; the final config is returned frozen

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical design:
- Layered architecture and module ownership (§3)
- Core composition root, lifecycle state machine, capability contracts, error model (§4)
- Configuration system and loading precedence (§5)
- Contracts: message envelopes, events, procedures, registry schemas, versioning (§6)
- Identity, authentication, and authorization (§7)
- Cryptographic primitives and key management (§8)
- Registry, leases, discovery caching, health, Redis multi-driver backend (§9)
- Transport abstraction and all protocol adapters with capability matrices (§10–11)
- Observability contracts and implementations (§12)
- Data flows: bootstrap, startup/shutdown, RPC routing, messaging, registry, error normalization (§14)
- Design patterns: driver-resolver, lazy ESM imports, lazy-connect proxy, capability-based selection (§15)
- Packaging and dependency boundaries (§17)
- Directory structure map (§18)
- Implementation status and known limitations (§20)

## Directory Structure

```text
src/
├── index.ts                          # Main entry: re-exports core, contracts, security,
│                                     # registry, transport, rpc+network adapters,
│                                     # observability, internal, config, identity
├── core/                             # Composition root & lifecycle
│   ├── application.ts                # createMicroservice(), MicroserviceApp
│   ├── lifecycle.ts                  # LifecycleManager (state machine, health loop)
│   ├── capabilities.ts               # Transport, RPC, messaging, stream, datagram contracts
│   ├── errors.ts                     # MicroserviceError, 20 categories, native error mapping
│   ├── client.ts                     # MicroserviceClient (capability-based selection, RetryPolicy execution)
│   └── server.ts                     # MicroserviceServer (method registry)
├── config/                           # Configuration
│   ├── schema.ts                     # Zod schemas for all config sections + defaults
│   └── loader.ts                     # loadConfig (file → env fallback), createDefaultConfig
├── contracts/                        # Shared contracts
│   ├── messages.ts                   # MessageEnvelope, EncryptedEnvelope
│   ├── events.ts                     # Event, EventSubscription, SystemEvents
│   ├── procedures.ts                 # ProcedureContract (Zod in/out schemas)
│   ├── schemas.ts                    # ServiceRegistration/Instance/HealthCheck (Zod)
│   └── versions.ts                   # ContractVersion, compatibility, deprecation
├── identity/                         # Identity, authn, authz
│   ├── service-identity.ts           # ServiceIdentity, x509 sign/verify
│   ├── credentials.ts                # CredentialProvider/Store (memory, file)
│   ├── authentication.ts             # X509/JWT/API-key authenticators
│   └── authorization.ts              # Allowlist/RBAC/Composite policies
├── security/                         # Cryptographic primitives (Web Crypto)
│   ├── encryption.ts                 # EncryptionService (AES-256-GCM, ChaCha20-Poly1305), PBKDF2 deriveKey, EncryptedEnvelope
│   ├── key-exchange.ts               # X25519, Ed25519, HKDF session keys, AuthenticatedKeyExchange
│   ├── signing.ts                    # Ed25519SigningService, RsaSigningService
│   ├── key-provider.ts               # Memory/Composite key providers
│   ├── key-rotation.ts               # KeyRotationManager (interval timers, events)
│   ├── replay-protection.ts          # Sliding-window replay detection
│   └── crypto-types.ts               # Branded crypto types (internal)
├── registry/                         # Service registry & discovery
│   ├── registry.ts                   # ServiceRegistry, InMemoryRegistryStore, createRegistry
│   ├── leases.ts                     # DefaultLeaseManager
│   ├── discovery.ts                  # ServiceDiscovery (TTL cache, FIFO eviction)
│   ├── health.ts                     # DefaultHealthChecker
│   └── redis/                        # Redis backend (multi-driver)
│       ├── adapter.ts                # RedisRegistryStore (driver-agnostic, lazy connect)
│       ├── driver-resolver.ts        # resolveRedisDriver (oneunit/ioredis/node-redis/auto)
│       ├── redis-client.ts           # Alternative RedisClient facade (@oneunit/redis only)
│       ├── types.ts                  # Redis driver types
│       ├── oneunit/adapter.ts        # @oneunit/redis driver
│       ├── ioredis/adapter.ts        # ioredis driver (Sentinel support)
│       └── node-redis/adapter.ts     # node-redis driver
├── transport/                        # Transport abstraction
│   ├── transport.ts                  # BaseTransport abstract class
│   ├── manager.ts                    # TransportManager (registration, health, metrics)
│   └── capabilities.ts               # Re-exports core capability types
├── adapters/                         # Protocol adapters
│   ├── logging/                      # Logger adapters
│   │   ├── shared/adapter-utils.ts   # Logger adaptation helpers
│   │   ├── pino/                     # Pino adapter (secret redaction)
│   │   └── oneunit/                  # @oneunit/logger adapter (type-only import)
│   ├── messaging/                    # Messaging adapters
│   │   ├── kafka/                    # Kafka (dual driver)
│   │   │   ├── adapter.ts            # KafkaTransport (driver-agnostic)
│   │   │   ├── driver-resolver.ts    # resolveKafkaDriver (oneunit/kafkajs/auto)
│   │   │   ├── kafka-client.ts       # KafkaClient facade (@oneunit/kafka only)
│   │   │   ├── types.ts              # Kafka driver types
│   │   │   ├── oneunit/adapter.ts    # @oneunit/kafka driver (ack/nak)
│   │   │   └── kafkajs/adapter.ts    # KafkaJS driver (JSON serialization)
│   │   └── nats/                     # NATS Core & JetStream (single driver)
│   ├── network/                      # Raw network adapters
│   │   ├── tcp/                      # TCP transport
│   │   │   ├── index.ts              # TcpTransport (framing, TLS/mTLS)
│   │   │   └── frame-parser.ts       # TcpFrameParser, encodeTcpFrame
│   │   └── udp/                      # UDP transport (multicast, TTL)
│   └── rpc/                          # RPC adapters
│       ├── trpc/                     # tRPC transport
│       ├── grpc/                     # gRPC transport (proto-loader)
│       └── connect/                  # Connect RPC transport
├── observability/                    # Observability infrastructure
│   ├── logger.ts                     # Logger contract, FrameworkLogger, NoopLogger
│   ├── metrics.ts                    # InMemoryMetricsCollector
│   ├── tracing.ts                    # Noop/InMemory tracers, W3C extract/inject
│   └── audit.ts                      # InMemoryAuditLogger
├── internal/                         # Internal utilities
│   ├── ids.ts                        # Prefixed ID generators
│   └── shutdown.ts                   # ShutdownManager (priority hooks, signals)
└── crypto/                           # Interface-only crypto provider abstractions
    └── index.ts
```

## Development

```bash
pnpm install        # Install dependencies
pnpm run build      # tsc && tsc-alias → dist/
pnpm run test       # vitest run (73 test files)
pnpm run typecheck  # tsc --noEmit
pnpm run lint       # eslint src
```

## Testing

- **Unit tests** (`test/**/*.test.ts`, Vitest): pure functions, validation, config, error mapping, framing, serialization, registry logic, lifecycle
- **Security tests**: encryption (bit-flip on ciphertext/tag/nonce, AAD mismatch), key exchange (MITM demonstration, non-extractable keys), signing, replay protection (future timestamps, duplicates, concurrency), authn/authz negative cases
- **Adapter tests**: Kafka (transport + both driver adapters against fakes), NATS, TCP framing, tRPC/gRPC/Connect, logging adapters, Redis driver adapters
- **Packaging tests** (`test/packaging.test.ts`): ESM entry loads, export surface, `npm pack` artifact contains only `dist/` (no `src/`, no source maps), optional peers classified correctly
- **Not executed (external infrastructure required)**: real Kafka broker, NATS server, Redis server, RPC interop

## License

MIT
