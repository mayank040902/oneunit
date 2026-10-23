# Architecture: `@oneunit/microservice`

  ** Document scope:** Current implementation\
** Package version:** 1.0.0(confirm against`package.json` before
release) \
** Runtime:** Node.js 20 or newer\
** Module format:** ESM\
** Status:** Implementation documented; production readiness has not been
independently verified.

This document describes the package's current structure, public
interfaces, configuration, adapters, and known limitations.It is
intended to help maintainers understand how the implementation works.A
feature being present in the source or covered by unit tests does not,
  by itself, establish production readiness.

## 1. Overview

`@oneunit/microservice` provides reusable building blocks for
communication between services.It includes application composition and
lifecycle management, transport contracts, RPC and messaging adapters,
  service discovery, identity and authorization utilities, cryptographic
primitives, and basic observability tools.

The package connects applications to external systems.It is not itself
a Kafka, NATS, or Redis server, and it does not provide one universal
protocol or message format for every adapter.

The main capabilities are:

-   `createMicroservice()` for composing an application.
- Transport interfaces and adapters for tRPC, gRPC, Connect RPC, TCP,
  UDP, Kafka, and NATS.
- In - memory and Redis - backed service registries with leases and
discovery.
- Identity, authentication, and authorization utilities.
- Encryption, signing, key exchange, key storage, rotation, and
replay - protection utilities.
- Logger, metrics, tracing, and audit interfaces or in -memory
implementations.
- A common error model and shutdown utilities.

The package uses an adapter - based design.Core contracts define the
expected behavior; adapters connect those contracts to protocol
libraries or external infrastructure.

## 2. Runtime and build

The package is an ESM - only TypeScript library targeting Node.js 20 or
newer.

  Area                       Implementation
-------------------------- -------------------------------------------------------
  Language                   TypeScript
  Runtime module format      ESM
  Configuration validation   Zod
Build                      `tsc` followed by`tsc-alias`
  Tests                      Vitest
  Coverage                   Vitest coverage with V8
  Cryptography               Node.js Web Crypto API and `node:crypto` where needed

The source uses TypeScript path aliases.The build rewrites those
aliases in the generated `dist/` output so published JavaScript uses
resolvable relative imports.

The package's declared entry points are controlled by the `exports` map
  in `package.json`.The documented export surface is:

--------------------------------------------------------------------------------------
  Import path                                        Purpose
-------------------------------------------------- -----------------------------------
  `@oneunit/microservice`                            Main API, core modules, contracts,
    and RPC / network adapters

  `@oneunit/microservice/adapters/logging/pino`      Pino logger adapter

  `@oneunit/microservice/adapters/logging/oneunit`   `@oneunit/logger` adapter

  `@oneunit/microservice/adapters/messaging/kafka`   Kafka adapter

  `@oneunit/microservice/adapters/messaging/nats`    NATS adapter

  `@oneunit/microservice/registry/redis`             Redis registry integration
--------------------------------------------------------------------------------------

  Check`package.json` before relying on this list for a release.Internal
source barrels are not automatically public package entry points.

## 3. Source layout

The main source directories are organized by responsibility:

``` text
src/
├── index.ts
├── core/
│   ├── application.ts
│   ├── lifecycle.ts
│   ├── capabilities.ts
│   ├── errors.ts
│   ├── client.ts
│   └── server.ts
├── config/
├── contracts/
├── identity/
├── security/
├── crypto/
├── registry/
│   └── redis/
├── transport/
├── adapters/
│   ├── rpc/
│   ├── network/
│   ├── messaging/
│   └── logging/
├── observability/
└── internal/
```

  - `core/` contains application composition, lifecycle management,
    transport contracts, client / server abstractions, and errors.
- `config/` defines configuration schemas and loads configuration.
- `contracts/` contains message, event, procedure, registry, and
    versioning types.
- `identity/` contains service identity, credential stores,
  authenticators, and authorization policies.
- `security/` contains encryption, key exchange, signing, key
management, rotation, and replay protection.
- `crypto/` contains interface - only abstractions; it does not provide
    a separate implementation.
- `registry/` contains registry services, lease handling, discovery,
  health checks, and Redis storage adapters.
- `transport/` contains the base transport and transport manager.
- `adapters/` contains protocol and logging integrations.
- `observability/` contains logging contracts and metrics, tracing,
  and audit utilities.
- `internal/` contains ID - generation and shutdown helpers.

Core code defines contracts used by adapters.Concrete external clients
are loaded at adapter boundaries where supported.Avoid treating
internal modules as public APIs unless they are explicitly exported by
the package.

## 4. Application composition

### `createMicroservice()`

The public composition function is:

  ``` ts
createMicroservice(options?: CreateAppOptions): Promise<MicroserviceApp>
```

The documented options are:

``` ts
{
  configPath?: string;
  config?: DeepPartial<MicroserviceConfig>;
  logger?: Logger;
}
```

The composition root loads and validates configuration, creates the
service identity and registry, builds the authorization policy and
lifecycle manager, configures the logger, and initializes Kafka
messaging when it is enabled.

Configuration overrides are merged with the loaded configuration.The
intended precedence is schema defaults, environment - derived
configuration, configuration file, then explicit programmatic overrides.
Plain objects are merged recursively; arrays, scalar values, and the
credentials object are replaced rather than combined.The resulting
configuration is validated again and returned frozen.

Invalid final configuration should fail during composition, before
runtime resources are created.

### Application object

The application exposes the service configuration and the main runtime
components, including:

-   `service`
  - `config`
  - `registry`
  - `identity`
  - `authorization`
  - `lifecycle`
  - `logger`
  - `kafka`, when configured and initialized
    - `start()` and`stop()`
      - `getTransport()`, `registerTransport()`, and`unregisterTransport()`

Kafka initialization failure is currently logged as a warning and does
not necessarily prevent the application from being constructed.
Applications that require Kafka for correct operation should explicitly
verify that messaging initialized successfully before accepting work.

### Startup and shutdown

Application startup registers the service in the registry, installs
lifecycle hooks, and starts the lifecycle manager and registered
transports.

The lifecycle manager starts transports in registration order.Shutdown
closes transports in reverse registration order, then runs the
configured stop hook.Stop and close failures are collected and reported
rather than intentionally ignored.

A startup failure must be treated as a failed startup, not as evidence
that the service is ready.Callers should ensure partially started
resources are stopped when startup fails.

## 5. Lifecycle and transports

### Lifecycle states

The lifecycle manager uses these states:

`initialized` → `starting` → `running` → `stopping` → `stopped`

A startup failure can move the manager to`failed`.Health checks can
move a running application into `degraded` when a transport reports
  `unhealthy`, and back to `running` after recovery.

The manager emits state and lifecycle events, including`stateChange`,
  `started`, `stopped`, `transportStarted`, `transportStartError`,
  `transportStopped`, `transportStopError`, `healthCheck`,
  `healthCheckError`, and`degraded`.

The health - check loop runs periodically, using the configured interval
or a default of 30 seconds.Individual transport health - check failures
are represented as unhealthy results.

### Transport contracts

The base `Transport` contract includes a name, declared capabilities,
  `start()`, `close()`, and`healthCheck()`.

Capabilities describe supported behavior, such as request / response,
  streaming, publish / subscribe, durable delivery, ordered delivery, and
bidirectional communication.A capability declaration should not be
treated as proof that every operation is available: the client also
checks that the selected transport implements the interface it needs.

`BaseTransport` provides shared state for adapters. `TransportManager`
handles registration, lookup, capability filtering, startup and
shutdown, health checks, and transport metrics.

The transport manager's `send()` routes through a transport that
implements the point - to - point contract. `broadcast()` publishes to the
named channel on eligible transports that implement`MessagePublisher`.
These methods are not a universal service - discovery router; applications
remain responsible for choosing an appropriate protocol and destination.

### Client and server abstractions

`MicroserviceClient` implements RPC client and messaging interfaces.It
chooses a transport based on declared capability and verifies the
required methods at runtime before calling it.Selection is based on
registered transport order; it does not currently provide a complete
policy - based routing decision using target service, endpoint, and
authorization context.

`RetryPolicy` supports bounded retries for request / response calls, with
exponential backoff capped by `maxDelayMs` and optional jitter.Only
configured retryable `MicroserviceError` categories are retried.Use
retries only for operations that are safe to repeat.A remote operation
may execute more than once if the response is lost.

Messaging publish operations are not automatically retried.

`MicroserviceServer` is a local method - handler registry.It does not
create a network listener by itself.Network server behavior belongs to
the relevant adapter.

## 6. Configuration

Configuration is defined and validated with Zod schemas.The main
sections are:

-   `service`
  - `security`
  - `registry`
  - `auth`
  - `observability`
  - `crypto`
  - `adapters`

Adapter - specific settings include Kafka, NATS, TCP, UDP, tRPC, gRPC, and
Connect RPC options.

The loader checks an explicitly supplied configuration path, then
  `CONFIG_PATH`, then`config.json` in the working directory.If the
selected file does not exist, configuration can be built from
environment variables.Invalid JSON or other file errors are not
equivalent to a missing file and should be surfaced.

Environment variables use section prefixes such as `SERVICE_*`,
  `SECURITY_*`, `REGISTRY_*`, `REDIS_*`, `AUTH_*`, `OBSERVABILITY_*`,
  `CRYPTO_*`, `KAFKA_*`, `NATS_*`, `TCP_*`, `UDP_*`, `TRPC_*`, `GRPC_*`,
  and`CONNECT_*`.

Important defaults documented in the schema include:

  Setting                        Default
------------------------------ -----------
  Registry backend`memory`
  Registry lease TTL             30,000 ms
  Registry heartbeat interval    10,000 ms
Health - check interval          30,000 ms
  Authorization default policy`deny`
  Security authentication flag`true`
  Kafka adapter                  Disabled
  TCP port`8080`
  UDP port`8081`
  TCP maximum frame size         16 MiB

Treat the schema in source as authoritative if this summary and the
implementation differ.Configuration values do not automatically imply
that every related security control is enforced by every adapter.

## 7. Contracts and errors

### Messages and events

`MessageEnvelope<TPayload>` contains a message ID, message type, schema
version, source identity, timestamp, payload, and optional destination,
  correlation ID, and trace context.Factory and validation helpers are
provided.

`Event<TPayload>` describes an event with its ID, type, schema version,
  source, timestamp, payload, and optional correlation and trace
information.The package also defines common system event names.

`ProcedureContract` describes a procedure and its Zod input and output
schemas.Helpers validate procedure inputs and outputs.

The registry contracts define service registrations, service instances,
  health information, and discovery queries.Contract - version helpers
parse and format semantic version triples and check compatibility.

### Encrypted envelopes

`EncryptionService` provides `encryptEnvelope()` and`decryptEnvelope()`
for the package's encrypted envelope format. The payload is encrypted,
and canonical envelope metadata is authenticated as associated data.

The envelope's optional `signature` field is reserved and is not
populated by the current implementation.The `keyId` field is not yet
integrated with `KeyProvider` and `KeyRotationManager` version tracking.
Do not assume that an envelope signature is present or that its key
identifier automatically selects a historical key version.

### Error model

`MicroserviceError` provides a normalized error shape with a code,
  category, retryability flag, and optional details such as native code,
    operation ID, correlation ID, and retry delay.

The categories cover authentication, authorization, validation, missing
resources, deadlines, timeouts, availability, resource exhaustion,
  conflicts, rate limits, cancellation, internal errors, configuration,
    dependencies, connections, transports, and protocols.

Helpers create and classify errors and map native errors into the common
format.Native error details are sanitized; stack traces should not be
serialized as public error details.

## 8. Identity, authentication, and authorization

### Service identity and credentials

`ServiceIdentity` represents a service and instance and provides
registration, signing, and verification operations.The identity factory
preserves configured credential fields and validates required material
for supported credential types.

The memory and file credential stores implement the credential - store
contract.File operations load filesystem functionality lazily.
Credential rotation updates issue and expiry timestamps based on the
credential's validity window.

Identity signing and verification use RSA PKCS#1 v1.5 with SHA - 256. PEM
key material is decoded before import ; legacy DER - formatted material is
also supported by the documented implementation.

### Authenticators

The package provides:

-   `X509Authenticator` for X.509 credentials and certificate checks.
- `JwtAuthenticator` using `jose` to verify JWTs, including configured
    issuer and audience.
- `ApiKeyAuthenticator` backed by an in -memory API - key map.

  Certificate - chain verification depends on the configured trusted CA
material.PR-004 adds optional dispatch integration, but authentication
still runs only where an authenticator is configured for the supported
entry point.

### Authorization policies

The available policies include:

-   `AllowlistPolicy`, which checks service and operation entries and
    optional target / resource restrictions.
- `RbacPolicy`, which evaluates roles and permissions.
- `CompositePolicy`, which applies policies in sequence and denies
    when a policy denies.
- `createAuthorizationPolicy()`, which constructs a policy from
configuration.

The default authorization policy is deny.Supported server boundaries
can invoke the shared secured dispatcher when security dependencies are
configured. Do not assume that a standalone policy object automatically
protects alternate or raw transport paths.

## 9. Cryptography and security utilities

The package includes cryptographic primitives, but it does not provide a
complete authenticated secure - channel protocol.

### Encryption

`EncryptionService` supports AES - 256 - GCM and ChaCha20 - Poly1305.Both use
32 - byte keys, 12 - byte nonces, and 16 - byte authentication tags.AES - GCM
uses Web Crypto; ChaCha20 - Poly1305 uses Node's `node:crypto`
implementation.

Encryption accepts optional associated data.Decryption verifies the
authentication tag and fails when authentication does not succeed.

  The `deriveKey()` helper uses PBKDF2 - SHA - 256. HKDF - SHA - 256 is
implemented separately for session - key derivation.The Web Crypto
implementation has a payload - size limitation noted in the project's
security documentation; applications should not assume that one
encryption call can handle arbitrarily large payloads.

### Key exchange and signing

`KeyExchangeService` can generate X25519 and Ed25519 key pairs, compute
an X25519 shared secret, and derive separate session keys with
HKDF - SHA - 256. A non - extractable session - key variant is available.

** X25519 key agreement alone does not authenticate the peer.** A
man -in -the - middle can substitute public keys unless the exchange is
bound to verified identities by an authenticated protocol or a correctly
configured TLS / mTLS connection.Do not use the raw key - agreement helper
by itself as a secure - channel protocol.

The package also provides Ed25519 signing and RSA signing utilities.

### Key providers and rotation

`KeyProvider` defines operations for retrieving, storing, rotating,
  revoking, and versioning keys. `MemoryKeyProvider` stores keys in memory
with a TTL. `CompositeKeyProvider` combines providers.
`KeyRotationManager` schedules rotations and emits rotation events.

Retention settings such as grace periods and maximum key versions are
enforced by the provider only where that provider implements the
relevant retention behavior.Do not assume every provider preserves old
versions or enforces a grace period.

### Replay protection

`ReplayProtection` rejects duplicate message identifiers and timestamps
outside its allowed time window.It supports cleanup and bounded
storage, with a per - source window and a global capacity limit.Its state
is in memory; it is not a distributed replay cache shared across
processes.

## 10. Service registry and discovery

The registry API supports registration, lease renewal, discovery,
  deregistration, instance lookup, and health updates.

### In - memory registry

The in -memory store keeps service instances in a map and schedules
expiry timers for leases.It filters discovery results by supported
query fields and removes expired records.

### Redis registry

The Redis backend supports`@oneunit/redis`, ioredis, and node - redis
drivers.Driver selection can be explicit or automatic.Explicit
selection should fail clearly if the chosen driver is unavailable;
automatic selection tries the documented candidates.

The Redis store connects lazily when used through the registry factory.
The Redis driver implementations use lease keys with a configurable
prefix, TTLs, and atomic Lua - script renewal.Health updates modify the
canonical service record.

Discovery and health - update operations use cursor - based`SCAN` rather
than Redis`KEYS`.Queries still filter matching records client - side, so
performance depends on the size of the keyspace and the query pattern.
For large deployments, validate the registry's performance against
realistic data volumes.

### Discovery cache and health checks

`ServiceDiscovery` caches query results for a configurable period and
evicts entries using FIFO behavior when its cache reaches capacity.
  Cached results are snapshots and can become stale as service endpoints
change.

`DefaultHealthChecker` can use registered checker functions.Without
one, it evaluates registry presence and heartbeat age.A missing
instance is unhealthy; a stale heartbeat is degraded.

## 11. Protocol and messaging adapters

Adapters expose native protocol behavior and should not be assumed to
have identical semantics.

### Kafka

The Kafka integration supports two drivers: `@oneunit/kafka` and
KafkaJS.The driver can be selected explicitly or resolved
automatically.Explicit selection does not silently switch to a
different driver.

The adapter supports publish and subscribe operations.Topics are
prefixed according to configuration.The `@oneunit/kafka` driver exposes
acknowledgment and negative - acknowledgment handling.KafkaJS serializes
published messages as JSON and parses consumed message values as JSON;
its acknowledgment behavior follows KafkaJS semantics, and the common
`autoAck` option is not implemented in the same way as the OneUnit
driver.

The application - level Kafka facade uses the configured driver.Kafka
initialization errors may be logged and swallowed during application
composition, so applications that depend on Kafka should check
initialization rather than assuming that enabling the adapter guarantees
a working connection.

### NATS

The NATS adapter supports core NATS publishing / subscribing and optional
JetStream behavior.It connects with the configured server and
authentication settings.JetStream subscriptions use explicit
acknowledgment unless configured otherwise, and the adapter drains its
connection during shutdown.

The adapter does not implement request / reply and does not advertise
request / response capability.

### TCP

The TCP adapter supports length - prefixed frames: a four - byte big - endian
length followed by the payload.The configured maximum frame size is
checked, and the parser handles partial headers, partial payloads, and
multiple frames in a chunk.

TLS can be configured with certificate and key material.
  Client - certificate verification can be enabled when CA material is
supplied.Connections support a configured connection timeout and idle
timeout.

Explicit write - backpressure handling is not implemented.Callers should
not assume writes are automatically paused and resumed based on the
socket's `drain` event.

### UDP

The UDP adapter sends and receives datagrams and can join a configured
multicast group.It validates packet size before sending and supports
multicast TTL configuration.

UDP does not provide reliable delivery, ordering, or durable message
storage.

### tRPC

The tRPC adapter uses the standalone HTTP server integration and an
application - supplied router.Its client uses an HTTP batch link.The
context factory currently returns an empty object unless the application
supplies additional integration.

The adapter's local method-registration map is not wired into the
supplied tRPC router.Registering a method through that map does not
automatically expose it through the tRPC server.

### gRPC

The gRPC adapter loads service definitions from protocol - buffer files,
  registers configured handlers on a gRPC server, and provides client
calls and streaming.It bridges callback - based gRPC APIs to
promise - based handlers.TLS behavior depends on the supplied
configuration and credentials.

### Connect RPC

The Connect adapter creates a client using an application-supplied
Connect transport and service definitions.It supports calls and
streaming through that client.

The adapter does not host a Connect server.Server hosting must be
configured by the application using the relevant Connect server
integration.Its local method - registration map should not be mistaken
for a hosted server - registration API.

## 12. Logging and observability

### Logging

The package defines a `Logger` interface with trace, debug, info, warn,
error, and fatal levels, child loggers, and supported message / context
call forms.

`FrameworkLogger` is a framework - owned no - op sink with level gating and
bindings. `NoopLogger` is completely silent.Applications can inject
their own logger.

The Pino and OneUnit logging adapters are separate integrations.The
Pino adapter supports secret redaction for configured paths and can use
`pino-pretty` when available.Optional logging packages are loaded by
the relevant adapter rather than required by the core entry point.

Do not assume that the default framework logger writes to stdout or
persists logs; the default implementation is intentionally a no - op sink.

### Metrics

`InMemoryMetricsCollector` records counters, gauges, histograms, and
summaries.Its sample buffers are bounded.The collector is an in -memory
implementation and is not automatically wired into every transport.

### Tracing

The package defines tracing types, a no - op tracer, an in -memory tracer,
  and helpers for extracting and injecting W3C trace context.

The helpers are not automatically connected across all RPC and messaging
adapters.End - to - end trace propagation requires explicit integration by
the application or adapter.

### Audit

`InMemoryAuditLogger` stores audit events in memory with a bounded event
count and supports querying by event attributes.It is not a durable
audit store and should not be treated as a persistent compliance record.

## 13. Internal utilities

The internal ID helpers generate IDs for services, instances, messages,
  correlations, traces, leases, keys, and sessions.

`ShutdownManager` registers shutdown hooks, orders them by priority,
  runs them under a timeout, and emits shutdown events.
`gracefulShutdown()` stops supplied services sequentially within the
configured time budget and aggregates failures.

Applications should register resource cleanup with a clear owner and
ensure timers, event listeners, sockets, and clients are closed when no
longer needed.

## 14. Testing and packaging

The project uses Vitest and V8 coverage.The documented test suite
includes unit tests for core behavior, configuration, identity and
authorization, cryptographic utilities, registry stores, transports,
  adapters, observability, shutdown handling, and packaging.

Adapter tests using mocks or fakes verify the package's behavior against
those test doubles.They do not prove interoperability with a real Redis
server, Kafka cluster, NATS server, or remote RPC service.

Packaging checks cover the ESM entry point, declarations, optional
dependency metadata, and the contents of the packed artifact.Before
release, run the repository's actual scripts and verify the generated
tarball with a clean consumer project.Record real - infrastructure
integration results separately from unit - test results.

## 15. Known limitations

The following limitations are part of the documented implementation and
should be considered when using the package:

  1.  The shared secured dispatcher is integrated into the TCP raw-frame path,
    hosted tRPC HTTP procedures, gRPC, Connect, Kafka, NATS, and
    `MicroserviceServer.handle()`. Control frames and explicitly public
    operations are the only paths that can skip protected application
    dispatch.
2.  Raw X25519 key agreement does not authenticate peers.
3.  The encrypted envelope's optional signature is not populated, and
    `keyId` is not integrated with key - provider version history.
4.  Trace - context helpers are not automatically propagated through every
adapter.
5.  Metrics and audit implementations are in -memory utilities and are
    not automatically wired into all components.
6.  tRPC's registered-method map is not connected to the supplied
router.
7.  Connect RPC provides a client but does not host a server.
8.  The TCP adapter does not implement explicit write - backpressure
handling.
9.  KafkaJS acknowledgment semantics differ from the OneUnit Kafka
driver; `autoAck` is not implemented identically.
10. Retry configuration applies to request / response calls only.Retrying
    a call can execute the remote operation more than once.
11. Redis discovery filters records client - side after scanning keys.
    Validate performance for the expected registry size.
12. Replay - protection state and the default in -memory registry, metrics,
  tracing, audit, credential store, and key provider are process - local
    unless a different backend is explicitly configured.

## 16. Security and readiness statement

The package supplies security - related primitives and policy building
blocks, but those components do not automatically create a secure system
when used independently.In particular, inbound authentication and
authorization, authenticated peer identity, TLS configuration, key
lifecycle integration, and production audit persistence depend on how
the application wires the package into its services.

Unit tests demonstrate behavior under tested conditions.Integration
tests are needed to demonstrate compatibility with real external
systems, and package - consumer tests are needed to verify the published
artifact.

Do not describe the package as unconditionally production - ready unless
the release evidence supports that claim.Keep the security verification
report and test matrix aligned with the current source, configuration,
  declarations, examples, and package exports.
