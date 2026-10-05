# Architecture

Why this package is shaped the way it is. The [README](./README.md) describes what it
does; this document outlines the core architectural decisions, design invariants, trade-offs, and rejected alternatives.

---

## Table of Contents

- [The Core Philosophy](#the-core-philosophy)
- [Dependencies](#dependencies)
- [Module Map & Boundaries](#module-map--boundaries)
- [Subpath Exports & Modular Boundaries](#subpath-exports--modular-boundaries)
- [Transport-Neutral Connection Contract](#transport-neutral-connection-contract)
- [Transport Adapter Architecture](#transport-adapter-architecture)
  - [Pre-handshake HTTP Refusals](#pre-handshake-http-refusals)
  - [Server Ownership Invariants](#server-ownership-invariants)
- [Fastify Plugin Integration](#fastify-plugin-integration)
- [Asynchronous Operations & Auth Hooks](#asynchronous-operations--auth-hooks)
- [Delivery Guarantees & Fault Isolation](#delivery-guarantees--fault-isolation)
- [Brokerless Core & Horizontal Scaling](#brokerless-core--horizontal-scaling)
- [Shared Heartbeat Scheduler](#shared-heartbeat-scheduler)
- [End-to-End Encryption (E2EE) Module](#end-to-end-encryption-e2ee-module)
- [Capacity Limits & Allocation Guards](#capacity-limits--allocation-guards)
- [Trust Boundaries & Security Model](#trust-boundaries--security-model)
- [Testing Strategy & Boundary Enforcement](#testing-strategy--boundary-enforcement)
- [Packaging & Sourcemap Integrity](#packaging--sourcemap-integrity)

---

## The Core Philosophy

The hub owns **connections in this process**. Everything else — the underlying network socket, the HTTP server, the web framework, and the distributed message broker — is somebody else's responsibility, accessed through a deliberately minimal interface.

This strict separation ensures that the core remains lightweight, robust against network failures, and completely decoupled from framework or transport churn.

---

## Dependencies

| Dependency | Category | Role & Justification |
| :--- | :--- | :--- |
| `libsodium-wrappers` | Runtime dependency | High-performance, cryptographically vetted X25519 and XSalsa20-Poly1305 primitives. Zero hand-rolled crypto. |
| `notepack.io` | Runtime dependency | High-throughput binary MessagePack serialization for compact frame encoding. |
| `ws` | Runtime dependency | Transport engine for `attachWebSocketAdapter()`. Imported lazily so Fastify-only runtimes never load it. |
| `fastify` | Optional peer dependency | Required only when using `registerRealtime` or `@oneunit/realtime/plugin`. |
| `@fastify/websocket` | Optional peer dependency | Required only when running the Fastify plugin in `"fastify"` mode. |

### Why No Broker Dependencies

In version 1.x, the package shipped a built-in Kafka bridge (`@oneunit/kafka`). That bridge imposed a mandatory Kafka client dependency, a complex broker configuration surface, and semantics that only applied to Kafka.

In version 2.0.0, the Kafka bridge was completely removed. Local channel membership and local fan-out are the true concerns of a realtime hub; cross-instance synchronization is a transport concern that belongs in the application layer.

---

## Module Map & Boundaries

```text
src/
  index.ts       Public surface: clean re-exports of modules below.
  hub.ts         Core hub: channels, membership, delivery, heartbeat, E2EE, limits.
  adapter.ts     Transport adapter: socket lifecycle, upgrade handling, HTTP-level refusals.
  plugin.ts      Fastify plugin binding (the only module that imports Fastify).
  fastify.ts     Opt-in FastifyInstance.realtime TypeScript module augmentation.
  e2ee.ts        Libsodium crypto helpers and validation logic.
  errors.ts      Typed error hierarchy with machine-readable error codes.
```

### Import Constraints Matrix

To prevent architectural drift, import directions are strictly constrained and enforced by automated tests in `test/boundaries.test.ts`:

| Module | Permitted Imports | Prohibited Imports |
| :--- | :--- | :--- |
| `src/hub.ts` | `src/errors.ts`, `src/e2ee.ts`, `notepack.io` | `ws`, `fastify`, `@fastify/websocket`, any broker |
| `src/adapter.ts` | `src/hub.ts`, `src/errors.ts`, lazy `ws` | `fastify`, `@fastify/websocket`, any broker |
| `src/plugin.ts` | `src/adapter.ts`, `src/hub.ts`, `fastify` | Direct broker imports |
| `src/fastify.ts` | Type imports only | Runtime code |
| `src/e2ee.ts` | `libsodium-wrappers` | `src/hub.ts`, transport code |
| `src/errors.ts` | Pure TypeScript (zero dependencies) | Everything |

A pull request violating any of these constraints fails CI immediately.

---

## Subpath Exports & Modular Boundaries

`package.json` configures granular subpath exports so consumers can import isolated components without loading unnecessary modules:

| Subpath | Target | Boundary Guarantee |
| :--- | :--- | :--- |
| `@oneunit/realtime` | `./dist/index.js` | Complete public API surface. |
| `@oneunit/realtime/hub` | `./dist/hub.js` | Core hub only. Zero `ws` or Fastify imports. |
| `@oneunit/realtime/adapter` | `./dist/adapter.js` | Connection adapter and HTTP upgrade. Zero Fastify imports. |
| `@oneunit/realtime/plugin` | `./dist/plugin.js` | Fastify plugin integration. |
| `@oneunit/realtime/fastify` | `./dist/fastify.js` | TypeScript declaration for Fastify instance augmentation. |
| `@oneunit/realtime/e2ee` | `./dist/e2ee.js` | Pure Libsodium cryptography helpers. |

---

## Transport-Neutral Connection Contract

Every server and runtime produces a different socket interface: `ws` exposes `bufferedAmount` and `ping()`, `@fastify/websocket` provides `send(data, cb)`, browser WebSockets provide neither, and uWebSockets or Bun have distinct socket methods.

Coupling the hub to specific socket implementations with conditionals like `if (socket instanceof ws)` would balloon the core and break portability. Instead, the hub defines a minimal structural interface:

```typescript
export interface Connection {
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  readonly bufferedAmount?: number;
  ping?(): void;
}
```

- **Three required members**: `readyState`, `send()`, and `close()`.
- **Three optional members**: `bufferedAmount`, `ping()`, and `terminate()`.

`bufferedAmount` and `ping()` are optional so the contract remains honest: the hub does not invent byte measurements on transports that cannot observe them. On transports lacking `bufferedAmount`, backpressure falls back to consecutive-drop counting; on transports lacking `ping()`, liveness falls back to explicit `hub.touch(clientId)`.

---

## Transport Adapter Architecture

`src/adapter.ts` provides reusable connection management logic across all transports:
- Authenticating peers before or upon connection.
- Joining default channels.
- Routing decoded incoming messages to application handlers.
- Cleaning up channel membership upon socket closure.

### Pre-handshake HTTP Refusals

A WebSocket connection that has completed its handshake can only be terminated with a WebSocket close frame (`1008 Policy Violation`). However, a connection that has not yet completed the handshake can be answered with an HTTP status code.

`attachWebSocketAdapter()` runs `adapter.authenticate()` **before** `wss.handleUpgrade()`:
- **Refused peers receive HTTP 401 Unauthorized** without a WebSocket upgrade occurring.
- The rejected client never occupies a connection slot, allocates an E2EE key, or triggers a heartbeat timer.
- If the hub is already closed, incoming upgrades receive **HTTP 503 Service Unavailable**.

### Server Ownership Invariants

1. **Self-created Server**: If `attachWebSocketAdapter(httpServer, { hub })` creates its own internal `WebSocketServer`, `realtime.close()` terminates active sockets, unbinds the upgrade listener, and closes that `WebSocketServer`.
2. **Caller-passed Server**: If the caller passes `{ server: wss }`, the caller retains ownership: the adapter listens to it, but `realtime.close()` never closes the caller's server.
3. **Double-attach Guard**: Attaching two adapters to the same HTTP server throws a `TypeError`. Two listeners on the same upgrade event would cause socket contention; closing the prior adapter releases the reservation.

---

## Fastify Integration

The Fastify plugin (`src/plugin.ts`) is a thin binding over `ConnectionAdapter`:
- Creates the `RealtimeHub` and configures the adapter.
- In `"fastify"` mode, hooks into `@fastify/websocket` via `app.websocketServer`.
- In `"ws"` mode, attaches a standalone `ws.WebSocketServer` to `app.server`.
- **Zero singletons**: Each Fastify instance receives an independent hub instance with its own state.
- **Ordered Teardown**: Hooks into Fastify's `preClose` lifecycle to terminate active sockets and detach listeners before the HTTP server finishes closing.

---

## Asynchronous Operations & Auth Hooks

`join()`, `leave()`, `disconnect()`, `send()`, and `broadcast()` return promises:
- Real authentication and authorization frequently require asynchronous token verification, database queries, or external policy checks.
- Synchronous APIs would force callers to either block or introduce error-prone out-of-band validation.
- All denied operations reject with typed errors (`AuthorizationError`, `AuthenticationError`) containing machine-readable `code` properties.

---

## Delivery Guarantees & Fault Isolation

A single slow or faulty client must never destabilize the rest of the hub:

- **Delivery Never Throws on Peer Failures**: `send()` returns `boolean` indicating whether the write was accepted. `broadcast()` returns the exact number of connections written to.
- **Failures are Counted**: Drops increment `messagesDropped`, failed writes increment `sendFailures`, and excessive consecutive drops trigger disconnection with code `1013`.
- **Input Validation Throws**: Programming errors (invalid channel name, oversized payload, closed hub) throw typed errors immediately.
- **Core Axiom**: *A bad frame or invalid parameter is an exception; a slow or failing peer is a counter.*

---

## Brokerless Core & Horizontal Scaling

The core hub is strictly single-process and in-memory. Cross-process pub/sub is abstracted behind a tiny interface:

```typescript
export interface BroadcastTarget {
  broadcast(
    channelName: string,
    message: unknown,
    options?: BroadcastOptions
  ): Promise<number> | number;
}
```

`RealtimeHub` satisfies `BroadcastTarget` directly. To scale horizontally:
1. Each application instance subscribes to a message broker (Redis, Kafka, NATS).
2. Incoming broker messages are forwarded to `hub.broadcast(channel, message)`.
3. Outgoing application events publish to the broker.

The hub stays clean, and the application chooses its own broker, clustering topology, and delivery semantics.

---

## Shared Heartbeat Scheduler

Per-connection timers are an anti-pattern: maintaining 10,000 active clients would mean 10,000 distinct timers waking up and causing event loop thrashing.

Instead, a single shared timer sweeps all connections at a configured interval:
- Cost is bounded to $O(N)$ per interval.
- Transports supporting `ping()` receive ping frames.
- Connections exceeding `timeoutMs` are terminated with close code `1001` and pruned.
- The timer is `unref`'d so it never keeps the Node.js event loop alive during shutdown.

---

## End-to-End Encryption (E2EE) Module

`src/e2ee.ts` provides payload encryption using Libsodium:
- **Key Exchange**: X25519 ECDH via `crypto_kx`.
- **Symmetric Encryption**: XSalsa20-Poly1305 authenticated encryption via `crypto_secretbox_easy`.
- **Wire Format**: Self-describing `{ type: "e2ee", ciphertext: "<base64>" }`.

### Critical Security Invariants

- **Skip-on-missing-key**: When broadcasting to an encrypted channel, participants without a registered public key are **skipped, never downgraded to plaintext**.
- **No Hand-rolled Crypto**: Every primitive is provided directly by `libsodium-wrappers`.
- **Input Validation**: Non-Base64 or invalid-length keys throw typed errors immediately, preventing Libsodium panics.
- **Honest Threat Model**: Protects against passive network eavesdroppers and peers. The hub process itself derives the shared keys to facilitate per-client encryption; it does not protect against a compromised server host.

---

## Capacity Limits & Allocation Guards

All capacities are bounded to prevent memory exhaustion and DoS attacks:
- `maxConnections`: Maximum concurrent connections admitted to the hub.
- `maxClientsPerChannel`: Maximum subscriptions per channel.
- `maxChannelsPerClient`: Maximum channels a single client can join.
- `maxMessageSize`: Enforced on the encoded binary frame before memory allocation.
- `maxChannelNameLength`: Bounds memory usage of internal channel maps.

Exceeding limits rejects with `ConnectionLimitError` or `MessageTooLargeError`.

---

## Trust Boundaries & Security Model

- **Sockets are Untrusted**: Incoming data is parsed safely; invalid JSON text is handled without crashing, and malformed frames are rejected.
- **Redacted Logging**: Auth tokens, session cookies, and message contents are excluded from internal event logging.
- **Idempotent Teardown**: Calling `close()` multiple times is guaranteed safe and never throws.
- **Isolated State**: No module-level mutable state or global variables. Multiple hubs in one Node.js process operate in complete isolation.

---

## Testing Strategy & Boundary Enforcement

The test suite in `test/` enforces both functional correctness and architectural rules:

| Suite | Focus |
| :--- | :--- |
| `test/hub.test.ts` | Channels, membership, delivery semantics, backpressure, limits, heartbeat, and lifecycle. |
| `test/adapter.test.ts` | Transport adapter, upgrade filtering, pre-handshake 401 refusals, server ownership. |
| `test/plugin.test.ts` | Fastify integration, library modes, preClose shutdown hooks. |
| `test/e2ee.test.ts` | Libsodium key derivation, encryption round-trips, frame validation, skip-on-missing-key rule. |
| `test/boundaries.test.ts` | Static import analysis preventing forbidden cross-module imports. |
| `test/integration.test.ts` | Live Fastify server and WebSocket clients validating real-world upgrade and auth flows. |
| `test/examples.test.ts` | End-to-end execution verifying that all scripts in `examples/` run successfully. |

---

## Packaging & Sourcemap Integrity

- `package.json` specifies `"files": ["dist", "src", "examples", ...]` so that `src/` is published in the npm tarball alongside `dist/`.
- Sourcemaps (`.js.map` and `.d.ts.map`) point directly to the published TypeScript source files, enabling seamless step-through debugging and editor jump-to-definition.
- The `clean` script removes `dist/` and `tsconfig.tsbuildinfo` before every build, ensuring obsolete compiled artifacts never ship.