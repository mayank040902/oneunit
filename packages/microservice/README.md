# @oneunit/microservice

**Secure, extensible communication layer for distributed services in the OneUnit ecosystem.**

Provides a consistent application API and shared infrastructure for configuration, identity, authentication, authorization, lifecycle management, observability, and protocol integration.

## Features

- **Application Lifecycle**: `createMicroservice()` — bootstraps config, logger, registry, identity, auth, and transports with deterministic startup/shutdown
- **Multi-Protocol Adapters**:
  - **RPC**: tRPC, gRPC, Connect RPC (preserve native contracts and type inference)
  - **Network**: TCP (length-prefixed framing with 4-byte big-endian header, TLS support), UDP (datagrams with size limits)
  - **Messaging**: Kafka (dual driver: `@oneunit/kafka` or KafkaJS with explicit selection), NATS Core & JetStream
- **Service Registry**: In-memory and Redis-backed (driver selection: `@oneunit/redis`, ioredis, node-redis) with leases, health metadata, and automatic expiry
- **Security**: Transport security (TLS/mTLS), service authn/authz (allowlist, RBAC, composite), optional payload encryption (AES-256-GCM, ChaCha20-Poly1305, X25519, Ed25519), replay protection
- **Observability**: Structured logging (Logger contract with child loggers), metrics, distributed tracing (W3C Trace Context), auditing, health checks
- **Dependency Inversion**: Core defines contracts; applications inject logger; adapters own concrete clients; optional integrations never block core imports

## Installation

```bash
# Core package (no optional adapters)
pnpm add @oneunit/microservice

# With optional integrations
pnpm add @oneunit/microservice @oneunit/kafka @oneunit/redis @oneunit/logger ioredis kafkajs nats pino pino-pretty
```

## Quick Start

```typescript
import { createMicroservice } from '@oneunit/microservice';

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
      nats: {
        enabled: true,
        servers: ['nats://localhost:4222'],
        subjects: { prefix: 'myapp' },
        jetstream: { enabled: true },
      },
    },
    registry: {
      backend: 'redis',
      redis: { host: 'localhost', port: 6379 },
    },
  },
});

// Kafka messaging via the application
await app.kafka?.publish('users.created', { userId: '123' });
await app.kafka?.subscribe('users.created', async (msg, ctx) => {
  console.log('Received:', msg, 'on', ctx.topic);
});

await app.start();
// ... application runs ...
await app.stop();  // Cleanly shuts down all transports
```

## Public Exports

### Main Entry Point (`@oneunit/microservice`)

| Export | Description |
|--------|-------------|
| `createMicroservice(options)` | Create and configure the application |
| `MicroserviceApp` | Application interface with `start()`, `stop()`, `kafka`, `logger`, etc. |
| `MicroserviceConfig`, `ServiceConfig` | Configuration types (Zod-validated) |
| `loadConfig(path?)`, `createDefaultConfig()` | Load configuration from file/env with precedence |
| `ServiceIdentity`, `createServiceIdentity()`, `createIdentityFromCredentials()` | Service identity management with x509/JWT/API-key/mTLS credentials |
| `AuthorizationPolicy`, `createAuthorizationPolicy()` | Authorization policies (allowlist, RBAC, composite) |
| `Logger`, `createLogger()`, `NoopLogger`, `noopLogger`, `FrameworkLogger` | Logger contract and built-in implementations |
| `Transport`, `TransportCapabilities`, `TransportHealth` | Transport abstractions and capability descriptors |
| `LifecycleManager`, `LifecycleState` | Application lifecycle management (initialized → starting → running ⇄ degraded → stopping → stopped) |
| `ServiceRegistry`, `createRegistry()`, `InMemoryRegistryStore` | Service registry and discovery with leases |
| `EncryptionService`, `deriveKey()`, `EncryptionResult` | Application-level encryption (AES-256-GCM, ChaCha20-Poly1305) |
| `MicroserviceError`, `ErrorCategory`, `createMicroserviceError()` | Common error model with categories and retryability |
| `MessageEnvelope`, `MessagePublisher`, `MessageSubscriber` | Messaging capability interfaces |
| `KafkaAdapterConfig`, `NatsAdapterConfig`, `TcpAdapterConfig`, `UdpAdapterConfig` | Adapter configuration schemas |

### Subpath Exports (Optional Adapters)

| Subpath | Purpose |
|---------|---------|
| `@oneunit/microservice/adapters/logging/pino` | Pino logger adapter with secret redaction (paths: `*.password`, `*.secret`, `*.token`, `*.apiKey`, `*.privateKey`, `*.credentials`, `*.authorization`, `req.headers.authorization`, `req.headers.cookie`) |
| `@oneunit/microservice/adapters/logging/oneunit` | `@oneunit/logger` adapter with auto-detection (modes: development, production, test) |
| `@oneunit/microservice/adapters/messaging/kafka` | Kafka transport with driver selection (`KafkaTransport`, `createKafkaClient`, `isKafkaAvailable`) |
| `@oneunit/microservice/adapters/messaging/nats` | NATS transport (Core & JetStream) with subject prefixing |
| `@oneunit/microservice/registry/redis` | Redis registry store with driver selection (`createRedisStore`, `isRedisAvailable`) |
| `@oneunit/microservice/adapters/network/tcp` | TCP transport with length-prefixed framing, TLS support, backpressure |
| `@oneunit/microservice/adapters/network/udp` | UDP transport for datagrams with size limits |
| `@oneunit/microservice/adapters/rpc/trpc` | tRPC transport with router/client integration |
| `@oneunit/microservice/adapters/rpc/grpc` | gRPC transport with Protobuf service definitions |
| `@oneunit/microservice/adapters/rpc/connect` | Connect RPC transport with HTTP transport integration |

## Kafka Integration (Dual Driver)

The package provides a **logger-aware Kafka utility** with explicit driver selection:

```typescript
import { createKafkaClient, isKafkaAvailable, KafkaTransport } from '@oneunit/microservice/adapters/messaging/kafka';

// Standalone usage
if (isKafkaAvailable()) {
  const kafka = await createKafkaClient({
    config: { brokers: ['localhost:9092'], clientId: 'app', topics: { prefix: 'app' } },
    logger: app.logger,  // reuses server logger
  });
  await kafka.publish('topic', { data: 'hello' });
} else {
  // Clear actionable error if not installed
}

// Or use the transport directly for lifecycle management
const transport = new KafkaTransport(kafkaConfig, logger);
await transport.start();
await transport.publish('topic', { data: 'hello' });
await transport.subscribe('topic', async (msg, ctx) => { ... });
await transport.close();
```

**Driver Selection:**

| Config value | Behavior |
|--------------|----------|
| `driver: "oneunit"` | Selects `@oneunit/kafka`; fails clearly if unavailable |
| `driver: "kafkajs"` | Selects KafkaJS whether or not `@oneunit/kafka` is installed |
| `driver: "auto"` | Tries `@oneunit/kafka` first, then KafkaJS (documents precedence) |

**Rules:**
- Explicit selection is always honored — never silently switch drivers
- If the selected driver fails, surface that failure with actionable diagnostics
- Both drivers are optional peer dependencies
- Topic prefixing applied automatically (`{prefix}.{topic}`)

## Redis Registry (Multi-Driver)

```typescript
import { createRedisStore, isRedisAvailable } from '@oneunit/microservice/registry/redis';

if (isRedisAvailable()) {
  const redis = await createRedisStore({
    config: { host: 'localhost', port: 6379, keyPrefix: 'myapp:' },
  });
  await redis.set('key', 'value', { mode: 'EX', ttlMs: 60000 });
}
```

**Driver Selection:**

| Config value | Behavior |
|--------------|----------|
| `driver: "oneunit"` | Uses `@oneunit/redis` |
| `driver: "ioredis"` | Uses ioredis (supports Sentinel/Cluster) |
| `driver: "node-redis"` | Uses node-redis (redis v4+) |
| `driver: "auto"` | Tries `@oneunit/redis` → ioredis → node-redis |

## Logger Integration

```typescript
import { createMicroservice, createLogger, NoopLogger, FrameworkLogger } from '@oneunit/microservice';

// Auto-detects @oneunit/logger if available, falls back to FrameworkLogger
const app = await createMicroservice({ config: { ... } });

// Or inject your own logger (any implementation matching Logger interface)
import pino from 'pino';
const app = await createMicroservice({ 
  config: { ... },
  logger: pino({ level: 'info' })
});
```

**Logger Contract** (`Logger` interface):
- `trace|debug|info|warn|error|fatal(message, context?)` — overloaded for context-first or message-first
- `child(bindings)` — create child logger with additional context
- `level` — current log level (`trace` | `debug` | `info` | `warn` | `error` | `fatal`)

**Built-in implementations:**
- `FrameworkLogger` — no-op sink, for testing or when no logger is configured
- `NoopLogger` — completely silent logger
- `PinoLogger` adapter — wraps Pino with secret redaction (configurable paths)
- `OneUnitLogger` adapter — wraps `@oneunit/logger` with mode support

## Configuration

All configuration is Zod-validated. Key sections:

```typescript
{
  service: { 
    id: 'uuid', 
    name: 'string', 
    instanceId?: 'uuid',
    credentials?: { type: 'x509'|'jwt'|'api-key'|'mtls', ... },
    endpoints?: [],
    capabilities?: [],
    metadata?: {},
  },
  adapters: {
    kafka: { 
      enabled: true, 
      driver: 'oneunit'|'kafkajs'|'auto', 
      brokers: [], 
      clientId: '', 
      topics: { prefix: '' }, 
      security?: { ssl: true, sasl: {...} } 
    },
    nats: { 
      enabled: true, 
      servers: [], 
      clientName?: '', 
      subjects: { prefix: '' }, 
      jetstream?: { enabled: true, streamName?: '' }, 
      auth?: { user, pass, token, nkey, creds }, 
      tls?: false 
    },
    tcp: { 
      enabled: true, 
      host: '0.0.0.0', 
      port: 8080, 
      tls?: false, 
      cert?: '', 
      key?: '', 
      ca?: '',
      maxFrameSize: 16MB,
      connectionTimeout: 5000,
      idleTimeout: 60000
    },
    udp: { 
      enabled: true, 
      host: '0.0.0.0', 
      port: 8081, 
      maxPacketSize: 65507,
      ttl: 1,
      multicast?: { address, interface }
    },
    trpc: { enabled: true, endpoint: '', router?: {}, cors: false },
    grpc: { enabled: true, endpoint: '', protoPath: '', packageName: '', credentials?: any, tls: false },
    connect: { enabled: true, endpoint: '', transport?: any, services?: {}, interceptors?: [] },
  },
  registry: { 
    backend: 'memory'|'redis', 
    redis?: {...}, 
    ttlMs: 30000, 
    heartbeatIntervalMs: 10000,
    healthCheckIntervalMs: 30000,
    maxServices: 1000
  },
  auth: { 
    type: 'allowlist'|'rbac'|'composite', 
    entries: [], 
    defaultPolicy: 'deny', 
    roles?: {},
    serviceRoles?: {}
  },
  observability: { 
    logging: true, 
    metrics: true, 
    tracing: true, 
    audit: true, 
    logLevel: 'info', 
    prettyLogs: false 
  },
  security: { 
    authenticationEnabled: true, 
    encryptionMode: 'disabled'|'selective'|'required',
    keyRotationIntervalMs: 86400000,
    sessionTimeoutMs: 3600000
  },
  crypto: { 
    rootKey: 'base64-32+bytes', 
    keyRotationInterval: 86400000,
    sessionTimeout: 3600000,
    algorithm: 'aes-256-gcm'|'chacha20-poly1305',
    keyDerivation: 'hkdf-sha256'|'pbkdf2'
  },
}
```

See `config.example.json` for full schema.

### Configuration Loading

Configuration is loaded with the following precedence:
1. Explicit programmatic options passed to `createMicroservice({ config: {...} })`
2. Configuration file (via `configPath` or `CONFIG_PATH` env var)
3. Environment variables (e.g., `SERVICE_NAME`, `KAFKA_BROKERS`, `REDIS_HOST`)
4. Documented defaults (built-in defaults in Zod schemas)

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed design documentation covering:
- Core abstractions and lifecycle (implemented: `LifecycleManager` with state machine)
- Adapter architecture and ownership boundaries (implemented: transport abstractions, capability interfaces)
- Security model and threat model (implemented: authn/authz, encryption, replay protection)
- Message envelopes and schema evolution (implemented: `MessageEnvelope`, Zod schemas)
- Service registry and discovery (implemented: `ServiceRegistry`, leases, in-memory/Redis backends)
- Error handling and reliability (implemented: `MicroserviceError`, categories, retryability)
- Observability conventions (implemented: Logger contract, metrics, tracing, audit)
- Dependency and package boundaries (implemented: optional peer deps, subpath exports)

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Run tests
pnpm run test

# Type check
pnpm run typecheck

# Lint
pnpm run lint
```

## License

MIT