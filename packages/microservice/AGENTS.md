# AGENT.md — OneUnit Microservice Communication Platform

**Package:** `@oneunit/microservice`  
**Applies to:** Any AI coding agent working on this package  
**Companion document:** `docs/ARCHITECTURE.md`

---

## Table of contents

1. [Purpose](#1-purpose)
2. [Mandatory working rules](#2-mandatory-working-rules)
3. [Initial repository inspection](#3-initial-repository-inspection)
4. [Architectural boundaries](#4-architectural-boundaries)
5. [Transport and protocol rules](#5-transport-and-protocol-rules)
6. [Dependency management](#6-dependency-management)
7. [Security requirements](#7-security-requirements)
8. [Service registry](#8-service-registry)
9. [Error handling and reliability](#9-error-handling-and-reliability)
10. [Observability](#10-observability)
11. [TypeScript and code quality](#11-typescript-and-code-quality)
12. [Testing requirements](#12-testing-requirements)
13. [Required verification workflow](#13-required-verification-workflow)
14. [Public API and compatibility](#14-public-api-and-compatibility)
15. [Documentation requirements](#15-documentation-requirements)
16. [Implementation workflow](#16-implementation-workflow)
17. [Feature completion checklist](#17-feature-completion-checklist)
18. [Release and publishing restrictions](#18-release-and-publishing-restrictions)
19. [Conflict resolution and final rule](#19-conflict-resolution-and-final-rule)

---

## 1. Purpose

This document defines the **mandatory instructions** for any AI coding agent working on `@oneunit/microservice`.

The agent must:

- Follow the architecture in `docs/ARCHITECTURE.md`
- Preserve existing behavior unless a change is explicitly required and justified
- Understand package and ownership boundaries
- Implement changes incrementally
- Verify work with evidence before reporting completion

### 1.1 What this package is

`@oneunit/microservice` is a secure, extensible communication layer for distributed services in the OneUnit ecosystem. It provides a consistent application API and shared infrastructure for configuration, identity, authorization, lifecycle, observability, and protocol integration.

**Supported integrations:**

| Category | Technologies |
|---|---|
| RPC | tRPC, gRPC, Connect RPC |
| Direct networking | TCP, UDP (only when an application has a concrete raw-network need) |
| Messaging | Kafka via optional selectable drivers (`@oneunit/kafka` or KafkaJS); NATS Core and JetStream |
| Discovery | In-memory and Redis-backed service registry |
| Security | Transport security, service authentication/authorization, optional application-level payload encryption |
| Operations | Structured logging, metrics, tracing, auditing, health checks, graceful shutdown |

**Stack:** TypeScript · Node.js · ESM · pnpm

### 1.2 Primary objective

Build a maintainable, secure, testable communication platform **without** duplicating the functionality of underlying protocol libraries or existing OneUnit packages.

### 1.3 Non-negotiable Kafka boundary

> **The Kafka broker/cluster is external infrastructure.**  
> `@oneunit/microservice` must never create, host, launch, or operate a Kafka broker or server.

Kafka support is a **client integration** with two optional, explicitly selectable drivers:

| Driver | Role |
|---|---|
| `@oneunit/kafka` | Optional OneUnit-native client; convenient inside the OneUnit environment |
| KafkaJS | Optional standard client; selectable even when `@oneunit/kafka` is installed; also for standalone applications |

- Neither driver is mandatory.
- Explicit selection is always honored. If the selected driver fails, surface that failure — **never silently switch drivers**.
- An optional `auto` mode may detect an available driver for convenience; it is never the only supported mode.
- Do not build a third Kafka client inside this package.

See `docs/ARCHITECTURE.md` §12 for full ownership boundaries and selection policy.

---

## 2. Mandatory working rules

### 2.1 The agent MUST

1. Read this document before modifying the package.
2. Read `docs/ARCHITECTURE.md` before implementing architectural changes.
3. Inspect the existing source code, package configuration, tests, and exports before making changes.
4. Verify the **actual public APIs** of dependencies (and their installed versions) before integrating them.
5. Preserve established architecture and naming conventions unless a justified change is required.
6. Implement the **smallest complete change** that satisfies the requirement.
7. Add or update tests for every behavior change.
8. Run the relevant tests, type checks, lint checks, and build.
9. Report commands that failed and distinguish verified results from assumptions.
10. Update documentation when public APIs, configuration, security behavior, or architecture changes.
11. Avoid unrelated refactoring during focused tasks.
12. Never claim that an implementation, test, build, or release succeeded without evidence.

### 2.2 The agent MUST NOT

- Invent exports, APIs, package capabilities, or dependency behavior.
- Replace working implementations without understanding their contracts.
- Silently remove features or change public APIs.
- Introduce dependencies without establishing a concrete need.
- Disable tests, lint rules, type checking, or security checks merely to obtain a passing build.
- Suppress TypeScript errors using `any`, `@ts-ignore`, or unsafe casts as a routine workaround.
- Implement custom cryptographic algorithms or invent unauthenticated key-exchange protocols.
- Introduce breaking changes without documenting and justifying them.
- Mark unimplemented features as complete.
- Publish packages, create releases, or push changes unless explicitly authorized.
- Embed, launch, or manage a Kafka broker/server.
- Silently switch Kafka drivers after a configuration or connection failure.
- Force every protocol into a custom universal wire format or pretend transports have identical semantics.

---

## 3. Initial repository inspection

Before starting a task, inspect the repository and identify:

| Area | What to find |
|---|---|
| Package layout | Root and package-level `package.json`, `pnpm-workspace.yaml` |
| Build | TypeScript configuration, build scripts, ESM exports |
| Source | Existing source, public exports, adapter structure |
| Tests | Existing tests, fixtures, integration harnesses |
| Docs | `docs/ARCHITECTURE.md`, related package documentation, README, examples |
| Dependencies | Versions, peer/optional ranges, package-manager constraints |
| Feature under change | Existing implementations of the feature being changed |

### 3.1 Dependency API verification

For any integration work:

1. Inspect the actual dependency API and **installed version**.
2. Use its public exports, official documentation, and existing repository usage.
3. Do **not** assume that illustrative code in architecture documentation represents an existing implementation.

**Kafka drivers (mandatory inspection before adapter work):**

| Driver | Inspect |
|---|---|
| `@oneunit/kafka` | Package source, exports, configuration types, producer/consumer APIs, lifecycle methods, error model, tests |
| KafkaJS | Public exports, configuration, producer/consumer APIs, lifecycle, error model, acknowledgment and consumer-group behavior |

Do not invent exports based on architecture examples. Define a capability matrix for both drivers and expose only behavior that can be implemented honestly.

### 3.2 Architecture vs implementation disagreement

If the architecture and implementation disagree:

1. Document the discrepancy.
2. Determine the intended behavior (prefer architecture for design intent; prefer code + tests for what currently ships).
3. Make the **smallest justified correction**.
4. Update docs and tests so they agree.

---

## 4. Architectural boundaries

The package follows a layered architecture. Ownership is strict.

```text
1. Core application and lifecycle
2. Configuration and contracts
3. Identity, authentication, and authorization
4. Security and key management
5. Service registry and discovery
6. Transport abstractions
7. Protocol and messaging adapters
8. Observability
9. Public API exports
```

### 4.1 Core

**Owns:**

- Application composition
- Adapter registration
- Startup and shutdown orchestration
- Common error categories
- Shared configuration
- Common service identity interfaces
- Cross-adapter observability conventions
- Capability interfaces (narrow, not universal)

**Must not contain:**

- Kafka-specific, NATS-specific, gRPC-specific, or socket-specific implementation details
- Eager imports of optional adapter dependencies that would make core fail when those packages are absent

### 4.2 Contracts

Contracts define shared message metadata, event schemas, versions, and common interfaces.

The agent must distinguish between:

| Kind | Role |
|---|---|
| Internal TypeScript types | Compile-time only |
| Runtime validation schemas | Enforce untrusted data shape (e.g. Zod) |
| Public API contracts | Stable exported types and behavior |
| Wire-protocol representations | Adapter-specific encodings |

**TypeScript types alone do not validate untrusted runtime data.**

### 4.3 Adapters

Each adapter owns:

- Native client/server integration
- Adapter-specific configuration
- Native protocol semantics
- Serialization and deserialization
- Error mapping (preserve native details where useful)
- Authentication integration
- Health checks
- Lifecycle and cleanup
- Adapter-specific tests

**Rules:**

- Adapters MUST NOT import another adapter’s internal implementation.
- Shared functionality must live in an appropriate core interface, not private cross-adapter imports.
- Prefer capability-specific interfaces (`RpcInvoker`, `MessagePublisher`, `DatagramTransport`, …) over forcing every adapter into one universal interface.
- Keep both Kafka drivers optional; resolve the driver explicitly and fail clearly when the selected driver is unavailable.

### 4.4 Public API

- Only intentionally supported APIs may be exported from the package entry point or documented subpath exports.
- Internal helpers, test fixtures, implementation details, and unstable adapter internals must not become public accidentally.
- New public exports must include appropriate types, documentation, and tests.
- Avoid a barrel that eagerly imports every optional adapter. Core imports must not fail because an unused optional dependency is absent.
- Use explicit `exports` mappings for ESM runtime entry points and declaration files.

See `docs/ARCHITECTURE.md` §8 for public API design rules and illustrative composition shapes.

---

## 5. Transport and protocol rules

### 5.1 tRPC

- Preserve native tRPC routers, procedures, clients, and type inference.
- Use supported tRPC middleware and error handling.
- Integrate shared authentication and observability without replacing the native protocol.
- Validate untrusted input at runtime where the native contract does not already do so.
- Respect cancellation and timeout behavior where supported.
- Authentication context must come from verified credentials, not arbitrary client-supplied context.
- Avoid requiring a particular HTTP framework in the core; isolate framework hosting as an optional integration if needed.

### 5.2 gRPC

- Preserve native Protobuf service definitions and gRPC semantics.
- Use supported APIs from `@grpc/grpc-js`.
- Use `@grpc/proto-loader` only where dynamic loading is required; prefer generated code.
- Validate credentials and TLS configuration.
- Map common errors to appropriate gRPC status codes while preserving useful native details.
- Handle deadlines, cancellation, streaming, and server shutdown correctly.
- Define channel/server credentials, metadata limits, message size limits, and keepalive policy explicitly.

### 5.3 Connect RPC

- Preserve native Connect service contracts and transport behavior.
- Use the APIs supported by the **installed** Connect RPC version.
- Keep HTTP transport integration separate from the core.
- Preserve native error semantics and streaming behavior.
- Do not assume all Connect and gRPC transports have identical capabilities.
- Do not assume a Connect handler mounts identically into every web server without an adapter layer.

### 5.4 TCP

- Implement length-prefixed framing with a four-byte big-endian payload length.
- Enforce frame-size limits **before** allocating payload buffers.
- Handle partial headers, partial payloads, and multiple frames in one read.
- Apply backpressure and connection limits.
- Clean up listeners, sockets, timers, and pending requests.
- Support secure TLS configuration where required (Node’s established TLS facilities).
- Use bounded retries with exponential backoff and jitter where appropriate.
- Define whether connections are one-request-at-a-time or multiplexed; if multiplexed, include correlation IDs and bound in-flight requests.

**TCP is an ordered byte stream.** Do not claim message boundaries or exactly-once execution based on TCP delivery alone.

### 5.5 UDP

- Treat datagrams as unreliable and potentially spoofed.
- Validate packet lengths and versions.
- Enforce conservative payload limits; avoid IP fragmentation assumptions.
- Apply authentication and replay protection where required.
- Apply rate limits and resource limits.
- Do not assume ordering or successful delivery.
- **Do not** implement fragmentation or a custom reliability layer without explicit approval and a documented requirement.

### 5.6 Kafka

**Driver selection (mandatory):**

| Config value | Behavior |
|---|---|
| `driver: "oneunit"` | Select `@oneunit/kafka`; fail clearly if unavailable |
| `driver: "kafkajs"` | Select KafkaJS whether or not `@oneunit/kafka` is installed |
| `driver: "auto"` | Optional convenience; document precedence; never the only mode |

**Rules:**

- Use the selected driver’s **documented public API** only.
- Do not duplicate connection management, producers, consumers, configuration, offset management, topic administration, or native retry behavior that the selected client already owns.
- Preserve topic, partition, offset, and consumer-group semantics.
- Propagate correlation and tracing metadata through headers supported by the selected driver.
- Support schema versions and stable message identity where the event contract requires them.
- Make consumer processing idempotent where duplicate processing is possible.
- Respect native acknowledgment, retry, offset, transaction, and shutdown behavior.
- Do not claim exactly-once business processing without an end-to-end design that establishes it.
- Do not silently create topics or modify broker configuration unless explicitly requested and supported.
- Distinguish dependency-resolution errors, invalid configuration, authentication failures, and broker connectivity failures.
- Never switch drivers silently after initialization or connection failure.
- Never embed, launch, or manage a Kafka broker/server.
- If a needed capability is missing from `@oneunit/kafka`, document the gap; consider extending that package; users may select KafkaJS when it supports the need. Do not create a third client here.

### 5.7 NATS

Treat NATS Core and JetStream as **separate modes** with distinct configuration and delivery semantics.

**NATS Core:**

- Pub/sub and request/reply
- Native connection lifecycle
- Appropriate timeout and error handling
- **No** assumption of persistence or replay

**NATS JetStream:**

- Durable consumers
- Acknowledgments
- Redelivery
- Retention and replay
- Native consumer lifecycle

Use the official NATS client. Do not create retry or acknowledgment behavior that conflicts with native JetStream semantics. Do not imply that Core NATS provides JetStream persistence.

---

## 6. Dependency management

Before adding a dependency, the agent must:

1. Identify the exact functionality required.
2. Check whether Node.js built-ins or existing dependencies already provide it.
3. Confirm compatibility with the package’s runtime, ESM configuration, and TypeScript version.
4. Determine whether it belongs in `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies`.
5. Check maintenance status, license, and relevant security considerations.
6. Update the lockfile through pnpm.
7. Add tests and documentation where required.

### 6.1 Dependency rules

| Area | Guidance |
|---|---|
| Validation | Use Zod for runtime schema validation where appropriate |
| Logging | Use Pino or the established logger abstraction for structured logging |
| Crypto | Use Node.js cryptographic primitives or reviewed cryptographic libraries; never invent primitives |
| Kafka | Both `@oneunit/kafka` and `kafkajs` are **optional**; keep them out of mandatory core dependencies |
| NATS | Use the official NATS client |
| Isolation | Keep protocol-specific dependencies isolated where feasible |
| Duplication | Avoid installing multiple libraries that duplicate the same functionality |
| Convenience | Avoid adding dependencies solely for convenience when a stable existing abstraction is sufficient |

Do not upgrade unrelated dependencies as part of a focused implementation task.

Do not install or load both Kafka clients as mandatory runtime dependencies just to support auto-selection. Keep driver resolution explicit, testable, and deterministic in ESM and in the packed npm artifact.

---

## 7. Security requirements

Security is a **mandatory design requirement**, not an optional finishing step. Default policy is deny.

### 7.1 Authentication and authorization

- Authenticate remote service identities before granting protected access.
- Default authorization policies to deny.
- Validate credentials and reject expired, revoked, or invalid identities.
- Apply permissions at the relevant service, operation, topic, subject, or resource level.
- Do **not** trust service IDs, tenant IDs, or other identifiers supplied solely by unauthenticated message payloads.
- Avoid logging credentials or sensitive payloads.
- Do **not** assume that authentication grants permission for every operation.
- Fail closed if the required policy provider is unavailable.

### 7.2 Cryptography

When application-level encryption is required:

| Requirement | Rule |
|---|---|
| Authenticated encryption | AES-256-GCM with a 12-byte nonce and a 16-byte authentication tag |
| Nonce uniqueness | Never reuse a nonce with the same AES-GCM key |
| Key exchange | X25519 only within an authenticated key-exchange protocol |
| Key derivation | HKDF-SHA-256 for purpose-specific key derivation |
| Signing | Independent Ed25519 signing keys; never derive Ed25519 private keys from an X25519 shared secret |
| Metadata | Authenticate routing/security metadata as associated data or with a clearly defined canonical signature format |
| Replay | Message IDs, nonces or sequence numbers, and bounded replay state |
| Key lifecycle | Key IDs, rotation, revocation, and expiration |
| Secrets hygiene | Keep private keys and root secrets out of source control, logs, examples, and package tarballs |

The agent MUST NOT design a new cryptographic primitive or invent an unauthenticated key-exchange protocol. Prefer established, reviewed protocols and libraries. Any custom handshake or cryptographic protocol requires explicit design review before implementation.

### 7.3 Encryption boundaries

| Mechanism | Protects | Does not provide |
|---|---|---|
| TLS / mTLS | Data in transit between authenticated endpoints | End-to-end confidentiality across brokers or intermediaries |
| Application-level payload encryption | Payload beyond TLS termination points | Free key distribution, rotation, or recovery |

Encryption requirements depend on the threat model and whether intermediaries must inspect the payload. Do not add encryption indiscriminately or claim end-to-end confidentiality unless the full key-distribution and message-processing design supports it.

### 7.4 Input validation and resource protection

- Validate external input at runtime at trust boundaries.
- Enforce message and frame size limits **before** large allocations.
- Bound queues, concurrent work, connections, and retry loops.
- Apply timeouts and rate limits.
- Reject malformed or unsupported protocol versions.
- Prevent uncontrolled buffer allocation and unbounded retry loops.
- Avoid leaking stack traces, internal hostnames, or secrets through remote errors.

Security-related changes **must** include negative tests.

---

## 8. Service registry

The registry is responsible for registration, leases, discovery, and health metadata. It does **not** guarantee that a discovered endpoint remains available.

### 8.1 Distinctions the agent must preserve

| Concept | Meaning |
|---|---|
| Service identity | Logical authenticated identity of the service |
| Service instance identity | Concrete running instance |
| Registration lease | Time-bounded registration with renewal |
| Health and readiness | Whether the instance can accept work |
| Discovery results | Snapshot that may become stale |
| Authorization policy | Separate from registration; authn ≠ authz |

### 8.2 Registry requirements

- Expire stale leases automatically.
- Validate registration data.
- Support multiple instances of the same service.
- Handle failed renewals without leaving the system in an undefined state.
- Clean up deregistered instances; correctness must not depend solely on successful deregistration.
- Avoid race conditions in lease renewal and expiration (use atomic operations for Redis).
- Keep the in-memory backend suitable for development and tests only — not distributed discovery.
- Treat discovery results as potentially stale; client-side caches need TTL and safe refresh.
- Never store reusable secrets or private keys in registry records.
- Endpoint information must be authenticated or otherwise protected against registry poisoning.

A successful discovery operation does not guarantee that the returned endpoint is still available.

---

## 9. Error handling and reliability

Use the existing common error model where available. Map common errors into native protocol representations without discarding useful native details.

### 9.1 Recommended categories

| Category | Typical meaning |
|---|---|
| `CONFIGURATION` | Invalid or incomplete local configuration |
| `DEPENDENCY_UNAVAILABLE` | Required downstream service or broker unavailable |
| `CONNECTION` | Connection setup, reset, or transport failure |
| `TIMEOUT` / `DEADLINE_EXCEEDED` | Deadline expired; remote outcome may be unknown |
| `CANCELLED` | Caller or application cancelled work |
| `AUTHENTICATION` / `UNAUTHENTICATED` | Identity could not be verified |
| `AUTHORIZATION` / `FORBIDDEN` | Verified identity lacks permission |
| `VALIDATION` / `INVALID_ARGUMENT` | Malformed input or contract violation |
| `NOT_FOUND` | Service, route, subject, or resource not found |
| `CONFLICT` | Operation conflicts with current state or idempotency record |
| `RATE_LIMITED` | Rejected by configured resource policy |
| `RESOURCE_EXHAUSTED` | Message, queue, connection, or memory bound reached |
| `UNAVAILABLE` | Transient service-level failure where retry may be appropriate |
| `INTERNAL` | Unexpected failure with a stable public message and a private cause |

Normalized errors should preserve, where applicable: stable category/code, safe message, retryability recommendation, operation/correlation IDs, sanitized native details, and original cause for local diagnostics.

**Never** serialize stack traces, credentials, raw tokens, cryptographic keys, full sensitive payloads, or internal hostnames to untrusted callers.

### 9.2 Reliability rules

- Bound network timeouts, queues, pools, and concurrent operations.
- Retry only appropriate transient failures.
- Use exponential backoff with jitter where appropriate.
- Do not blindly retry non-idempotent operations.
- Use idempotency keys or deduplication when needed; commit deduplication records atomically with the business side effect where possible.
- Propagate cancellation and deadlines where supported.
- Preserve native broker acknowledgment and offset semantics.
- Distinguish permanent errors from transient errors.
- Clean up pending requests after completion, timeout, or cancellation.
- Treat a timeout as an **unknown remote outcome** when execution may already have occurred.
- Do not expose a universal `exactlyOnce: true` setting.
- Do not silently convert failures into successful empty results.
- Do not create an independent retry loop in an adapter if the underlying package already owns that retry behavior.

Document persistence, ordering scope, redelivery, deduplication, and recovery guarantees **per operation and adapter**.

---

## 10. Observability

All adapters should integrate with the shared observability conventions.

### 10.1 Logging

Use structured fields. Include relevant service IDs, instance IDs, adapter names, protocol, operation names, correlation/trace IDs, durations, outcomes, retry counts, and sanitized error categories.

**Never** log secrets, tokens, private keys, full authorization headers, or unrestricted sensitive plaintext payloads.

### 10.2 Metrics

Where supported, track:

- Request/message counts (bounded-cardinality labels only)
- Latency histograms
- Errors by normalized category
- Connection and in-flight counts
- Queue depth, queue bytes, rejected work
- Retries and retry exhaustion
- Adapter health and reconnect counts
- Registry lease renewals and discovery failures
- Consumer redelivery/acknowledgment outcomes where the native client exposes them
- Shutdown drain duration and unfinished work

Do **not** put message IDs, user IDs, arbitrary subjects, raw URLs, or exception messages in metric labels.

### 10.3 Tracing

Propagate supported trace context through RPC metadata, Kafka headers (per selected driver), NATS headers, and custom message envelopes. Avoid creating duplicate spans when an underlying client already instruments the same operation unless the layering is deliberate.

### 10.4 Auditing

Audit security-sensitive events, including:

- Authorization failures
- Credential and key rotation / revocation
- Registration and policy changes
- Registry integrity failures
- Security configuration changes

Audit records must be structured and must not contain secret material.

---

## 11. TypeScript and code quality

- Follow the existing TypeScript compiler settings.
- Prefer explicit interfaces for public APIs.
- Prefer `unknown` over `any` at trust boundaries.
- Use runtime validation for untrusted external data.
- Avoid unsafe casts that conceal missing validation.
- Use clear names and small, cohesive modules.
- Separate public APIs from internal implementation.
- Avoid circular dependencies.
- Avoid mutable shared global state unless explicitly required and documented.
- Keep asynchronous cleanup deterministic.
- Handle rejected promises and event-emitter errors appropriately.
- Preserve ESM compatibility.
- Maintain type declarations for published exports.
- Follow established formatting and linting conventions.

Do not modify compiler settings to conceal implementation defects. Do not use `@ts-ignore` or routine `any` casts to paper over missing types or validation.

---

## 12. Testing requirements

Every behavior change requires appropriate tests.

### 12.1 Unit tests

Test pure functions, validation, configuration, error mapping, framing, serialization, registry logic, lifecycle behavior, and Kafka adapter mapping against fakes/test doubles of the actual public APIs of the selected drivers.

### 12.2 Adapter tests

Test native integration, authentication, timeouts, cancellation, error mapping, lifecycle, and cleanup.

### 12.3 Integration tests

Use real infrastructure where necessary for:

- Kafka (existing broker via the selected driver — `@oneunit/kafka` or KafkaJS)
- NATS Core and JetStream
- Redis registry
- TCP and UDP endpoints
- tRPC, gRPC, and Connect RPC interoperability
- Disconnection, recovery, and shutdown with in-flight work

Kafka integration tests must **not** depend on a broker implementation embedded in `@oneunit/microservice`.

### 12.4 Security tests

Test malformed input, unauthorized access, invalid signatures, modified ciphertext, replay attempts, expiration, key rotation, oversized messages, and resource limits.

### 12.5 Packaging tests

- ESM imports and type declaration resolution
- Public export verification
- Optional dependency behavior (core importable without Kafka clients when Kafka is unused)
- Clean installation from the generated package
- Runnable examples and `npm pack` inspection

### 12.6 Regression tests

Every fixed defect should have a regression test when the behavior can be tested automatically.

### 12.7 Test quality rules

- Do not weaken assertions merely to make tests pass.
- Do not delete failing tests without a justified requirement change.
- Do not replace integration tests with mocks when native behavior is the subject of the test.
- Avoid timing-dependent tests where deterministic synchronization is possible.
- Clean up connections, servers, timers, and temporary resources.
- Verify that test execution does not depend on developer-specific machine state.

---

## 13. Required verification workflow

Before marking a task complete:

1. Run the focused tests for the changed area.
2. Run the full relevant test suite.
3. Run TypeScript type checking.
4. Run linting.
5. Run the production build.
6. Run integration tests when the changed feature requires them.
7. Inspect the diff for unintended changes.
8. Verify public exports and declarations when the public API changes.
9. Update documentation.
10. Report results accurately — distinguish verified results from assumptions.

Use the scripts already defined by the package. Typical commands, if configured:

```bash
pnpm --filter @oneunit/microservice test
pnpm --filter @oneunit/microservice typecheck
pnpm --filter @oneunit/microservice lint
pnpm --filter @oneunit/microservice build
```

For a workspace-level task, run the appropriate root commands as well.

If a command fails because of an environmental issue, report the **exact failure** and distinguish it from a code defect. Do not report the task as fully verified when required checks have not run.

---

## 14. Public API and compatibility

Before changing a public API, inspect existing usage and tests.

The agent must:

- Prefer additive changes when appropriate.
- Document breaking changes and provide migration notes after stabilization.
- Preserve existing behavior unless a change is explicitly required.
- Update type declarations and package exports.
- Avoid exposing internal modules accidentally.
- Check compatibility across supported dependency versions.
- Keep adapter-specific APIs distinct when their semantics differ (especially Core vs JetStream, and the two Kafka drivers).
- Update examples to reflect the final API.
- Label experimental APIs clearly before stabilization.

Do not create compatibility wrappers or deprecated aliases without a clear migration need.

A public API change is breaking if it changes a documented type, default, error category, lifecycle guarantee, or observable behavior.

---

## 15. Documentation requirements

Update documentation whenever a change affects:

- Public API
- Configuration
- Security behavior
- Transport capabilities
- Delivery guarantees
- Adapter dependencies or driver selection
- Installation
- Usage examples
- Lifecycle behavior
- Error handling
- Compatibility
- Architecture

### 15.1 Consistency

Maintain consistency between:

- `AGENT.md` (this document)
- `docs/ARCHITECTURE.md`
- README
- API documentation
- Examples
- Tests

### 15.2 Status labels

Architecture describes **intended** design. Implementation documentation must accurately state which features are actually available:

| Status | Meaning |
|---|---|
| **Implemented** | Code and tests exist; feature is supported |
| **Experimental** | Usable but API or behavior may change |
| **Planned** | Architecture intends support; implementation is incomplete |
| **Unsupported** | Deliberately excluded or not available in the current release |

Never document an unimplemented feature as production-ready. Once an API is implemented, examples must be compiled or executed in CI so documentation cannot silently drift from code.

---

## 16. Implementation workflow

For each task, follow these stages.

### Stage 1 — Understand

- Read the relevant architecture sections.
- Inspect implementation and tests.
- Identify public contracts and dependencies.
- For Kafka work, inspect the actual public APIs of both optional drivers.
- Establish the expected behavior.

### Stage 2 — Plan

- Identify files and modules that need changes.
- Define the smallest complete implementation.
- Identify security, compatibility, and ownership implications.
- Define required tests (unit, adapter, integration, security as applicable).

For a small, unambiguous task, keep the plan concise.

### Stage 3 — Implement

- Follow the established module boundaries.
- Implement the feature without unrelated refactoring.
- Add validation and error handling at trust boundaries.
- Keep optional dependencies optional (no eager core imports).
- Update tests alongside the implementation.

### Stage 4 — Verify

- Run focused tests.
- Run type checking, linting, and build.
- Run relevant integration and security tests.
- Review the diff and public API surface.
- Confirm optional dependency behavior still holds.

### Stage 5 — Document

- Update affected documentation and examples.
- Document limitations, configuration changes, and driver-specific differences.
- Record architectural decisions (ADRs) when required.
- Align status labels (implemented / experimental / planned / unsupported).

### Stage 6 — Report

Provide a concise completion report containing:

- What changed
- Which files or modules changed
- Tests and commands executed
- Actual verification results (pass/fail with evidence)
- Any remaining limitations or follow-up work

Do not claim completion if required work remains unfinished.

---

## 17. Feature completion checklist

Before declaring a feature complete, verify all applicable items:

**Requirements and design**

- [ ] Requirements are understood
- [ ] Architecture boundaries are respected
- [ ] Existing behavior is preserved or changes are documented
- [ ] Kafka dual-driver rules honored (optional, explicit selection, no silent switch, no embedded broker)

**API and validation**

- [ ] Public APIs are intentional and typed
- [ ] External input is validated at trust boundaries
- [ ] Resource limits and timeouts are enforced

**Security**

- [ ] Authentication and authorization are correct and fail closed
- [ ] Secrets are not logged or exported
- [ ] Security tests are added where applicable

**Reliability and lifecycle**

- [ ] Error handling is consistent with the common model
- [ ] Cleanup and shutdown are implemented
- [ ] Delivery guarantees are documented accurately (no false exactly-once claims)

**Verification**

- [ ] Unit tests pass
- [ ] Integration tests pass where required
- [ ] Type checking passes
- [ ] Linting passes
- [ ] Build succeeds
- [ ] Optional dependency / packaging behavior verified when relevant

**Documentation and hygiene**

- [ ] Documentation is updated
- [ ] No unintended files or dependencies were changed
- [ ] Remaining limitations are disclosed

---

## 18. Release and publishing restrictions

The agent must **not** publish a release automatically during ordinary implementation work.

Before a release, verify:

- Version and changelog
- Public exports and type declarations
- Production build
- Test suite and type checking
- Linting
- Package contents (`npm pack` inspection)
- Dependency and peer/optional dependency configuration
- Clean installation from the packed artifact
- Runnable examples
- Documentation accuracy (including implemented vs planned status)
- Security-sensitive changes reviewed
- Kafka: both optional drivers tested; no broker embedded; explicit selection behavior verified

Use the repository’s release process and publish **only with explicit authorization**.

---

## 19. Conflict resolution and final rule

### 19.1 When documents conflict

| Conflict | Action |
|---|---|
| This document vs `docs/ARCHITECTURE.md` | Stop before a high-impact architectural change; explain the conflict; obtain clarification when necessary |
| Architecture vs current implementation | Document the discrepancy; prefer smallest justified correction; align docs and tests |
| Illustrative architecture snippets vs real dependency APIs | Prefer actual public APIs of the installed dependency versions |

### 19.2 Final rule

**Correctness, security, interoperability, and maintainability take priority over implementation speed and feature count.**

Do not implement a feature merely because a dependency is installed.  
Do not abstract technologies beyond what their semantics permit.  
Do not duplicate functionality owned by an underlying protocol library or OneUnit package.  
Do not embed or operate a Kafka broker.  
Do not silently switch Kafka drivers.

Every change must strengthen the architecture, preserve clear ownership boundaries, and be supported by appropriate verification.