# OneUnit Microservice Communication Platform — Architecture

| Field | Value |
|---|---|
| **Package** | `@oneunit/microservice` |
| **Status** | Proposed architecture |
| **Language** | TypeScript |
| **Runtime** | Node.js |
| **Module system** | ESM |
| **Package manager** | pnpm |
| **License** | MIT |

---

## Table of contents

### Part A — Foundations
1. [Overview](#1-overview)
2. [Scope and non-goals](#2-scope-and-non-goals)
3. [Architectural principles](#3-architectural-principles)
4. [Communication models and selection rules](#4-communication-models-and-selection-rules)
5. [High-level architecture](#5-high-level-architecture)

### Part B — Structure and core abstractions
6. [Folder structure and ownership](#6-folder-structure-and-ownership)
7. [Core abstractions and lifecycle](#7-core-abstractions-and-lifecycle)
8. [Public API design rules](#8-public-api-design-rules)

### Part C — Adapters
9. [RPC adapters](#9-rpc-adapters)
10. [TCP adapter](#10-tcp-adapter)
11. [UDP adapter](#11-udp-adapter)
12. [Kafka integration](#12-kafka-integration)
13. [NATS adapter](#13-nats-adapter)
14. [Adapter implementation checklist](#14-adapter-implementation-checklist)
15. [Adapter-specific implementation notes](#15-adapter-specific-implementation-notes)

### Part D — Cross-cutting concerns
16. [Security architecture and threat model](#16-security-architecture-and-threat-model)
17. [Message envelopes, contracts, and schema evolution](#17-message-envelopes-contracts-and-schema-evolution)
18. [Service registry and discovery](#18-service-registry-and-discovery)
19. [Configuration](#19-configuration)
20. [Authorization model](#20-authorization-model)
21. [Reliability, delivery semantics, and idempotency](#21-reliability-delivery-semantics-and-idempotency)
22. [Common error model and error mapping](#22-common-error-model-and-error-mapping)
23. [Observability and auditing](#23-observability-and-auditing)
24. [Lifecycle, readiness, and graceful shutdown](#24-lifecycle-readiness-and-graceful-shutdown)

### Part E — Runtime behavior
25. [Detailed runtime model and request flows](#25-detailed-runtime-model-and-request-flows)

### Part F — Engineering and operations
26. [Dependency and package boundaries](#26-dependency-and-package-boundaries)
27. [Testing strategy](#27-testing-strategy)
28. [Performance and capacity engineering](#28-performance-and-capacity-engineering)
29. [Deployment and operational guidance](#29-deployment-and-operational-guidance)
30. [Dependency, build, and package distribution policy](#30-dependency-build-and-package-distribution-policy)
31. [Documentation requirements](#31-documentation-requirements)
32. [Expanded verification matrix](#32-expanded-verification-matrix)

### Part G — Governance and delivery
33. [Decisions required before implementation](#33-decisions-required-before-implementation)
34. [Architecture decision records](#34-architecture-decision-records)
35. [Required architecture review checklist](#35-required-architecture-review-checklist)
36. [Implementation phases](#36-implementation-phases)
37. [Definition of done](#37-definition-of-done)

---

# Part A — Foundations

## 1. Overview

`@oneunit/microservice` is a secure, extensible communication layer for services in the OneUnit ecosystem. It provides a consistent application API and shared infrastructure for:

- Configuration and validation
- Service identity and authentication
- Authorization
- Lifecycle management (startup, readiness, graceful shutdown)
- Observability (logging, metrics, tracing, auditing)
- Protocol integration through adapters

The package **integrates** established communication technologies. It is **not a broker implementation** and must never recreate infrastructure that already exists in the OneUnit ecosystem.

### 1.1 Supported integrations

| Category | Technologies | Notes |
|---|---|---|
| **RPC** | tRPC, gRPC, Connect RPC | Native contracts preserved |
| **Direct networking** | TCP, UDP | Only when an application has a concrete raw-network requirement |
| **Messaging** | Kafka (`@oneunit/kafka` or KafkaJS), NATS Core / JetStream | Kafka broker is always external |
| **Service discovery** | In-memory, Redis-backed registry | Leases and health metadata |
| **Security** | Transport security, service authn/authz, optional payload encryption | Fail-closed by default |
| **Operations** | Structured logging, metrics, tracing, auditing, health checks, graceful shutdown | Framework-agnostic |

The package remains independent of application frameworks (Fastify, Express, uWebSockets, etc.). Framework-specific hosting integrations, if needed, are supplied as separate optional packages.

### 1.2 Non-negotiable Kafka boundary

> **The Kafka broker/cluster is external infrastructure.**  
> `@oneunit/microservice` must never create, host, launch, or operate a Kafka broker or server.

The package supports two optional client integrations behind one stable messaging API:

| Driver | Role | When to use |
|---|---|---|
| `@oneunit/kafka` | Optional OneUnit-native client | Convenient inside the OneUnit environment; may reuse established config, credentials, and lifecycle |
| KafkaJS | Optional standard client | Explicit user choice, including when `@oneunit/kafka` is installed; also for standalone applications without OneUnit packages |

**Rules:**

1. Neither driver is mandatory.
2. Explicit selection is always honored. If the selected driver fails (invalid config, auth rejection, broker connectivity), surface that failure — never silently switch drivers.
3. An optional `auto` mode may detect an available driver for convenience; it is never the only supported mode and must document its precedence.
4. Do not build a third Kafka client inside this package.
5. If a needed capability is missing from `@oneunit/kafka`, document the gap and consider extending that package; users may choose KafkaJS when its native API satisfies the need.

Driver selection is independent of broker health. The package never embeds, launches, or manages a broker.

---

## 2. Scope and non-goals

### 2.1 In scope

- A common application API and lifecycle manager
- RPC adapters for tRPC, gRPC, and Connect RPC
- Optional TCP and UDP adapters for explicitly required raw-network use cases
- Optional Kafka integration with explicit driver selection (`@oneunit/kafka` or KafkaJS) plus optional auto-detection; always connects to external Kafka infrastructure
- NATS adapter with distinct Core and JetStream modes
- Service identity, authentication, authorization, service discovery, and health metadata
- Shared error categories, logging conventions, tracing, and metrics
- Optional message envelopes and payload encryption where the threat model requires them

### 2.2 Out of scope

- Creating or embedding a Kafka broker/server
- Reimplementing Kafka broker infrastructure or duplicating client responsibilities already owned by the selected Kafka client
- Replacing Kafka, NATS, gRPC, or other established infrastructure
- Routing every request through a central communication server
- Forcing every protocol into a custom wire format
- Guaranteeing exactly-once business processing across arbitrary services
- Implementing custom cryptographic primitives
- Building a distributed consensus system
- Building a custom reliable transport over UDP in the initial release
- Requiring all adapters to be installed or enabled in every application
- Binding the core to a specific HTTP framework

---

## 3. Architectural principles

1. **Separate core from adapters.** The communication core owns lifecycle, identity, authorization, configuration, observability, and integration conventions. Adapters own native protocol behavior.
2. **Preserve native semantics.** Each protocol retains its own contracts, wire format, delivery guarantees, and error model. The package never pretends transports are interchangeable.
3. **Reuse existing OneUnit packages through their public APIs.** Do not recreate infrastructure that already exists.
4. **No duplicate infrastructure.** Do not introduce competing brokers, offset managers, topic administrators, retry engines, or connection pools that the selected client already owns.
5. **Capability-specific interfaces.** Prefer narrow contracts (`RpcClient`, `MessagePublisher`, `DatagramTransport`, …) over a single universal interface that forces every adapter to implement every operation.
6. **Validate at trust boundaries.** Configuration and untrusted input are validated at runtime before use.
7. **Fail closed for security.** Authentication and authorization default to deny. Missing policy or credential providers must not silently allow access.
8. **Adapters are independently testable and optional.** Core imports must not fail because an unused optional dependency is absent.
9. **Document real guarantees.** Never imply delivery, ordering, or exactly-once semantics that a transport cannot provide.
10. **Keep public APIs small, explicit, and versionable.** Prefer composition over hidden global state or import-time side effects.

---

## 4. Communication models and selection rules

| Technology | Model | Intended use |
|---|---|---|
| tRPC | Request/response | TypeScript-first internal APIs |
| gRPC | Request/response and streaming | Protobuf-defined service calls |
| Connect RPC | Request/response and streaming | Protobuf-based RPC over supported HTTP transports |
| TCP | Ordered byte stream | Custom persistent network communication with application-level framing |
| UDP | Best-effort datagrams | Small telemetry or low-latency signals that tolerate loss |
| Kafka (`@oneunit/kafka` or KafkaJS) | Durable event streaming | Event history, replay, and consumer groups according to the selected client and broker configuration |
| NATS Core | Pub/sub and request/reply | Lightweight messaging without persistence by default |
| NATS JetStream | Persistent messaging | Durable consumers, acknowledgments, and replay |

### 4.1 Selection rules

| Need | Prefer | Avoid |
|---|---|---|
| Direct result from another service | RPC (tRPC / gRPC / Connect) | Routing ordinary RPC through Kafka or NATS |
| Durable event streams and asynchronous processing | Existing Kafka infrastructure | Treating Kafka as a request/reply bus without deliberate design |
| Lightweight pub/sub or request/reply | NATS Core | Assuming Core provides persistence |
| Persistence, acknowledgment, and replay | NATS JetStream | Using Core NATS APIs for JetStream semantics |
| Explicit raw-network requirement not served by an existing protocol | TCP (with framing) | Using TCP when gRPC/Connect already fits |
| Best-effort, loss-tolerant signals | UDP | Building reliable transport on UDP in the first release |

Do not present transport capabilities as universal guarantees. Document actual delivery, ordering, and acknowledgment behavior per adapter and configuration.

---

## 5. High-level architecture

```text
┌───────────────────────────────────────────────────────────┐
│                    Application Services                   │
│              Account · Stories · Media · Gateway           │
└─────────────────────────────┬─────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                 @oneunit/microservice                     │
│                                                           │
│  Public API · Application Lifecycle · Configuration       │
│  Contracts · Identity · Authorization · Error Mapping     │
│  Security Interfaces · Registry Interfaces · Observability│
└─────────────────────────────┬─────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                         Adapters                          │
│                                                           │
│  RPC: tRPC · gRPC · Connect RPC                           │
│  Network: TCP · UDP                                       │
│  Messaging:                                               │
│    Kafka API → selectable driver adapter                  │
│      ├─ @oneunit/kafka (optional OneUnit integration)     │
│      └─ KafkaJS (optional, explicitly selectable)         │
│    NATS adapter → official NATS client                    │
└─────────────────────────────┬─────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                 Existing Infrastructure                   │
│                                                           │
│  Existing Kafka broker/cluster · Existing NATS deployment │
│  RPC endpoints · TCP/UDP endpoints · Redis registry       │
└───────────────────────────────────────────────────────────┘
```

This is a **logical** view. Services may call one another directly or communicate through existing broker infrastructure. There is no requirement to route every message through a central server.

**Kafka ownership reminder:** The broker/cluster and its operational lifecycle remain external. Both `@oneunit/kafka` and KafkaJS are optional, selectable client integrations. Neither starts or manages a broker.

---

# Part B — Structure and core abstractions

## 6. Folder structure and ownership

```text
packages/microservice/
├── src/
│   ├── core/
│   │   ├── application.ts      # Composition root and public lifecycle
│   │   ├── client.ts           # Outbound orchestration helpers
│   │   ├── server.ts           # Inbound orchestration helpers
│   │   ├── lifecycle.ts        # State machine, start/stop, drain
│   │   ├── capabilities.ts     # Capability descriptors
│   │   └── errors.ts           # Shared error categories and helpers
│   ├── config/
│   │   ├── schema.ts           # Zod schemas
│   │   ├── loader.ts           # Precedence, merge, validation
│   │   └── index.ts
│   ├── contracts/
│   │   ├── messages.ts         # Common metadata conventions
│   │   ├── events.ts
│   │   ├── procedures.ts
│   │   ├── schemas.ts
│   │   └── versions.ts
│   ├── identity/
│   │   ├── service-identity.ts
│   │   ├── credentials.ts
│   │   ├── authentication.ts
│   │   └── authorization.ts
│   ├── security/
│   │   ├── encryption.ts
│   │   ├── key-exchange.ts
│   │   ├── signing.ts
│   │   ├── key-provider.ts
│   │   ├── key-rotation.ts
│   │   └── replay-protection.ts
│   ├── registry/
│   │   ├── registry.ts
│   │   ├── store.ts
│   │   ├── memory-store.ts
│   │   ├── redis/           # Driver selection + thin adapters
│   │   │   ├── driver-resolver.ts
│   │   │   ├── types.ts
│   │   │   ├── adapter.ts
│   │   │   ├── oneunit/
│   │   │   ├── ioredis/
│   │   │   └── node-redis/
│   │   ├── discovery.ts
│   │   ├── health.ts
│   │   └── leases.ts
│   ├── transport/
│   │   ├── transport.ts        # Lifecycle + health base
│   │   ├── manager.ts
│   │   └── capabilities.ts
│   ├── adapters/
│   │   ├── rpc/
│   │   │   ├── trpc/
│   │   │   ├── grpc/
│   │   │   └── connect/
│   │   ├── network/
│   │   │   ├── tcp/
│   │   │   └── udp/
│   │   └── messaging/
│   │       ├── kafka/          # Driver selection + thin adapters
│   │       └── nats/
│   ├── observability/
│   │   ├── logger.ts
│   │   ├── metrics.ts
│   │   ├── tracing.ts
│   │   └── audit.ts
│   ├── internal/
│   │   ├── ids.ts
│   │   ├── validation.ts
│   │   └── shutdown.ts
│   ├── index.ts
│   └── public-types.ts
├── test/
│   ├── unit/
│   ├── integration/
│   ├── security/
│   └── fixtures/
├── examples/
├── docs/
│   └── ARCHITECTURE.md
├── package.json
└── tsconfig.json
```

This is a **target layout**, not a mandate to create every file immediately. Add modules when implementation requires them. Adapter internals must not import other adapters’ private files.

### 6.1 Directory ownership

| Directory | Owns |
|---|---|
| `core/` | Application composition, public client/server orchestration, lifecycle, common errors |
| `config/` | Loading, validation, safe defaults, precedence |
| `contracts/` | Common event/message metadata and contract versions |
| `identity/` | Service identity, authentication, authorization interfaces |
| `security/` | Cryptographic operations and key lifecycle interfaces |
| `registry/` | Registration, leases, discovery, health metadata |
| `transport/` | Lifecycle and capability abstractions shared by adapters |
| `adapters/` | Integrations with native protocols and existing packages |
| `observability/` | Logging, metrics, tracing, and audit conventions |
| `internal/` | Private helpers that are not part of the public API |

---

## 7. Core abstractions and lifecycle

The core coordinates adapters without implementing their native protocols.

### 7.1 Capability and health descriptors

```ts
export interface TransportCapabilities {
  requestResponse: boolean;
  streaming: boolean;
  publishSubscribe: boolean;
  durableDelivery: boolean;
  orderedDelivery: boolean;
  bidirectional: boolean;
}

export interface TransportHealth {
  status: "healthy" | "degraded" | "unhealthy";
  checkedAt: number;
  details?: Record<string, unknown>;
}

export interface Transport {
  readonly name: string;
  readonly capabilities: TransportCapabilities;
  start(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<TransportHealth>;
}
```

These capabilities describe **adapter features**, not universal guarantees. Prefer capability-specific interfaces:

```ts
interface Lifecycle {
  start(signal?: AbortSignal): Promise<void>;
  close(options?: { timeoutMs?: number }): Promise<void>;
}

interface HealthReporter {
  healthCheck(): Promise<TransportHealth>;
}

interface RpcInvoker<TRequest, TResponse> {
  invoke(request: TRequest, options?: RpcCallOptions): Promise<TResponse>;
}

interface MessagePublisher<TEvent> {
  publish(event: TEvent, options?: PublishOptions): Promise<PublishReceipt>;
}

interface MessageHandler<TEvent> {
  handle(event: TEvent, context: MessageContext): Promise<void>;
}
```

A datagram adapter must not be forced to implement RPC; a Kafka adapter must not be forced to implement bidirectional streaming.

### 7.2 Application lifecycle obligations

The application lifecycle must:

1. Validate configuration before opening connections.
2. Initialize shared dependencies (logger, clock, ID generator, metrics/tracing, policy provider, registry store).
3. Construct only the adapters enabled by configuration and installed dependencies.
4. Start required adapters in a defined order.
5. Fail clearly if a required adapter cannot start.
6. Report optional adapter failures as degraded when configured to do so.
7. Stop accepting new work during shutdown.
8. Drain or safely terminate in-flight work up to a deadline.
9. Close adapters and release registry leases.
10. Make `start()` and `close()` idempotent or reject repeated calls predictably.

The Kafka adapter may initialize or close **adapter-owned** resources and must follow the selected driver’s documented lifecycle rules. It must never start or stop the Kafka broker/cluster.

---

## 8. Public API design rules

The public API should be small and compositional. Snippets in this document are **illustrative design sketches**, not declarations of existing exports. Implementation must first compare them with repository conventions and actual dependency APIs.

### 8.1 Application composition (illustrative)

```ts
const app = createMicroservice({
  service: {
    name: "stories",
    version: "1.4.0",
    instanceId: process.env.INSTANCE_ID,
  },
  adapters: {
    grpc: { enabled: true },
    kafka: { enabled: true, driver: "oneunit" },
  },
});

await app.start();
// Application serves work here.
await app.close();
```

Do not copy this snippet into implementation without deciding the real public types, dependency-injection strategy, and adapter installation model. Avoid hidden global state and implicit startup on import.

### 8.2 Public versus internal exports

- Export documented, stable application-facing types from the package entry point or documented subpath exports.
- Keep adapter implementation details, connection internals, serializers, and test helpers private.
- Do not expose internal file paths as supported API unless the package deliberately defines subpath exports.
- Avoid a barrel that imports every optional adapter eagerly. Core imports must not fail because an unused optional dependency is absent.
- Use explicit `exports` mappings for ESM runtime entry points and declaration files.
- Test import behavior from a consumer fixture, not only from inside the monorepo.

### 8.3 API stability

A public API change is breaking if it changes a documented type, default, error category, lifecycle guarantee, or observable behavior. Before stabilization, label the package or subpath experimental and document that its contract may change. After stabilization, follow semantic versioning and provide a migration note for breaking changes.

---

# Part C — Adapters

## 9. RPC adapters

Each RPC framework retains its native contracts, wire protocol, and supported semantics.

### 9.1 tRPC

The adapter owns router/client integration, authentication middleware integration, error mapping, timeouts, cancellation where supported, and validation. Native tRPC types and contracts must remain usable so TypeScript inference stays useful to callers.

### 9.2 gRPC

The adapter owns Protobuf service registration, client/server lifecycle, metadata propagation, deadlines, cancellation, native status mapping, TLS, and credentials. Use `@grpc/grpc-js`. Use `@grpc/proto-loader` only when dynamic loading is required; generated code is preferred.

### 9.3 Connect RPC

The adapter owns service handlers, clients, Protobuf contracts, HTTP transport integration, interceptors, error mapping, streaming, and native compatibility. Use the Node transport supported by the installed Connect RPC version.

### 9.4 RPC rules

- Do not force all RPC frameworks into a custom JSON-RPC envelope.
- Keep native schemas and contracts intact.
- Share service identity, tracing conventions, and common error categories through adapters.
- Validate untrusted input at runtime where the native contract does not already do so.
- Document contract and protocol versioning.
- Do not assume contracts from different RPC frameworks are automatically interchangeable.

---

## 10. TCP adapter

TCP is a byte stream and requires application-level framing.

### 10.1 Responsibilities

- Four-byte big-endian length-prefixed framing
- Frame-size limits enforced **before** allocation
- TLS support where required (via Node’s established TLS facilities)
- Bounded connection pools and backpressure
- Request correlation when request/response is implemented
- Timeouts, connection cleanup, and graceful shutdown
- Exponential backoff with jitter for suitable reconnection cases
- Correct handling of partial headers, partial payloads, and multiple frames per read

### 10.2 Frame layout

```text
┌──────────────────────────┬────────────────────────────┐
│ 4-byte unsigned length   │ Serialized message payload │
│ Big-endian               │ Exactly length bytes       │
└──────────────────────────┴────────────────────────────┘
```

### 10.3 Guarantees and limitations

TCP provides an ordered byte stream while a connection operates. It does **not** provide message boundaries or business-level delivery guarantees without an application protocol. The parser must handle incomplete headers, incomplete payloads, several frames in one read, malformed lengths, connection closure mid-frame, and buffer compaction.

---

## 11. UDP adapter

UDP is limited initially to small, best-effort datagrams.

### 11.1 Responsibilities

- Version packet formats
- Enforce datagram-size limits (conservative maximum based on deployment network; avoid IP fragmentation assumptions)
- Include message identity and sender metadata when required
- Use sequence numbers and timestamps only where they serve a defined purpose
- Authenticate packets and prevent replay where required
- Rate-limit traffic and reject malformed packets
- Do not assume delivery, order, or duplicate suppression

### 11.2 Out of scope for first release

Custom fragmentation, retransmission, ACK/NACK, congestion control, and reliable ordering. Use an established protocol if reliable transport is needed.

Treat each datagram as independently lossy and potentially spoofed. Do not send sensitive information over UDP without an explicitly reviewed protection design.

---

## 12. Kafka integration

### 12.1 Core requirement

`@oneunit/microservice` supports two interchangeable-at-the-integration-boundary Kafka client options. Neither is mandatory; neither is forced on every consumer.

| Driver | Role |
|---|---|
| `@oneunit/kafka` | Optional; convenient for applications already running in the OneUnit environment |
| KafkaJS | Optional; selectable even when `@oneunit/kafka` is installed; supports standalone applications |

This is a choice of **client integration**, not a choice to create or select a Kafka server. In both modes the Kafka broker/cluster is external infrastructure.

### 12.2 Runtime selection policy

The package exposes one stable Kafka messaging API while keeping each implementation behind an adapter boundary. Driver selection must be deterministic and documented:

| Value | Behavior |
|---|---|
| `driver: "oneunit"` | Selects `@oneunit/kafka`; fails clearly if that optional integration is unavailable |
| `driver: "kafkajs"` | Selects KafkaJS whether or not `@oneunit/kafka` is installed |
| `driver: "auto"` | Optional convenience mode that deterministically chooses an available supported driver; document precedence |

**Rules:**

- If the explicitly selected driver is unavailable, return an actionable dependency-resolution error. Do not silently substitute another driver.
- Do not infer that a package is usable merely because its name appears in configuration. Verify that its public exports and required capabilities are available.
- Do not import either optional client from the core entry point in a way that makes both packages mandatory. Use adapter-specific entry points, optional dependencies, or guarded dynamic imports consistent with ESM and bundling requirements.
- Do not make import-time side effects connect to a broker.

Illustrative configuration:

```ts
const app = createMicroservice({
  adapters: {
    kafka: {
      enabled: true,
      driver: "oneunit", // or "kafkajs"
      // Pass configuration supported by the selected adapter.
    },
  },
});
```

### 12.3 Architecture

```text
Application Service
        │
        ▼
@oneunit/microservice public Kafka API
        │
        ▼
Kafka driver selection (explicit; no connection-time switching)
        │
        ├── @oneunit/kafka adapter  [optional; explicitly selectable]
        │          │
        │          ▼
        │     Existing OneUnit Kafka integration/configuration
        │
        └── KafkaJS adapter         [optional; explicitly selectable]
                   │
                   ▼
             Existing Kafka broker/cluster
```

Both adapters connect to the same kind of external Kafka infrastructure. Neither owns the broker.

### 12.4 Ownership boundaries

| Owner | Responsibilities |
|---|---|
| **External Kafka infrastructure** | Broker/cluster processes, deployment, replication, persistence, availability; topics, partitions, retention, quotas, broker administration; cluster-level authentication and access controls |
| **`@oneunit/kafka` (when selected)** | OneUnit-native configuration and environment integration; producer/consumer APIs and client connection lifecycle; consumer groups, offsets, acknowledgments, retries where supported; its own error types, metrics, and operational conventions |
| **KafkaJS (when selected)** | KafkaJS client, producer, and consumer instances; connection configuration and client lifecycle; consumer group and offset behavior exposed by KafkaJS; KafkaJS-native retry, error, and acknowledgment behavior |
| **`@oneunit/microservice`** | Stable public API for publishing and consuming (to the extent supported by the chosen driver); driver selection and clear diagnostics when an adapter cannot be loaded; mapping shared message metadata to native headers/fields where supported; applying common validation, authorization, tracing, and error-normalization hooks without erasing native errors; coordinating application shutdown according to the selected client’s documented lifecycle contract |

The package must not build a broker, duplicate the selected client’s producer/consumer internals, or introduce a competing offset manager, topic administrator, retry engine, or connection pool. A small adapter may translate APIs but must not pretend the two clients have identical feature sets or delivery semantics.

### 12.5 API discovery and capability differences

Before implementing either adapter, inspect the actual package exports, TypeScript declarations, supported configuration, lifecycle, error behavior, and tests. Do not invent exports based on examples in this document.

Define and test a capability matrix for both drivers covering acknowledgments, transactions, headers, consumer-group behavior, retry controls, health information, and shutdown. Expose only the common behavior that can be implemented honestly; provide clearly documented driver-specific configuration for native features rather than flattening important differences.

If a needed capability is missing from `@oneunit/kafka`:

1. Record the exact capability gap against its actual public API.
2. Determine whether the feature belongs in `@oneunit/kafka` and propose an extension there.
3. If a user needs that feature immediately, the application may select the KafkaJS adapter when the feature is supported there.
4. Do not create a third Kafka implementation inside `@oneunit/microservice`.

### 12.6 Suggested adapter structure

```text
adapters/messaging/kafka/
├── driver-resolver.ts       # Explicit selection and optional auto mode
├── types.ts                 # Shared capability-level types
├── adapter.ts               # Stable adapter facade
├── oneunit/
│   ├── adapter.ts           # Thin wrapper over @oneunit/kafka public API
│   └── index.ts
├── kafkajs/
│   ├── adapter.ts           # KafkaJS-backed implementation
│   └── index.ts
├── event-mapping.ts         # Shared metadata mapping where appropriate
├── error-mapping.ts         # Normalize without discarding native causes
├── health.ts                # Health only where the selected driver supports it
└── index.ts
```

Treat this as a logical structure, not a requirement to create every file. Avoid a large abstraction layer when a small adapter is enough. Do not place optional client imports in shared files that load for every user.

### 12.7 Reliability and operational rules

- Preserve native topic, partition, offset, consumer-group, ordering, and acknowledgment semantics.
- Use stable message IDs and schema versions where the application’s event contract requires them.
- Propagate correlation and trace metadata through headers supported by the selected driver.
- Make application consumers idempotent wherever duplicate processing is possible.
- Respect the selected driver’s acknowledgment, retry, offset, transaction, and shutdown behavior.
- Do not claim exactly-once business execution without an end-to-end design that establishes it.
- Do not silently create topics or modify broker configuration unless explicitly requested and supported by the selected integration.
- Distinguish dependency-resolution errors, invalid configuration, authentication failures, and broker connectivity failures.
- Test both adapters with mocks/unit tests and integration tests against a real or disposable test broker. The broker remains test infrastructure, never an embedded production feature of this package.

### 12.8 Dependency and installation strategy

- `@oneunit/kafka` should be an optional integration dependency or peer dependency according to its real packaging. Its absence must not prevent users from importing the core package or using unrelated adapters.
- `kafkajs` should also be optional unless the published package intentionally ships a separate KafkaJS adapter entry point with KafkaJS as a declared peer requirement.
- Do not install or load both clients as mandatory runtime dependencies just to support auto-selection.
- Keep driver resolution explicit, testable, and deterministic in ESM and in the packed npm artifact.
- Document installation commands for OneUnit environments and standalone KafkaJS environments separately.
- If the OneUnit package is present but broken or misconfigured, fail with that cause rather than treating the problem as if the package were absent.

---

## 13. NATS adapter

NATS is a separate integration and must not be implemented using Kafka abstractions that erase its native behavior.

### 13.1 NATS Core

Support pub/sub, request/reply, subject-based routing, connection lifecycle, reconnection/error reporting, and health checks. Do not assume persistence or replay by default.

### 13.2 NATS JetStream

When enabled, support durable consumers, acknowledgments, persistence, replay, redelivery, retention, and native consumer lifecycle. Treat JetStream as a distinct mode with separate configuration and delivery semantics.

Use the official NATS client. Do not recreate native broker acknowledgments, persistence, or redelivery behavior in the common core. Core NATS and JetStream must be distinguishable in API and documentation.

---

## 14. Adapter implementation checklist

Every adapter must document and test the following before it is considered production-ready:

1. Native protocol/client version and supported features
2. Exact package dependency and whether it is mandatory, optional, or peer-installed
3. Required and optional configuration fields
4. Authentication, authorization, TLS, and credential rotation behavior
5. Request/message serialization and maximum sizes
6. Timeout, deadline, cancellation, and retry semantics
7. Delivery, ordering, acknowledgment, and redelivery guarantees
8. Concurrency, buffering, backpressure, and resource limits
9. Startup, health-check, reconnection, and shutdown behavior
10. Native-to-common error mapping and preserved native details
11. Logging, metrics, trace propagation, and secret redaction
12. Compatibility and contract evolution policy
13. Unit, integration, negative, load, and packaging tests
14. Runnable minimal example and operational notes
15. Explicit known limitations and unsupported features

An adapter is not complete merely because it can send one successful request or publish one message. Failure paths and resource limits are part of the contract.

---

## 15. Adapter-specific implementation notes

### 15.1 tRPC

Keep tRPC router and procedure types intact so TypeScript inference remains useful. Authentication context should be created from verified credentials, not arbitrary client-supplied context. Use tRPC’s native middleware and error conventions; map shared error categories at the boundary without replacing useful native error codes. Document whether the adapter wraps an existing router or constructs/hosts one. Avoid requiring a particular HTTP framework in the core package; if hosting depends on a framework adapter, isolate it as an optional integration.

### 15.2 gRPC

Use Protobuf service definitions as the contract source. Define channel credentials, server credentials, deadlines, cancellation, metadata limits, message size limits, and keepalive policy explicitly. Interceptors should propagate trace/correlation metadata and apply authentication/authorization. Use native status codes and preserve details safely. Streaming handlers must define flow-control and cancellation behavior. Dynamic `.proto` loading should be optional rather than a mandatory runtime requirement if generated code is preferred.

### 15.3 Connect RPC

Preserve generated Protobuf types and Connect’s protocol behavior. Keep the chosen Node transport and HTTP server integration explicit and version-compatible. Define unary and streaming behavior, interceptors, error translation, compression if enabled, and limits. Do not assume a Connect handler can be mounted identically into every web server without an adapter layer.

### 15.4 TCP

A TCP connection delivers bytes, not discrete messages. The parser must handle incomplete headers, incomplete payloads, several frames in one read, malformed lengths, connection closure mid-frame, and buffer compaction. Check the length against the configured maximum before allocating the payload buffer. Define whether a connection is one-request-at-a-time or supports multiplexed requests; if multiplexing is supported, include a correlation ID and protect against unbounded in-flight requests. Apply socket backpressure and close malformed peers safely.

### 15.5 UDP

Treat each datagram as independently lossy and potentially spoofed. Enforce a conservative maximum size. Do not build reliable transport in the first release. Apply source-aware rate limits carefully because source addresses may be spoofed. Authenticate messages at the application layer when required, and use replay protection for security-sensitive commands.

### 15.6 Kafka drivers

Inspect the actual `@oneunit/kafka` exports, types, configuration, lifecycle, and tests before implementing that optional adapter. Inspect KafkaJS APIs and types independently; do not assume both clients expose identical behavior.

Driver selection must be deterministic and user-controlled. Honor `driver: "oneunit"` and `driver: "kafkajs"` exactly; an optional `auto` mode may be offered as a convenience. Never switch drivers silently after a selected client fails to initialize or connect. Do not introduce a Kafka server, embedded broker, duplicate client internals, parallel offset/topic/retry systems, or competing configuration model.

### 15.7 NATS Core and JetStream

Use the supported NATS client and preserve its subject and subscription semantics. Core NATS and JetStream must be distinguishable in API and documentation because persistence, acknowledgments, replay, and consumer configuration differ. Define connection reconnect behavior, subscription cleanup, queue-group semantics if used, acknowledgment deadlines, redelivery limits, and durable consumer ownership. Do not imply that Core NATS provides JetStream persistence.

---

# Part D — Cross-cutting concerns

## 16. Security architecture and threat model

Security consists of separate layers:

1. Transport security
2. Service authentication
3. Operation-level authorization
4. Message integrity
5. Optional payload encryption
6. Replay protection
7. Key management and rotation
8. Audit logging

### 16.1 Assets to protect

- Service credentials, private keys, encryption keys, and signing keys
- Confidential request/response payloads and event bodies
- Tenant boundaries and authorization decisions
- Service registry integrity and endpoint authenticity
- Message integrity, freshness, and replay resistance where required
- Availability of listeners, brokers, queues, and application handlers
- Audit trails and security configuration

### 16.2 Trust boundaries

Treat inbound network data, broker messages, registry entries, environment values, tenant identifiers, and remote error details as untrusted until validated. A service name or instance ID supplied in a message is an assertion, not proof of identity. Trust must derive from authenticated transport credentials, verified signatures, or another explicitly documented mechanism.

### 16.3 Identity and authorization

Each service instance must have a verifiable identity. Authorization must rely on authenticated identity and policy, not merely a service ID in a message payload. Credentials must be provisioned, rotated, and revocable. Default policy is deny.

**Authentication is not authorization.** A valid certificate, token, or signed message proves only the identity or credential claims defined by that mechanism. It does not automatically grant permission to invoke every service method, publish to every topic, subscribe to every subject, or act across every tenant. Authorization must be evaluated separately and fail closed if the required policy provider is unavailable.

### 16.4 Transport security

Use TLS for supported network connections and validate peer identities. Use the native TLS/authentication capabilities of gRPC, Connect RPC, Kafka, and NATS. TLS protects a connection; it does not provide end-to-end confidentiality across brokers or intermediaries. Prefer mutual TLS when both sides need cryptographic service identity.

### 16.5 Application-level cryptography

Where end-to-end payload encryption is required:

| Requirement | Rule |
|---|---|
| Authenticated encryption | AES-256-GCM with a 12-byte nonce and a 16-byte authentication tag |
| Nonce uniqueness | Never reuse a nonce with the same AES-GCM key |
| Key exchange | X25519 only within an authenticated key-exchange protocol |
| Key derivation | HKDF-SHA-256 for purpose-specific key derivation |
| Signing | Independent Ed25519 signing keys when message signatures are required |
| Key separation | Never derive Ed25519 private keys from an X25519 shared secret |
| Associated data | Authenticate routing/security metadata as associated data or with a clearly defined canonical signature format |
| Replay protection | Message IDs, nonces or sequence numbers, and bounded replay state |
| Key lifecycle | Support key identifiers, rotation, revocation, and expiration |
| Secrets hygiene | Never log or commit private keys, root secrets, or credentials |

Use established, reviewed protocols and libraries. Do not invent cryptographic primitives or an unauthenticated handshake.

### 16.6 Encryption boundaries

Make payload encryption configurable according to the threat model and data classification. If brokers or intermediaries must not read a payload, encrypt before publishing and decrypt only at authorized consumers. If intermediaries need to inspect or transform payloads, document the trade-off explicitly.

Transport encryption (TLS/mTLS) protects a network connection. Application-level end-to-end encryption protects payloads beyond the transport termination point but introduces key distribution, rotation, recipient management, replay, metadata leakage, and recovery complexity. Before enabling application-level encryption, document the threat model, authenticated metadata, nonce/IV requirements, key derivation, rotation, backup/recovery, recipient changes, and compromise response.

### 16.7 Replay protection

Replay protection is not free. Decide which operations require freshness protection, what clock assumptions exist, and where replay state is stored. A timestamp-only check can fail under clock skew and does not reliably prevent repeated use within the accepted window. Use message IDs/nonces and a bounded, shared replay store when cross-instance protection is required. State retention must cover the acceptance window; restart/failover behavior must be tested.

### 16.8 Required controls

- Authenticate service-to-service connections when the deployment’s threat model requires identity assurance
- Use TLS for untrusted networks; use mutual TLS when both sides need cryptographic service identity
- Authorize the caller for the target service, operation, and tenant/resource
- Rotate credentials and revoke compromised identities
- Validate all externally supplied identifiers and payloads
- Limit connection counts, request rates, message sizes, and handler concurrency
- Redact secrets in logs and traces
- Avoid leaking service existence, internal endpoints, or policy details through public errors
- Keep secrets out of source control, examples, generated declarations, and package tarballs
- Test negative paths, not only successful authentication

---

## 17. Message envelopes, contracts, and schema evolution

### 17.1 Keep protocol contracts distinct

RPC request schemas, domain events, and raw network packets solve different problems. Do not use one universal schema as a substitute for Protobuf definitions, tRPC router types, Connect service definitions, or native Kafka/NATS metadata. A shared metadata convention may complement native contracts; it must not replace them.

### 17.2 Logical message envelope

Use a common logical envelope for application events and custom transport messages. Do not force it onto native RPC protocols when it conflicts with their native contract.

```ts
export interface MessageEnvelope<TPayload = unknown> {
  version: 1;
  messageId: string;
  type: string;
  schemaVersion: number;
  source: {
    serviceId: string;
    instanceId: string;
  };
  destination?: {
    serviceId: string;
  };
  timestamp: number;
  correlationId?: string;
  traceContext?: Record<string, string>;
  payload: TPayload;
}
```

For encrypted messages, define a separate versioned envelope with a cipher-suite identifier, key ID, nonce, ciphertext, authentication tag, authenticated metadata, and an optional signature when required by the threat model.

Wire encodings remain adapter-specific. Kafka headers, NATS headers, RPC metadata, and TCP frames are not interchangeable. Validate remote messages at runtime, even when the sender is authenticated.

### 17.3 Suggested common metadata

Where a transport supports it, a message may carry:

| Field | Purpose | Rule |
|---|---|---|
| `messageId` | Stable identity for one logical message | Generate once; preserve across redelivery |
| `messageType` | Domain event or operation name | Use a documented, stable identifier |
| `schemaVersion` | Payload contract version | Explicit; do not infer from deployment version |
| `producer.service` | Logical producer identity | Must come from authenticated configuration/context |
| `producer.instanceId` | Concrete producer instance | Diagnostic only; not a trusted identity by itself |
| `occurredAt` | Domain event time | ISO 8601 or a defined numeric format; document timezone/precision |
| `publishedAt` | Time the publisher attempted publication | Separate from domain occurrence time |
| `correlationId` | Groups related work | Propagate through a workflow when available |
| `causationId` | Identifies the event/request that caused this message | Optional; useful for event chains |
| `traceparent` | Distributed trace context | Follow W3C Trace Context when enabled |
| `tenantId` | Tenant boundary | Validate and authorize; never trust it solely because it is in a payload |
| `contentType` | Payload encoding | Explicit when not defined by the native protocol |

Do not require every field on every transport. Define a minimal common set and adapter capability mapping. Never treat user-controlled metadata such as `producer.service` or `tenantId` as authenticated identity without verifying it against trusted context.

### 17.4 Serialization rules

- Use the protocol’s native serialization when one is defined.
- For custom TCP frames, choose a serialization format explicitly and version the frame header.
- For UDP, use compact bounded packets and reject unsupported versions.
- Enforce payload size limits before parsing or allocating large buffers.
- Reject invalid encodings, unknown mandatory fields, and malformed metadata according to documented compatibility policy.
- Never deserialize arbitrary executable objects or enable unsafe object reconstruction.
- Define deterministic serialization only where signatures, hashing, or deduplication depend on byte-level equality.

### 17.5 Schema compatibility policy

The project must choose and document a compatibility policy for each contract family:

| Policy | Meaning |
|---|---|
| **Backward compatible** | New consumers can read old messages; new optional fields may be added without changing existing meanings |
| **Forward compatible** | Old consumers can safely ignore fields or values introduced by newer producers |
| **Breaking** | Field meaning, requiredness, encoding, enum semantics, or routing identity changes in a way existing participants cannot safely handle |

Prefer additive changes. Never reuse a removed field number or identifier where the underlying schema system prohibits it. For event payloads, retain the ability to consume historical versions for as long as broker retention or replay can surface them. A package version is not a substitute for an event schema version.

### 17.6 Validation boundaries

Validate at the boundary where data becomes trusted:

1. Validate configuration during startup.
2. Validate inbound transport framing before allocating or decoding the complete payload.
3. Validate protocol-native contracts using the selected RPC/message technology.
4. Validate domain invariants in the application/domain layer.
5. Validate authorization independently of schema validity.

Avoid duplicating expensive validation at every internal layer without a clear trust-boundary reason. Preserve validation errors in a safe, structured form.

---

## 18. Service registry and discovery

The registry tracks service instances; it does not guarantee that a discovered endpoint remains available.

### 18.1 Registry interface

```ts
export interface ServiceRegistry {
  register(registration: ServiceRegistration): Promise<ServiceLease>;
  renew(leaseId: string): Promise<void>;
  discover(query: ServiceQuery): Promise<ServiceInstance[]>;
  deregister(leaseId: string): Promise<void>;
}
```

Registry entries should include: service ID, instance ID, endpoints, supported protocols/capabilities, contract versions, health/readiness, lease expiration, last heartbeat, authenticated identity metadata, and registration time.

**Never store reusable secrets or private keys in a registry record.** Endpoint information must be authenticated or otherwise protected against registry poisoning.

### 18.2 Backends

| Backend | Suitable for | Notes |
|---|---|---|
| In-memory | Development, tests, single-process scenarios | Not shared across replicas; must not be described as distributed discovery |
| Redis-backed | Multi-instance deployments needing shared discovery state | Provides shared storage only to the extent its configured Redis deployment provides it; does not by itself guarantee consensus or eliminate stale reads |

Use atomic operations where required for lease renewal and expiration. Document Redis availability, authentication, TLS, key prefixing, TTL behavior, and cleanup strategy.

### 18.3 Redis driver selection

`@oneunit/microservice` supports multiple Redis client options for the Redis-backed registry. The Redis broker/cluster is external infrastructure — the package never creates, hosts, or manages a Redis server.

| Driver | Role |
|---|---|
| `@oneunit/redis` | Optional; convenient for applications already running in the OneUnit environment |
| `ioredis` | Optional; feature-rich Redis client with sentinel/cluster support |
| `redis` (node-redis) | Optional; official Node.js Redis client |

This is a choice of **client integration**, not a choice to create or select a Redis server. In all modes the Redis server/cluster is external infrastructure.

#### 18.3.1 Runtime selection policy

The package exposes one stable Redis registry API while keeping each implementation behind an adapter boundary. Driver selection must be deterministic and documented:

| Value | Behavior |
|---|---|
| `driver: "oneunit"` | Selects `@oneunit/redis`; fails clearly if that optional integration is unavailable |
| `driver: "ioredis"` | Selects ioredis whether or not `@oneunit/redis` is installed |
| `driver: "node-redis"` | Selects node-redis (the `redis` package) whether or not other drivers are installed |
| `driver: "auto"` | Optional convenience mode that deterministically chooses an available supported driver; document precedence |

**Rules:**

- If the explicitly selected driver is unavailable, return an actionable dependency-resolution error. Do not silently substitute another driver.
- Do not infer that a package is usable merely because its name appears in configuration. Verify that its public exports and required capabilities are available.
- Do not import any optional client from the core entry point in a way that makes any package mandatory. Use adapter-specific entry points, optional dependencies, or guarded dynamic imports consistent with ESM and bundling requirements.
- Do not make import-time side effects connect to Redis.

Illustrative configuration:

```ts
const app = createMicroservice({
  registry: {
    backend: "redis",
    redis: {
      driver: "oneunit", // or "ioredis", "node-redis", "auto"
      host: "localhost",
      port: 6379,
    },
  },
});
```

#### 18.3.2 Architecture

```text
Application Service
        │
        ▼
@oneunit/microservice public Registry API
        │
        ▼
Redis driver selection (explicit; no connection-time switching)
        │
        ├── @oneunit/redis adapter  [optional; explicitly selectable]
        │          │
        │          ▼
        │     Existing OneUnit Redis integration/configuration
        │
        ├── ioredis adapter         [optional; explicitly selectable]
        │          │
        │          ▼
        │     Existing Redis server/cluster (supports Sentinel/Cluster)
        │
        └── node-redis adapter      [optional; explicitly selectable]
                   │
                   ▼
              Existing Redis server/cluster
```

Both adapters connect to the same kind of external Redis infrastructure. Neither owns the Redis server.

#### 18.3.3 Ownership boundaries

| Owner | Responsibilities |
|---|---|
| **External Redis infrastructure** | Redis server/cluster processes, deployment, replication, persistence, availability; Sentinel/Cluster configuration; authentication and access controls |
| **`@oneunit/redis` (when selected)** | OneUnit-native configuration and environment integration; client connection lifecycle; its own error types, metrics, and operational conventions |
| **ioredis (when selected)** | ioredis client instance; connection configuration and client lifecycle; Sentinel/Cluster support; ioredis-native retry, error, and reconnection behavior |
| **node-redis (when selected)** | node-redis client instance; connection configuration and client lifecycle; node-redis-native error and reconnection behavior |
| **`@oneunit/microservice`** | Stable public API for registry operations; driver selection and clear diagnostics when an adapter cannot be loaded; applying common validation, authorization, tracing, and error-normalization hooks without erasing native errors; coordinating application shutdown according to the selected client's documented lifecycle contract |

The package must not build a Redis server, duplicate the selected client's connection pool or retry logic, or introduce a competing connection management system. A small adapter may translate APIs but must not pretend the clients have identical feature sets or delivery semantics.

#### 18.3.4 Suggested adapter structure

```text
registry/redis/
├── driver-resolver.ts       # Explicit selection and optional auto mode
├── types.ts                 # Shared capability-level types
├── adapter.ts               # Stable adapter facade
├── oneunit/
│   ├── adapter.ts           # Thin wrapper over @oneunit/redis public API
│   └── index.ts
├── ioredis/
│   ├── adapter.ts           # ioredis-backed implementation
│   └── index.ts
├── node-redis/
│   ├── adapter.ts           # node-redis-backed implementation
│   └── index.ts
└── index.ts
```

Treat this as a logical structure, not a requirement to create every file. Avoid a large abstraction layer when a small adapter is enough. Do not place optional client imports in shared files that load for every user.

#### 18.3.5 Dependency and installation strategy

- `@oneunit/redis` should be an optional integration dependency or peer dependency according to its real packaging. Its absence must not prevent users from importing the core package or using the in-memory registry.
- `ioredis` should also be optional unless the published package intentionally ships a separate ioredis adapter entry point with ioredis as a declared peer requirement.
- `redis` (node-redis) should also be optional.
- Do not install or load all clients as mandatory runtime dependencies just to support auto-selection.
- Keep driver resolution explicit, testable, and deterministic in ESM and in the packed npm artifact.
- Document installation commands for OneUnit environments and standalone environments separately.
- If the OneUnit package is present but broken or misconfigured, fail with that cause rather than treating the problem as if the package were absent.

### 18.3 Lease lifecycle

Registration creates or renews a lease with a bounded TTL. An instance must renew before expiry; expiry makes it ineligible for new discovery results. Graceful shutdown should deregister explicitly, but correctness must not depend on deregistration succeeding — stale entries should expire automatically.

The registry must define whether renewal is owned by the application lifecycle or the registry implementation, how failures affect readiness, and how long an instance remains discoverable during shutdown.

### 18.4 Discovery and endpoint selection

Discovery should return only instances that are eligible under the configured health and compatibility policy. Selection strategy (round-robin, random, locality-aware, or caller-selected) must be explicit and testable. Avoid adding a complex load balancer before requirements justify it. Client-side caches need a TTL and a refresh strategy; stale cached endpoints must fail safely and trigger refresh.

The registry is not automatically a health authority for every transport. Define active versus passive health checks, check intervals, timeouts, and behavior when health checks themselves fail. Apply jitter to avoid synchronized health-check bursts across many instances.

---

## 19. Configuration

Validate configuration with Zod before initializing adapters. Keep common settings separate from native adapter settings. Configuration is validated once during startup and then treated as immutable unless live reload is deliberately designed. Invalid values must fail early with field paths and safe messages. Secret values must never be printed in validation errors.

### 19.1 Shared configuration (illustrative shape)

```ts
export interface MicroserviceConfig {
  service: {
    id: string;
    name: string;
    instanceId: string;
  };
  security: {
    authenticationEnabled: boolean;
    encryptionMode: "disabled" | "selective" | "required";
    keyRotationIntervalMs: number;
    sessionTimeoutMs: number;
  };
  registry: {
    backend: "memory" | "redis";
    ttlMs: number;
    heartbeatIntervalMs: number;
  };
  observability: {
    logging: boolean;
    metrics: boolean;
    tracing: boolean;
    audit: boolean;
  };
}
```

Production deployments must also define credential providers, allowed identities, trusted issuers/certificates, and relevant authorization policies.

### 19.2 Adapter-specific configuration

| Adapter | Key settings |
|---|---|
| TCP | Bind address, port, TLS, frame limit, connection limits |
| UDP | Bind address, port, datagram limit, rate limits |
| tRPC | Router, endpoint, middleware, timeout policy |
| gRPC | Service definitions, endpoint, credentials, deadlines |
| Connect RPC | Handlers, HTTP transport, credentials, deadlines |
| Kafka | Configuration through the selected driver's public API; do not create a second Kafka configuration system |
| NATS | Server endpoints, credentials, Core/JetStream mode |
| Redis registry | Driver selection (oneunit/ioredis/node-redis/auto), connection settings, TTL, lease behavior, Sentinel/Cluster options |

Do not place all native settings in one generic transport configuration. Never silently fall back to insecure defaults in production.

### 19.3 Precedence

If multiple sources are supported, define one precedence order — for example: explicit programmatic options → environment variables → configuration file → documented defaults. Do not merge arbitrary sources silently. Reject unknown keys in strict mode or document how extension keys are handled. Keep adapter-specific configuration under the adapter’s namespace.

### 19.4 Conceptual configuration example

```ts
{
  service: {
    name: "stories",
    version: "1.4.0",
    instanceId: "stories-7f9c",
  },
  lifecycle: {
    startupTimeoutMs: 15_000,
    shutdownTimeoutMs: 10_000,
    drainTimeoutMs: 8_000,
  },
  limits: {
    maxMessageBytes: 1_048_576,
    maxConcurrentRequests: 500,
    maxQueuedMessages: 1_000,
  },
  registry: {
    enabled: true,
    backend: "redis",
    redis: {
      driver: "oneunit",
      host: "localhost",
      port: 6379,
    },
    leaseTtlMs: 30_000,
    renewIntervalMs: 10_000,
  },
  adapters: {
    grpc: { enabled: false },
    trpc: { enabled: false },
    connect: { enabled: false },
    kafka: { enabled: true, driver: "oneunit" },
    nats: { enabled: false },
    tcp: { enabled: false },
    udp: { enabled: false },
  },
}
```

Numbers above are examples only and must not become production defaults without workload testing and review. Configuration should validate relationships, not just individual values: lease renewal must occur well before lease expiry; shutdown/drain deadlines must fit within the process manager’s termination grace period.

### 19.5 Configuration categories

| Category | Contents |
|---|---|
| Identity | Service name, version, instance ID, credential provider reference |
| Lifecycle | Startup timeout, shutdown timeout, drain deadline, optional-adapter policy |
| Resource limits | Payload sizes, concurrency, queue depth, connections, per-peer limits |
| Registry | Backend, namespace/key prefix, lease TTL, renewal cadence, health policy |
| Security | Trust roots, credential source, allowed identities, authorization policy reference, rotation policy |
| Observability | Logger adapter, log level, metrics/tracing exporters, sampling and redaction policy |
| Adapters | Native endpoint and options; secrets supplied through secret references/environment — not hard-coded values |

---

## 20. Authorization model

Use deny-by-default policies. Decisions may consider:

- Authenticated caller identity
- Target service
- Operation/procedure
- Topic/subject
- Resource or tenant scope
- Data classification
- Transport-specific permissions

Enforce each policy where the required context is available. The Kafka adapter may enforce publishing/consuming policies where supported, but business services must still authorize access to individual resources. Service authentication does not imply permission for every operation.

---

## 21. Reliability, delivery semantics, and idempotency

### 21.1 Guarantees by communication type

| Communication type | Baseline behavior | Important limitation |
|---|---|---|
| RPC over a network | A response may be returned or the call may fail/time out | Timeout leaves the remote execution outcome potentially unknown |
| TCP | Ordered byte stream while a connection operates | No message boundaries or business-level delivery guarantee without an application protocol |
| UDP | Best-effort datagrams | Loss, reordering, and duplicates are possible |
| Kafka | Broker/client-defined persistence, ordering scope, and delivery behavior | Exact behavior depends on producer, consumer, configuration, and processing design |
| NATS Core | Live subject-based messaging and request/reply | No persistence/replay guarantee from Core alone |
| NATS JetStream | Persistence, acknowledgments, redelivery, and replay according to configuration | Redelivery and duplicate processing remain possible |

This table is an overview, not a replacement for adapter-specific operational documentation. Document actual guarantees for the selected client versions and configuration.

### 21.2 Idempotency

For operations that can be retried, the application may provide an idempotency key. The key must be scoped to an authenticated principal/tenant and operation, and its retention period must be documented. A deduplication record should be committed atomically with the business side effect where possible. A cache-only check followed by a separate write has a race condition and does not establish idempotency.

For event consumers, a stable message ID can support deduplication, but the deduplication store and business write must be coordinated. The microservice package can expose metadata and hooks; it must not claim to make arbitrary business handlers exactly-once.

### 21.3 Backpressure and bounded resources

Every adapter must define limits for:

- Maximum message/frame size
- Concurrent in-flight requests
- Queued messages and queued bytes
- Open connections and pending connection attempts
- Handler concurrency
- Retry attempts and retry duration
- Pending writes and stream buffering
- Shutdown drain duration

When a limit is reached, behavior must be explicit: pause reads, reject new work, return a resource-exhausted error, or apply the native adapter’s backpressure mechanism. Do not grow queues without bound. Metrics must reveal queue depth, rejected work, and saturation.

### 21.4 Circuit breaking and load shedding

Circuit breakers and load shedding may be added when there is evidence they are needed. They must be scoped by dependency/operation, have configurable thresholds, expose state changes, and avoid retry storms. They must not be enabled with opaque defaults that surprise callers. Do not add a circuit breaker that conflicts with an existing dependency’s own resilience controls without documenting ownership.

### 21.5 Reliability rules

- Bound timeouts, queues, pools, and concurrent operations.
- Retry only appropriate transient failures.
- Use exponential backoff with jitter where appropriate.
- Do not blindly retry non-idempotent mutations.
- Use idempotency keys or deduplication when needed.
- Preserve cancellation/deadline information where supported.
- Respect native broker acknowledgment and offset semantics.
- Redact secrets and sensitive payloads from remote errors.
- Treat a timeout as an unknown remote outcome if execution may already have occurred.
- Do not expose a universal `exactlyOnce: true` setting.

Document persistence, ordering scope, redelivery, deduplication, and recovery guarantees per operation and adapter.

---

## 22. Common error model and error mapping

A common error model classifies failures without pretending that different transports have identical error semantics.

### 22.1 Suggested categories

| Category | Meaning |
|---|---|
| `CONFIGURATION` | Invalid or incomplete local configuration |
| `DEPENDENCY_UNAVAILABLE` | Required downstream service or broker unavailable |
| `CONNECTION` | Connection setup, reset, or transport failure |
| `TIMEOUT` | Deadline expired; remote outcome may be unknown |
| `CANCELLED` | Caller or application cancelled work |
| `AUTHENTICATION` | Identity could not be verified |
| `AUTHORIZATION` | Verified identity lacks permission |
| `VALIDATION` | Malformed input or contract violation |
| `NOT_FOUND` | Service, route, subject, or resource not found |
| `CONFLICT` | Operation conflicts with current state or idempotency record |
| `RATE_LIMITED` | Request rejected by configured resource policy |
| `RESOURCE_EXHAUSTED` | Message, queue, connection, or memory bound reached |
| `UNAVAILABLE` | Transient service-level failure where retry may be appropriate |
| `INTERNAL` | Unexpected failure with a stable public message and a private cause |

### 22.2 Error contents

Every normalized error should preserve, where applicable:

- Stable category/code
- Safe human-readable message
- Retryability as a recommendation, not a guarantee
- Operation/request/correlation ID
- Native protocol code and sanitized native details
- Original error as a non-serialized cause for local diagnostics
- Retry-after duration when a valid source provides it

Never serialize stack traces, credentials, raw tokens, cryptographic keys, full sensitive payloads, or internal hostnames to untrusted callers. Native gRPC status codes, tRPC error codes, Connect error codes, and Kafka/NATS errors should be mapped losslessly where possible and retain native details for diagnostics.

### 22.3 Retry classification

Retries should be based on the operation’s semantics, the error, the deadline, and the adapter’s guarantees — not merely on whether an error occurred.

- Usually do not retry validation, authentication, authorization, or deterministic contract errors.
- Retry transient connection failures only when the operation can safely be repeated or when the caller can determine the outcome.
- Use bounded exponential backoff with jitter for suitable reconnect/retry loops.
- Honor a global deadline; retries must not extend beyond it.
- Apply retry budgets to avoid amplifying outages.
- Do not create an independent retry loop in the microservice adapter if the underlying package already owns that retry behavior.

---

## 23. Observability and auditing

### 23.1 Structured logs

Use structured fields rather than parsing free-form messages. Recommended common fields:

- Timestamp, severity
- Service name/version, instance ID
- Adapter, protocol, operation, outcome, duration
- Request/message/correlation IDs, trace ID
- Error category, retry attempt
- Topic/subject or method name only when safe

Never log credentials, full authorization headers, private keys, plaintext secrets, or unrestricted payloads. Use Pino or a compatible logger interface.

### 23.2 Metrics

Recommended metric families:

- Operation/request/message totals, with bounded-cardinality labels
- Operation latency histograms
- Failures by normalized error category
- Active connections and in-flight requests
- Queue depth, queue bytes, and rejected work
- Retry attempts and retry exhaustion
- Adapter health and reconnect counts
- Registry lease renewals and discovery failures
- Consumer redelivery/acknowledgment outcomes where the native client exposes them
- Shutdown drain duration and unfinished work

Do not put message IDs, user IDs, arbitrary subjects, raw URLs, or exception messages in metric labels — this creates high cardinality and can leak sensitive data. Use logs/traces for individual operations.

### 23.3 Distributed tracing

Use standard trace context where supported. Create spans around outbound calls, inbound handler execution, publishing, and consuming. Propagate context through RPC metadata, Kafka headers supported by the selected driver, NATS headers, and custom protocols only when the mapping is documented. Avoid creating duplicate spans when an underlying client already instruments the same operation unless the layering is deliberate.

### 23.4 Audit events

Audit security-sensitive events such as identity enrollment/revocation, credential rotation, authorization denial, policy changes, registry integrity failures, and security configuration changes. Audit records should be structured, access-controlled, and retained according to operational policy. Audit logging is not the same as debug logging and must not contain secret material.

---

## 24. Lifecycle, readiness, and graceful shutdown

### 24.1 Lifecycle states

The application should expose a small explicit state model:

```text
created → starting → ready ⇄ degraded → stopping → stopped
                  ↘ failed
```

Legal transitions must be documented and tested. `start()` and `close()` should be idempotent or reject repeated calls predictably; they must not race into duplicate listeners or leaked connections.

### 24.2 Readiness versus liveness

| Probe | Answers | Guidance |
|---|---|---|
| **Liveness** | Is the process alive? | Generally avoid failing merely because a remote optional dependency is unavailable |
| **Readiness** | Can this instance safely receive the work it advertises? | If a required adapter is unavailable, readiness should be false |
| **Adapter health** | Status of one integration | Include a safe, bounded diagnostic result |

A dependency can be degraded without making the whole service unready if the affected capability is optional. Avoid checks that block indefinitely or trigger expensive broker operations at high frequency.

### 24.3 Shutdown sequence

1. Mark the application as stopping and make readiness false.
2. Stop registry renewals and deregister where safe, while ensuring stale leases expire if deregistration fails.
3. Stop accepting new inbound work.
4. Signal cancellation to handlers where supported.
5. Drain in-flight requests/messages up to the configured deadline.
6. Apply adapter-specific acknowledgment behavior to unfinished messages; never acknowledge unfinished work just to complete shutdown quickly.
7. Close listeners, clients, timers, and adapter-owned resources in reverse dependency order.
8. Flush logs/telemetry within a bounded budget.
9. Mark stopped and return a shutdown result that records cleanup failures.

If the drain deadline expires, terminate remaining work according to the documented adapter policy. Shutdown must be bounded and must not wait forever for a broker, registry, or remote service.

---

# Part E — Runtime behavior

## 25. Detailed runtime model and request flows

This section makes the intended runtime behavior explicit. It describes target behavior; it does not claim that these APIs already exist in the codebase.

### 25.1 Startup sequence

The application should start deterministically. Startup must not begin accepting traffic while required dependencies or security policy are invalid.

1. Load environment and explicitly supplied configuration sources.
2. Merge configuration using documented precedence rules.
3. Parse and validate the complete configuration object.
4. Resolve the service identity and verify that required credentials are present and usable.
5. Construct shared services: logger, clock, ID generator, metrics/tracing interfaces, policy provider, and registry store.
6. Construct only the adapters enabled by configuration and installed dependencies.
7. Validate adapter-specific configuration without opening network listeners where possible.
8. Start outbound dependencies and clients required by enabled adapters.
9. Register the service instance in the registry, if registry registration is enabled.
10. Start inbound servers/listeners.
11. Run readiness checks against required dependencies.
12. Mark the application ready only after every required startup condition succeeds.

If a required stage fails, startup must reject with a typed error, close resources already opened, unregister any partially registered instance, and preserve the original failure as the cause. Cleanup errors should be reported without replacing the primary startup error.

Optional adapters may fail without failing the whole application only when the operator explicitly marks them optional. The application must expose a degraded state and a structured reason; it must not silently pretend the adapter is available.

### 25.2 Request/response flow

```text
Caller
  → resolve target / select endpoint
  → create request ID and propagate trace context
  → serialize using the native protocol
  → establish or reuse an authenticated connection
  → send request with deadline and cancellation signal
  → remote transport accepts request
  → authenticate caller
  → authorize service + operation + resource
  → validate input and contract version
  → invoke application handler
  → validate/map output
  → serialize native response
  → caller maps native result/error to public result
  → emit duration/outcome telemetry
```

Each stage must have a defined timeout or resource bound where it can wait, allocate memory, or perform remote work. Authentication and authorization failures must not reach the application handler. Validation errors should identify the invalid field or contract rule without echoing secrets or unsafe payloads.

A timeout does not prove that the remote operation did not execute. The server may have completed the operation while the response was delayed or lost. Mutating operations that may be retried should therefore support application-level idempotency where duplicate execution would be harmful.

### 25.3 Event publishing flow

```text
Producer
  → validate event name, version, and payload
  → assign message ID, timestamp, producer identity, and trace context
  → authorize publish action
  → map metadata to the selected adapter’s native fields
  → publish through the adapter
  → receive native acceptance/acknowledgment semantics
  → record result and telemetry
```

The API must distinguish “accepted by the local client,” “accepted by the broker,” and “processed by a consumer” when the underlying adapter exposes those as different states. A publish acknowledgment is not automatically proof that a downstream business action completed.

### 25.4 Event consumption flow

```text
Broker / transport
  → adapter receives native delivery
  → decode and validate metadata
  → authenticate producer when supported by the transport/security design
  → authorize subscription and event type
  → invoke handler
  → handler succeeds or fails
  → apply native ack/nack/retry behavior
  → record outcome, duration, redelivery count, and relevant metadata
```

Acknowledgment timing must be explicit. If the application acknowledges before its durable side effect commits, a crash can lose work. If it commits the side effect and crashes before acknowledgment, the message may be delivered again. Consumers should be designed for at-least-once behavior unless the complete processing path establishes a stronger guarantee.

### 25.5 Cancellation and deadline propagation

- A caller may provide a deadline or timeout; adapters convert it to native deadline semantics when supported.
- A cancellation signal should propagate to the remote operation only where the protocol supports cancellation.
- A cancelled client request does not guarantee that remote work has stopped.
- Handlers should receive an operation context containing request ID, trace context, deadline, and cancellation state without depending on a particular web framework.
- Cleanup handlers must run on success, failure, timeout, and cancellation.

---

# Part F — Engineering and operations

## 26. Dependency and package boundaries

### 26.1 Core dependencies

| Package | Purpose |
|---|---|
| `zod` | Runtime configuration and application-schema validation |
| `pino` | Structured logging, if the package owns the logger implementation |
| `jose` | Only if JWT/JOSE functionality is implemented |
| Node.js built-ins | Networking, cryptographic primitives, UUID generation where suitable |

### 26.2 RPC dependencies

| Package | Purpose |
|---|---|
| `@trpc/client`, `@trpc/server` | tRPC |
| `@grpc/grpc-js` | gRPC |
| `@grpc/proto-loader` | Dynamic loading only when required |
| `@connectrpc/connect` + compatible Node transport | Connect RPC |

### 26.3 Messaging dependencies

| Package | Purpose | Requirement |
|---|---|---|
| `@oneunit/kafka` | Optional OneUnit-native Kafka integration | Optional / peer |
| `kafkajs` | Optional alternative Kafka client | Optional / peer |
| Official NATS client | NATS integration | As needed for NATS adapter |
| `@oneunit/redis` | Optional OneUnit-native Redis integration | Optional / peer |
| `ioredis` | Optional alternative Redis client with Sentinel/Cluster support | Optional / peer |
| `redis` (node-redis) | Optional official Node.js Redis client | Optional / peer |

Keep both Kafka clients optional at the core-package level. Users must be able to choose KafkaJS even when `@oneunit/kafka` is installed, and choose `@oneunit/kafka` when it is installed and supported. Optional `auto` mode may help select an available driver, but explicit selection takes precedence. Do not silently switch drivers after initialization or connection errors. The core must remain importable without either Kafka client when the Kafka adapter is not used.

Similarly, keep all Redis clients optional. Users must be able to choose ioredis or node-redis even when `@oneunit/redis` is installed. Optional `auto` mode may help select an available driver, but explicit selection takes precedence. Do not silently switch drivers after initialization or connection errors. The core must remain importable without any Redis client when the Redis registry backend is not used.

### 26.4 Development dependencies

Use the workspace’s existing TypeScript, Vitest, `tsx`, ESLint, and Node type packages. Keep development-only log formatting such as `pino-pretty` out of production dependencies unless runtime use is explicitly required.

Before publishing, verify version compatibility, peer dependency ranges, ESM exports, declaration generation, and the npm tarball contents.

---

## 27. Testing strategy

### 27.1 Unit tests

- Configuration parsing and invalid configuration rejection
- Envelope validation and serialization
- Registry registration, renewal, and expiration
- Authorization policies
- TCP framing and partial reads
- UDP packet validation
- Error mapping and lifecycle behavior
- Cryptographic primitive correctness
- Kafka adapter mapping using a fake or test double for the actual `@oneunit/kafka` public API

### 27.2 Adapter tests

- Native client/server interoperability
- Authentication and authorization
- Cancellation, deadlines, and timeouts
- Error mapping
- Lifecycle and graceful shutdown
- Contract compatibility

### 27.3 Security tests

- Invalid signatures
- Modified ciphertext and authentication tags
- Replay attempts
- Nonce uniqueness and key rotation
- Unauthorized identities and expired credentials
- Oversized or malformed messages
- Rate limits and resource exhaustion

### 27.4 Integration tests

- Existing Kafka broker accessed through the selected driver (`@oneunit/kafka` or KafkaJS)
- NATS Core and JetStream where supported
- Redis registry
- TCP and UDP endpoints
- tRPC, gRPC, and Connect RPC interoperability
- Broker/network disconnection, recovery, and shutdown with in-flight work

Kafka integration tests must exercise the existing broker using the real public API of each supported driver. They must not depend on a broker implementation embedded in `@oneunit/microservice`.

### 27.5 Packaging tests

- ESM imports and type declaration resolution
- Public export verification
- Optional dependency behavior
- Clean installation from the generated package
- Runnable examples and `npm pack` inspection

Use mocks for unit tests and real infrastructure for critical integration behavior.

---

## 28. Performance and capacity engineering

Performance requirements must be measured against representative workloads rather than inferred from protocol reputation. Benchmark startup time, request latency percentiles, throughput, memory per connection, serialization cost, queueing behavior, and shutdown duration.

- Establish a baseline for each adapter and payload size.
- Measure p50, p95, and p99 latency rather than averages alone.
- Test sustained load and burst load separately.
- Test slow consumers, blocked handlers, broker outages, and network partitions.
- Measure memory while queues are saturated and verify configured bounds.
- Include tracing/logging overhead in production-like tests.
- Record runtime version, hardware, configuration, payload distribution, and dependency versions with benchmark results.
- Do not set aggressive concurrency defaults without load tests.
- Do not add pooling or custom serialization until profiling demonstrates a need.

Resource limits should be configurable but safe by default. If the application cannot accept more work, it should reject or defer it predictably rather than allow memory pressure to become a process-wide outage.

---

## 29. Deployment and operational guidance

### 29.1 Network boundaries

Prefer private network paths for internal service traffic. Expose only the ports required by enabled adapters. Bind to an explicit interface and document whether a listener is intended for loopback, a private interface, or a public interface. Do not assume that a private network removes the need for authentication or authorization.

### 29.2 Secrets and configuration

Inject secrets through the deployment’s secret-management mechanism. Avoid writing secrets to generated config files or logging full configuration objects. Document certificate trust roots, rotation, expiry alerts, and behavior when credentials become invalid. Ensure examples use placeholders and cannot accidentally connect to production resources.

### 29.3 Health and orchestration

Expose readiness and liveness through the host application’s health integration or a dedicated optional framework adapter. The framework-agnostic core should not bind a specific HTTP health port by default. Coordinate the library’s shutdown deadline with the process supervisor/container termination grace period.

### 29.4 Failure runbooks

Document operator actions for at least these scenarios:

| Scenario | Guidance |
|---|---|
| Required broker unavailable at startup | Fail fast with actionable error; do not partially start |
| Broker disconnects after startup | Enter degraded state if optional; otherwise affect readiness; document reconnect policy |
| Registry unavailable or leases stop renewing | Stale entries expire; readiness reflects required registry health |
| TLS certificate expires or trust configuration changes | Detect via health/metrics; rotate credentials; alert |
| Repeated authorization failures | Indicate policy or credential problems; investigate without exposing policy details publicly |
| Queue saturation or consumer lag grows | Apply backpressure; scale consumers; inspect handler latency |
| Graceful shutdown exceeds its deadline | Terminate remaining work per adapter policy; record unfinished work |
| Adapter enters degraded state | Surface structured reason; continue serving unaffected capabilities |
| Contract version mismatch causes repeated failures | Reject with validation errors; coordinate schema rollout |

Runbooks should identify diagnostic signals, safe remediation, expected recovery behavior, and actions that must not be taken (for example, resetting offsets or deleting durable state without understanding the consequences).

---

## 30. Dependency, build, and package distribution policy

### 30.1 Dependency ownership

The core should depend only on small, necessary abstractions and utilities. Heavy protocol clients should be optional, peer dependencies, or separately published adapter packages if that gives consumers a cleaner installation and avoids incompatible dependency trees. Make this decision based on actual workspace and npm distribution constraints rather than assuming one pattern fits every integration.

`@oneunit/kafka` remains the preferred and authoritative OneUnit-native integration, but KafkaJS is a supported alternate driver for standalone environments or explicit selection. Do not use KafkaJS as a hidden parallel client when `@oneunit/kafka` is available and selected. Any peer/optional dependency strategy and auto-selection behavior must be tested in a clean consumer install.

### 30.2 ESM and TypeScript

- Declare the package module format explicitly.
- Build JavaScript and declaration files from the supported source configuration.
- Define `exports`, `types`, and any subpath exports consistently.
- Ensure relative ESM imports resolve in built output according to the selected TypeScript/module strategy.
- Do not publish TypeScript source paths as accidental API.
- Test both JavaScript runtime imports and TypeScript type resolution from outside the workspace.
- Keep `files`/ignore configuration from omitting runtime files or including secrets, fixtures, and local artifacts.

### 30.3 Release gates

A release candidate should pass: clean install, lint, formatting check, typecheck, unit tests, integration tests required for the release, build, examples, package export tests, and tarball inspection. Test the packed artifact, not only workspace symlinks. Review peer dependency warnings and optional dependency behavior. Never publish as a side effect of a generic test or build command.

---

## 31. Documentation requirements

Documentation must distinguish four statuses:

| Status | Meaning |
|---|---|
| **Implemented** | Code and tests exist and the feature is supported |
| **Experimental** | Usable but API or behavior may change |
| **Planned** | Architecture intends to support it, but implementation is not complete |
| **Unsupported** | Deliberately excluded or not available in the current release |

Each adapter document should include: installation, minimal example, configuration, authentication, supported capabilities, limitations, delivery semantics, error behavior, observability, shutdown behavior, compatibility matrix, troubleshooting, and links to the relevant native protocol documentation.

Do not document a conceptual code snippet as a guaranteed API. Once an API is implemented, examples must be compiled or executed in CI so documentation cannot silently drift from code.

---

## 32. Expanded verification matrix

| Area | Positive cases | Negative/failure cases | Required evidence |
|---|---|---|---|
| Configuration | Defaults and valid overrides | Missing secrets, invalid ports, conflicting timeouts, unknown keys | Unit tests and documented schema |
| Lifecycle | Start, ready, close | Partial startup failure, repeated close, close during start | Unit and integration tests |
| RPC | Native unary/streaming calls | Timeout, cancellation, invalid contract, denied caller | Interoperability tests |
| TCP | Complete and multiple frames | Partial header, oversized frame, peer reset, slow reader | Parser fuzz/edge tests and integration tests |
| UDP | Valid datagram | Oversized, malformed, replayed, rate-limited packet | Security and resource-limit tests |
| Kafka adapter | Publish/consume through existing package | Dependency absent, broker outage, native error, shutdown with pending work | Tests using actual public APIs of both drivers and existing broker infrastructure |
| NATS Core | Pub/sub and request/reply | Disconnect, timeout, invalid subject, reconnect | Integration tests |
| JetStream | Durable delivery and acknowledgment | Redelivery, ack timeout, consumer restart, retention boundary | Integration tests with documented native settings |
| Redis registry | Register, renew, discover, deregister with each driver | Driver absent, Redis outage, stale instance, duplicate instance ID, Sentinel/Cluster failover | Unit and multi-instance tests with each driver |
| Security | Valid credential and policy | Expired/revoked credential, spoofed identity, unauthorized operation, replay | Negative security tests |
| Observability | Correlated logs and traces | Secret-bearing error/payload, high-cardinality fields | Redaction and instrumentation tests |
| Packaging | Import core and each enabled adapter | Missing optional dependency, invalid exports, broken declarations | Clean install and packed-artifact tests |

---

# Part G — Governance and delivery

## 33. Decisions required before implementation

The architecture defines boundaries, but these choices must be settled in ADRs or implementation plans before their code is treated as stable:

1. Whether adapters ship in one package as optional subpaths or in separate packages.
2. The exact public API and lifecycle shape after reviewing workspace conventions.
3. Whether the registry is required for the first release or remains optional.
4. Whether Redis is already provided by a shared OneUnit package and should be reused rather than wrapped again.
5. The concrete credential source and service identity provisioning process.
6. Whether authorization is policy-based, callback-based, or integrated with an existing OneUnit identity package.
7. Which RPC adapters are included in the initial release and how they integrate with host servers.
8. The chosen serialization for custom TCP/UDP protocols, if those adapters are justified for release one.
9. Whether application-level payload encryption is genuinely required in addition to TLS/mTLS.
10. The actual public APIs, lifecycle contracts, and behavioral differences of `@oneunit/kafka` and KafkaJS.
11. The NATS client version and whether JetStream is part of the initial release.
12. The supported Node.js version range and package export strategy.
13. The expected throughput, payload sizes, latency targets, and resource budgets.
14. Which integration services are available in CI and how tests are isolated.

Do not resolve these questions by inventing APIs or adding infrastructure preemptively. Record the decision, rationale, alternatives, consequences, and migration cost.

---

## 34. Architecture decision records

Record and maintain these decisions:

| ADR | Topic |
|---|---|
| ADR-001 | Communication boundaries: shared API versus native adapter APIs |
| ADR-002 | RPC contracts: definition and versioning across tRPC, gRPC, and Connect RPC |
| ADR-003 | Kafka driver selection: `@oneunit/kafka` and KafkaJS are optional, explicitly selectable drivers; the broker remains external; selected drivers must not be silently substituted |
| ADR-004 | NATS semantics: Core NATS versus JetStream behavior |
| ADR-005 | Cryptographic protocol: key exchange, authentication, nonce handling, and rotation |
| ADR-006 | Registry: lease ownership, storage backend, and instance selection |
| ADR-007 | Reliability: retries, idempotency, timeouts, backpressure, and delivery guarantees |
| ADR-008 | Distribution: mandatory, optional, and separately distributed adapters |
| ADR-009 | End-to-end encryption: threat model, metadata visibility, and key distribution |
| ADR-010 | Observability: trace propagation, metric conventions, and audit requirements |

---

## 35. Required architecture review checklist

Before merging a significant change, reviewers should confirm:

**General**

- [ ] The change respects the package’s stated scope and non-goals.
- [ ] Core code does not import optional adapter dependencies accidentally.
- [ ] Native protocol semantics are preserved and limitations are documented.
- [ ] No framework-specific assumptions have leaked into the core.
- [ ] Resource usage is bounded and overload behavior is explicit.
- [ ] Timeouts, cancellation, retry, and shutdown behavior are defined.
- [ ] Authentication and authorization are separate and fail closed.
- [ ] Secrets and sensitive payloads are not exposed through logs/errors/examples.
- [ ] Public API changes and schema changes have compatibility notes.
- [ ] Tests cover failure paths as well as the happy path.
- [ ] Examples are runnable and reflect the actual exported API.
- [ ] The package builds and works from its packed artifact.
- [ ] No hidden broker/client subsystem duplicates another package’s ownership.

**Mandatory Kafka review**

- [ ] The external Kafka broker/cluster remains outside `@oneunit/microservice`.
- [ ] Both Kafka drivers are optional; explicit selection of either driver is honored even if the other is installed.
- [ ] Explicit driver selection either works as requested or fails clearly; initialization failures never trigger silent driver switching.
- [ ] Both adapters use the actual public APIs of their respective clients.
- [ ] Neither broker/server is created, embedded, launched, or managed here.
- [ ] Client internals and operational systems are not duplicated across the selected driver and this package.
- [ ] Driver-specific differences in retries, offsets, acknowledgments, transactions, headers, and lifecycle are documented and tested.

**Mandatory Redis registry review**

- [ ] The external Redis server/cluster remains outside `@oneunit/microservice`.
- [ ] All Redis drivers are optional; explicit selection of any driver is honored even if others are installed.
- [ ] Explicit driver selection either works as requested or fails clearly; initialization failures never trigger silent driver switching.
- [ ] All adapters use the actual public APIs of their respective clients.
- [ ] Neither Redis server/cluster is created, embedded, launched, or managed here.
- [ ] Client internals and operational systems (connection pools, retry logic, Sentinel/Cluster handling) are not duplicated across the selected driver and this package.
- [ ] Driver-specific differences in connection handling, Sentinel/Cluster support, retry behavior, and lifecycle are documented and tested.

---

## 36. Implementation phases

### Phase 1 — Foundation

- [ ] Finalize public API and architecture decision records.
- [ ] Implement shared configuration and validation.
- [ ] Define contracts, common errors, and capability interfaces.
- [ ] Implement application lifecycle and shutdown.
- [ ] Configure logging and initial tests.

### Phase 2 — Identity and security

- [ ] Define service identity and credential provisioning.
- [ ] Implement authentication and authorization interfaces.
- [ ] Integrate transport security.
- [ ] Implement required cryptographic primitives using reviewed libraries.
- [ ] Add replay protection and key lifecycle management.
- [ ] Review the security design before enabling end-to-end encryption.

### Phase 3 — Service registry

- [ ] Implement the in-memory registry.
- [ ] Add leases and expiration.
- [ ] Implement health checks and discovery.
- [ ] Integrate authorization policy checks.
- [ ] Implement the Redis backend.

### Phase 4 — RPC adapters

- [ ] Implement tRPC integration.
- [ ] Implement gRPC integration.
- [ ] Implement Connect RPC integration.
- [ ] Standardize authentication, deadlines, observability, and error mapping.
- [ ] Add interoperability and contract tests.

### Phase 5 — Messaging integrations

- [ ] Inspect the actual public APIs of `@oneunit/kafka` and KafkaJS; test explicit selection of both optional drivers and any documented auto mode.
- [ ] Implement separate thin adapters over the actual public APIs of the selected client; keep both integrations optional.
- [ ] Confirm no Kafka broker/server or duplicate producer/consumer system is created here.
- [ ] Add event metadata mapping, schema versions, and idempotency hooks.
- [ ] Implement NATS Core integration.
- [ ] Implement JetStream as a distinct mode.
- [ ] Add real-infrastructure integration tests.

### Phase 6 — Network adapters

- [ ] Implement TCP framing, limits, backpressure, TLS, and lifecycle.
- [ ] Implement UDP packet validation, size limits, and rate limiting.
- [ ] Add relevant security tests.
- [ ] Defer custom UDP reliability unless justified by a documented requirement.

### Phase 7 — Production hardening

- [ ] Add metrics and distributed tracing.
- [ ] Implement audit logging.
- [ ] Test failure recovery and graceful shutdown.
- [ ] Review dependency boundaries and optional installation.
- [ ] Perform security and reliability reviews.
- [ ] Validate resource limits and backpressure under load.

### Phase 8 — Release

- [ ] Finalize ESM exports and declarations.
- [ ] Document actual adapter capabilities and limitations.
- [ ] Add runnable examples.
- [ ] Document security assumptions and operational requirements.
- [ ] Verify clean installation, tests, type checks, lint, build, and `npm pack`.
- [ ] Publish only after explicit authorization and required release checks.

---

## 37. Definition of done

- [ ] The core works without requiring every adapter.
- [ ] Enabled adapters can start and stop independently.
- [ ] RPC adapters preserve their native contracts.
- [ ] Kafka integration supports `@oneunit/kafka` and KafkaJS as optional, explicitly selectable alternatives.
- [ ] No Kafka broker/server is implemented; both drivers are separate, optional, tested client integrations.
- [ ] NATS Core and JetStream behavior are documented separately.
- [ ] TCP framing and UDP limits are enforced.
- [ ] Authentication and authorization are tested.
- [ ] Cryptographic behavior has dedicated security tests where implemented.
- [ ] Registry leases and stale-instance handling work correctly.
- [ ] Errors, logs, tracing, and metrics are consistent where applicable.
- [ ] Delivery guarantees are documented accurately.
- [ ] Public exports, declarations, and optional dependencies are verified.
- [ ] Examples work from a clean installation.
- [ ] Documentation accurately distinguishes implemented features from planned features.

---

## Final design principle

`@oneunit/microservice` is the shared communication API and integration layer for OneUnit services. The core owns lifecycle, common contracts, identity, authorization, configuration, observability, and integration conventions. Adapters preserve native protocol behavior.

**Kafka is an integration, not infrastructure owned by this package.** The Kafka broker/cluster remains external. `@oneunit/kafka` and KafkaJS are both optional driver choices. `@oneunit/kafka` is convenient in the existing OneUnit environment, but it is not mandatory; users may choose KafkaJS instead, including when the OneUnit package is installed. The package exposes one stable messaging API over separate adapters, preserves native client differences, and never silently changes drivers after a configuration or connection failure.

This boundary prevents duplicated infrastructure, reduces operational complexity, preserves native semantics, and lets OneUnit services add communication capabilities without rebuilding systems that already exist.