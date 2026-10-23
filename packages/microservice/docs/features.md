# @oneunit/microservice Features & Usage Guide

`@oneunit/microservice` is a secure, protocol-agnostic communication and infrastructure framework for distributed Node.js applications. This guide details every core feature provided by the package with concrete TypeScript examples.

---

## Table of Contents

1. [Application Bootstrap & Lifecycle](#1-application-bootstrap--lifecycle)
2. [Configuration System](#2-configuration-system)
3. [Identity & Authentication](#3-identity--authentication)
4. [Authorization Policies](#4-authorization-policies)
5. [Secured RPC Server & Dispatcher](#5-secured-rpc-server--dispatcher)
6. [Resilient Client & Routing](#6-resilient-client--routing)
7. [Envelope Encryption & Cryptography](#7-envelope-encryption--cryptography)
8. [Key Exchange & Key Rotation](#8-key-exchange--key-rotation)
9. [Replay Attack Protection](#9-replay-attack-protection)
10. [Service Registry & Dynamic Discovery](#10-service-registry--dynamic-discovery)
11. [Transports & Protocol Adapters](#11-transports--protocol-adapters)
    - [tRPC Adapter](#trpc-adapter)
    - [gRPC Adapter](#grpc-adapter)
    - [Connect RPC Adapter](#connect-rpc-adapter)
    - [Kafka Messaging](#kafka-messaging)
    - [NATS Messaging & JetStream](#nats-messaging--jetstream)
    - [RabbitMQ Messaging](#rabbitmq-messaging)
    - [TCP Transport (Framed & TLS)](#tcp-transport)
    - [UDP Transport (Datagram & Multicast)](#udp-transport)
12. [Observability (Logging, Metrics, Tracing, Audit)](#12-observability)
13. [Typed Contracts & Versioning](#13-typed-contracts--versioning)

---

## 1. Application Bootstrap & Lifecycle

### What It Does
The composition root boots all configured subsystems (identity, authorization, registry, transports, and loggers) and manages node lifecycle through a formal state machine:
`CREATED` &rarr; `INITIALIZING` &rarr; `STARTING` &rarr; `RUNNING` &rarr; `STOPPING` &rarr; `STOPPED` (or `FAILED`).

### How to Use
```typescript
import { createMicroservice } from '@oneunit/microservice';

const app = await createMicroservice({
  config: {
    service: {
      name: 'order-service',
      endpoints: [{ protocol: 'tcp', host: '0.0.0.0', port: 8080, tls: false }],
    },
    registry: { backend: 'memory' },
    security: { authenticationEnabled: true },
    crypto: {
      rootKey: '01234567890123456789012345678901', // Min 32 chars
    },
  },
});

// Start all transports, begin registry heartbeat leases
await app.start();
console.log('App running:', app.isReady());

// Gracefully stop all transports, deregister leases, flush logs
await app.stop();
```

---

## 2. Configuration System

### What It Does
100% runtime-validated configuration via Zod (`MicroserviceConfigSchema`). Supports four-tier precedence:
1. Programmatic overrides in `createMicroservice({ config })` (re-validated on merge).
2. Configuration file (`config.json` or path in `CONFIG_PATH`).
3. Environment variables (`SERVICE_*`, `REGISTRY_*`, `CRYPTO_*`, `AUTH_*`, etc.).
4. Schema defaults.

### Helper Utilities
```typescript
import { loadConfig, ensureConfigFile } from '@oneunit/microservice';

// Auto-generates config.json from defaults if it doesn't already exist
const configPath = ensureConfigFile('./config.json', {
  service: { name: 'user-service' },
  crypto: { rootKey: process.env.CRYPTO_ROOT_KEY! },
});

// Load and validate config explicitly
const config = loadConfig(configPath);
```

---

## 3. Identity & Authentication

### What It Does
Validates peer identities across transport boundaries using one of three schemes:
- **X.509 Certificates / mTLS**: Validates certificate validity window, issuer, SANs, and signatures.
- **Hardened JWT (`JwtAuthenticator`)**: Enforces HS256, minimum 32-byte secret, clock tolerance, maximum token age, and required claims (`sub`, `exp`, `iat`, `nbf`). Supports key rotation via `kid`.
- **Hardened API Keys (`ApiKeyAuthenticator`)**: Stores HMAC-SHA256 verifiers instead of raw keys, uses constant-time comparison (`crypto.timingSafeEqual`), and enforces retry lockouts against brute-force attacks.

### How to Use API Key Authenticator
```typescript
import { ApiKeyAuthenticator, createServiceIdentity } from '@oneunit/microservice';

const authenticator = new ApiKeyAuthenticator({
  secret: 'a-secure-internal-hmac-secret-min-32-bytes!!',
  maxFailures: 5,
  lockoutDurationMs: 15_000,
});

// Register an authorized key for a service
authenticator.registerKey(
  'svc-secret-api-key-12345',
  createServiceIdentity({ id: 'billing-service', name: 'billing-service' })
);

// Authenticate inbound credentials
const identity = await authenticator.authenticate({
  type: 'api-key',
  credentials: { apiKey: 'svc-secret-api-key-12345' },
});
console.log('Authenticated service:', identity.serviceId);
```

---

## 4. Authorization Policies

### What It Does
Applies strict default-deny authorization checks (`defaultPolicy: 'deny'`) across operations, resources, and targets.

### Available Policy Types
- **Allowlist (`AllowlistPolicy`)**: Matches exact tuples of `(serviceId, allowedOperations, allowedTargets, allowedResources)`.
- **RBAC (`RbacPolicy`)**: Assigns services to roles and roles to fine-grained permissions.
- **Composite (`CompositePolicy`)**: Chains multiple policies with `AND` (all must pass) or `OR` (any can pass) logic.

### How to Use Allowlist & RBAC
```typescript
import { createAuthorizationPolicy } from '@oneunit/microservice';

// Allowlist policy
const allowlist = createAuthorizationPolicy({
  type: 'allowlist',
  defaultPolicy: 'deny',
  entries: [
    {
      serviceId: 'payment-gateway',
      allowedOperations: ['orders.charge', 'orders.refund'],
      allowedTargets: ['order-service'],
    },
  ],
});

const canCharge = await allowlist.authorize({
  serviceId: 'payment-gateway',
  operation: 'orders.charge',
  target: 'order-service',
});
console.log('Authorized:', canCharge); // true
```

---

## 5. Secured RPC Server & Dispatcher

### What It Does
`MicroserviceServer` acts as an RPC method registry. Inbound calls pass through the `SecuredDispatcher`, which handles:
1. Authentication verification
2. Policy authorization (default-deny)
3. Audit logging of success and denial events
4. Trace propagation and execution duration metrics

### How to Use
```typescript
import { createServer } from '@oneunit/microservice';

const server = createServer({
  service: app.identity,
  authorization: app.authorization,
  authenticationEnabled: true,
  audit: app.audit,
});

// Register a method handler
server.registerMethod('orders', 'createOrder', async (ctx, payload: { sku: string; qty: number }) => {
  return { orderId: 'ord-9988', status: 'confirmed' };
});

// Execute via secured boundary
const response = await server.handle(
  'orders',
  'createOrder',
  { sku: 'WIDGET-1', qty: 2 },
  {
    serviceId: app.identity.serviceId,
    correlationId: crypto.randomUUID(),
    headers: {},
    metadata: new Map(),
  }
);
```

---

## 6. Resilient Client & Routing

### What It Does
`MicroserviceClient` invokes remote or local procedures through registered transports using capability-based selection, configurable timeouts, and exponential backoff retry policies with jitter.

### How to Use
```typescript
import { createClient } from '@oneunit/microservice';

const client = createClient({
  service: app.identity,
  authorization: app.authorization,
  defaultTimeout: 5000,
  retryPolicy: {
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    jitter: true,
    retryableCategories: ['TIMEOUT', 'UNAVAILABLE', 'NETWORK_ERROR'],
    idempotent: true,
  },
});

// Call a remote procedure with automatic retry on transient failure
const result = await client.call('inventory-service', 'checkStock', { sku: 'WIDGET-1' });
```

---

## 7. Envelope Encryption & Cryptography

### What It Does
Protects sensitive messages with envelope encryption using Node.js Web Crypto and `node:crypto`:
- Supported algorithms: `aes-256-gcm` (default) and `chacha20-poly1305`.
- Additional Authenticated Data (AAD): Message headers and metadata are bound into the cryptographic authentication tag, preventing header tampering.
- Key Derivation: Derives sub-keys using `hkdf-sha256` or `pbkdf2`.

### How to Use
```typescript
import { EncryptionService } from '@oneunit/microservice';

const encryption = new EncryptionService({
  rootKey: 'super-secret-master-key-must-be-at-least-32-chars',
  algorithm: 'aes-256-gcm',
  keyDerivation: 'hkdf-sha256',
});

// Encrypt payload with metadata binding
const encryptedEnvelope = await encryption.encryptEnvelope({
  id: crypto.randomUUID(),
  source: 'order-service',
  target: 'payment-service',
  type: 'payment.process',
  payload: { creditCard: '4111-XXXX-XXXX-1111', amount: 150.0 },
  timestamp: Date.now(),
});

// Decrypt and verify tamper resistance
const decrypted = await encryption.decryptEnvelope(encryptedEnvelope);
console.log('Decrypted payload:', decrypted.payload);
```

---

## 8. Key Exchange & Key Rotation

### What It Does
- **Authenticated Key Exchange (`AuthenticatedKeyExchange`)**: Generates ephemeral X25519 keypairs, performs ECDH exchange, verifies peer identity via Ed25519 digital signatures, and derives an authenticated session key via HKDF.
- **Key Rotation Manager (`KeyRotationManager`)**: Automates periodic master key versioning with configurable grace periods and retention policies.

### How to Use Key Exchange
```typescript
import { AuthenticatedKeyExchange, Ed25519SigningService } from '@oneunit/microservice';

const aliceSigner = new Ed25519SigningService();
const aliceKeypair = await aliceSigner.generateKeyPair();

const aliceExchange = new AuthenticatedKeyExchange({
  localServiceId: 'service-a',
  signingService: aliceSigner,
  privateKey: aliceKeypair.privateKey,
});

// Generate local ephemeral public key + signature
const aliceInit = await aliceExchange.initiate();

// After exchanging public keys and signatures with Bob:
// const sessionKey = await aliceExchange.complete(bobInit, bobPublicKey);
```

---

## 9. Replay Attack Protection

### What It Does
Maintains sliding-window caches of observed message IDs per source with:
- Configurable Time-To-Live (TTL)
- Maximum future clock-skew tolerance (default 10s)
- Bounded capacity per source with automatic FIFO eviction

### How to Use
```typescript
import { ReplayProtection } from '@oneunit/microservice';

const replayGuard = new ReplayProtection({
  ttlMs: 300_000,          // 5 minutes
  maxClockSkewMs: 10_000,   // 10 seconds
  maxEntriesPerSource: 50_000,
});
await replayGuard.start();

const isValid = await replayGuard.checkAndStore('payment-service', 'msg-uuid-101', Date.now());
console.log('Accepted:', isValid); // true

// Duplicate message ID within window will be rejected
const isReplay = !(await replayGuard.checkAndStore('payment-service', 'msg-uuid-101', Date.now()));
console.log('Replay detected:', isReplay); // true
```

---

## 10. Service Registry & Dynamic Discovery

### What It Does
Enables distributed instances to register endpoints, publish health statuses, renew TTL leases via background heartbeats, and discover live instances.

### Backends
- **Memory**: In-process store for testing and single-node setups.
- **Redis Multi-Driver**: Production backend supporting `@oneunit/redis`, `ioredis` (with Sentinel/Cluster support), and `node-redis`.

### How to Use
```typescript
import { createRegistry } from '@oneunit/microservice';

const registry = createRegistry({
  backend: 'redis',
  redis: {
    driver: 'auto',
    host: '127.0.0.1',
    port: 6379,
    keyPrefix: 'oneunit:registry:',
  },
  ttlMs: 30_000,
  heartbeatIntervalMs: 10_000,
});

await registry.start();

// Register this service instance
await registry.register({
  serviceId: 'user-service',
  instanceId: 'inst-east-1',
  name: 'user-service',
  version: '1.0.0',
  endpoints: [{ protocol: 'grpc', host: '10.0.0.5', port: 50051 }],
  capabilities: ['rpc', 'user-lookup'],
  status: 'healthy',
  metadata: { zone: 'us-east-1a' },
});

// Discover available instances of another service
const instances = await registry.discover({ serviceId: 'order-service' });
```

---

## 11. Transports & Protocol Adapters

All transports extend `BaseTransport` and integrate into the `SecuredDispatcher` pipeline.

### tRPC Adapter
Hosted tRPC routers protected by the secured boundary.
```typescript
import { TrpcTransport } from '@oneunit/microservice';

const trpc = new TrpcTransport({
  endpoint: 'http://0.0.0.0:3000/trpc',
  cors: true,
});
app.registerTransport(trpc);
```

### gRPC Adapter
High-performance binary RPC using Protocol Buffers and `@grpc/grpc-js`.
```typescript
import { GrpcTransport } from '@oneunit/microservice';

const grpc = new GrpcTransport({
  endpoint: '0.0.0.0:50051',
  protoPath: './protos/orders.proto',
  packageName: 'orders.v1',
  tls: true,
});
```

### Connect RPC Adapter
Modern HTTP/1.1, HTTP/2, and gRPC-compatible RPC with `@connectrpc/connect`.
```typescript
import { ConnectTransport } from '@oneunit/microservice';

const connect = new ConnectTransport({
  endpoint: 'http://0.0.0.0:8080',
});
```

### Kafka Messaging
Pub/sub messaging via `@oneunit/kafka` or `kafkajs`.
```typescript
// Subscribing to events
await app.kafka?.subscribe('orders.created', async (message, ctx) => {
  console.log('Received event:', message);
});

// Publishing an event
await app.kafka?.publish('orders.created', { orderId: '123' }, { key: '123' });
```

### NATS Messaging & JetStream
Lightweight pub/sub and persistent message streams.
```typescript
import { NatsTransport } from '@oneunit/microservice';

const nats = new NatsTransport({
  servers: ['nats://localhost:4222'],
  subjects: { prefix: 'events' },
  jetstream: { enabled: true, streamName: 'EVENTS_STREAM' },
});
```

### RabbitMQ Messaging
AMQP-based queue messaging with consumer tags and acknowledge coordination.
```typescript
import { RabbitMQTransport } from '@oneunit/microservice';

const rabbit = new RabbitMQTransport({
  url: 'amqp://localhost:5672',
  exchange: 'microservices',
});
```

### TCP Transport
Length-prefixed binary/JSON framing with `maxFrameSize` protection and TLS/mTLS.
```typescript
import { TcpTransport } from '@oneunit/microservice';

const tcp = new TcpTransport({
  host: '0.0.0.0',
  port: 9091,
  tls: true,
  cert: process.env.TLS_CERT,
  key: process.env.TLS_KEY,
  maxFrameSize: 16 * 1024 * 1024, // 16 MB limit
});
```

### UDP Transport
Datagram and multicast messaging with packet size limits and TTL controls.
```typescript
import { UdpTransport } from '@oneunit/microservice';

const udp = new UdpTransport({
  host: '0.0.0.0',
  port: 9092,
  maxPacketSize: 65507,
  multicast: { address: '239.255.0.1' },
});
```

---

## 12. Observability

### Structured Logging with Secret Redaction
The default `FrameworkLogger` scrubs tokens, passwords, private keys, and authorization headers before printing JSON:
```typescript
app.logger.info('User authenticated', {
  userId: 'usr-1',
  password: 'plaintext-password', // Automatically redacted to '[REDACTED]'
  apiKey: 'secret-token-key',     // Automatically redacted to '[REDACTED]'
});
```

### Audit Logging
Records security-sensitive operations with timestamps, client identities, and outcomes:
```typescript
app.audit.log({
  type: 'AUTH_SUCCESS',
  serviceId: 'payment-service',
  target: 'order-service',
  action: 'orders.charge',
  outcome: 'ALLOWED',
  timestamp: Date.now(),
});
```

### Tracing & Metrics
Tracks distributed operation spans, execution latencies, and invocation counts across all adapters.

---

## 13. Typed Contracts & Versioning

### What It Does
Ensures safe schema evolution between services using Zod contracts and semantic version checking.

### How to Use Procedure Contracts
```typescript
import { createProcedureContract } from '@oneunit/microservice';
import { z } from 'zod';

export const CreateUserContract = createProcedureContract({
  name: 'users.create',
  version: '1.2.0',
  input: z.object({
    email: z.string().email(),
    name: z.string().min(2),
  }),
  output: z.object({
    id: z.string().uuid(),
    createdAt: z.number(),
  }),
  deprecated: false,
});
```
