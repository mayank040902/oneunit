<p align="center">
  <strong>@oneunit/realtime</strong>
  <br/>
  Local realtime WebSocket channels, fan-out, backpressure, and transport adapters for Node.js
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oneunit/realtime"><img src="https://img.shields.io/npm/v/@oneunit/realtime?color=0969da&label=npm" alt="npm version"></a>
  <a href="https://github.com/mayank040902/oneunit/blob/master/packages/realtime/LICENSE"><img src="https://img.shields.io/npm/l/@oneunit/realtime?color=22863a" alt="license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-417e38" alt="node version">
  <img src="https://img.shields.io/badge/types-included-3178c6" alt="types included">
</p>

<p align="center">
  In-memory channels · Zero-broker local fan-out · Adaptive backpressure · Shared heartbeat timer<br/>
  Pre-handshake HTTP auth · Transport-agnostic adapter · Libsodium E2EE · Fastify plugin
</p>

---

Local realtime connection management for Node.js: channels, fan-out,
backpressure, heartbeats, optional auth hooks, a transport adapter, and an
optional Fastify plugin.

Part of the [oneunit](https://github.com/mayank040902/oneunit) monorepo.

> **Monorepo** — [github.com/mayank040902/oneunit](https://github.com/mayank040902/oneunit)

```text
  Fastify (@fastify/websocket) ─┐
  node:http / node:https  ───────┼──> ConnectionAdapter ──> RealtimeHub
  express, uWebSockets, Bun  ─────┘       src/adapter.ts       src/hub.ts
                                                          │
                                                          │ BroadcastTarget
                                                          ▼
                                                 external broker adapter
                                                 (yours, not ours)
```

The hub manages channels and local connections, not brokers. Nothing in this package
talks to Kafka, Redis, NATS, or AMQP, and the core hub has zero runtime dependency on Fastify.

---

## Table of Contents

- [What It Is](#what-it-is)
- [What It Is Not](#what-it-is-not)
- [Installation](#installation)
- [Subpath Imports](#subpath-imports)
- [Quick Start](#quick-start)
  - [Standalone HTTP Server](#standalone-http-server)
  - [Existing `ws.WebSocketServer`](#existing-wswebsocketserver)
- [Transport Adapters](#transport-adapters)
  - [`createConnectionAdapter`](#createconnectionadapter)
  - [`attachWebSocketAdapter`](#attachwebsocketadapter)
  - [Pre-handshake Refusals](#pre-handshake-refusals)
- [Fastify Integration](#fastify-integration)
  - [Plugin Registration](#plugin-registration)
  - [Library Modes](#library-modes)
  - [Custom Route Handling](#custom-route-handling)
- [Channels and Clients](#channels-and-clients)
  - [Client Queries and Frozen Snapshots](#client-queries-and-frozen-snapshots)
  - [Frame Serialization and `decodeMessage`](#frame-serialization-and-decodemessage)
- [Authentication](#authentication)
- [Authorization](#authorization)
- [Capacity Limits](#capacity-limits)
- [Heartbeat and Sweeping](#heartbeat-and-sweeping)
- [Adaptive Backpressure](#adaptive-backpressure)
- [Lifecycle and Teardown](#lifecycle-and-teardown)
- [Typed Error Hierarchy](#typed-error-hierarchy)
- [Observability and Logging](#observability-and-logging)
- [End-to-End Encryption (E2EE)](#end-to-end-encryption-e2ee)
- [Horizontal Scaling Pattern](#horizontal-scaling-pattern)
- [Runnable Examples](#runnable-examples)
- [Development and Verification](#development-and-verification)
- [Architecture & Contributing](#architecture--contributing)
- [License](#license)

---

## What It Is

- **Local channel management** for WebSocket connections held in one process.
- **Transport-independent core**: `ws`, `@fastify/websocket`, and any object satisfying the minimal `Connection` contract (`send()`, `close()`, `readyState`) work seamlessly.
- **Unified connection adapter** that bridges concrete transports to the hub, providing pre-handshake authentication, automatic joining, routing, and cleanup.
- **Bounded delivery**: frame size limits, capacity constraints, consecutive-drop and byte-level backpressure, and a single shared heartbeat timer.
- **Async auth hooks**: asynchronous authentication and authorization hooks for connection admission, channel joining, and message publishing.
- **Typed errors and zero-allocation counters**: descriptive error codes and rich observability without external metrics dependencies.

## What It Is Not

- **It is not a broker.** Kafka is not part of this package, nor are Redis, NATS, AMQP, or any other message bus. The `@oneunit/kafka` dependency and `createKafkaBridge()` API were completely removed in 2.0.0.
- **It is not a distributed system.** It does not replicate messages across multiple Node processes or instances. An external broker adapter handles cross-instance distribution (see [Horizontal Scaling Pattern](#horizontal-scaling-pattern)).
- **It is not an opinionated framework.** There is no global singleton state, dependency injection container, or application domain model. A channel is simply an in-memory string subscription.
- **It is not a black-box security system.** It provides hooks for authentication and authorization; policy evaluation remains entirely yours.
- **It is not a replacement for TLS.** Libsodium E2EE provides payload privacy against passive wire eavesdroppers and peers, not an operator with server access (see [End-to-End Encryption (E2EE)](#end-to-end-encryption-e2ee)).

---

## Installation

```bash
npm install @oneunit/realtime
```

Requires **Node.js 20+**. Runtime dependencies: `libsodium-wrappers`, `notepack.io`, and `ws`. `ws` is imported lazily by the standalone adapter, so Fastify-only applications never load it.

Fastify and `@fastify/websocket` are optional peers — install them only if using the Fastify plugin:

```bash
npm install fastify @fastify/websocket
```

---

## Subpath Imports

The package exposes granular subpath exports in `package.json`, allowing you to import only what you need:

| Subpath | Target | Surface & Dependency Footprint |
| :--- | :--- | :--- |
| `@oneunit/realtime` | `./dist/index.js` | Full surface: hub, adapter, plugin, errors, E2EE helpers. |
| `@oneunit/realtime/hub` | `./dist/hub.js` | Core hub only. **No Fastify, no `ws` transport**. |
| `@oneunit/realtime/adapter` | `./dist/adapter.js` | Transport adapter and HTTP upgrade helpers. **No Fastify import**. |
| `@oneunit/realtime/plugin` | `./dist/plugin.js` | Fastify plugin registration and options. |
| `@oneunit/realtime/fastify` | `./dist/fastify.js` | Opt-in `FastifyInstance.realtime` TypeScript module augmentation. |
| `@oneunit/realtime/e2ee` | `./dist/e2ee.js` | Pure Libsodium cryptography helpers and codecs. |

---

## Quick Start

### Standalone HTTP Server

The fastest path to serving realtime WebSocket channels on a Node.js `http.Server`. Authentication runs before the WebSocket upgrade completes, ensuring rejected peers never hold open sockets:

```typescript
import { createServer } from "node:http";
import {
  attachWebSocketAdapter,
  createRealtimeHub,
} from "@oneunit/realtime";

// 1. Initialize the hub with limits and auth hooks
const hub = await createRealtimeHub({
  limits: { maxMessageSize: 64 * 1024, maxClientsPerChannel: 100 },
  heartbeat: { intervalMs: 30_000, timeoutMs: 60_000 },
  authenticate: async ({ request }) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token");
    if (!token || token !== "secret-token") {
      throw new Error("unauthorized");
    }
    return { userId: "user-123" };
  },
});

// 2. Attach WebSocket adapter to standard Node HTTP server
const server = createServer();
const realtime = await attachWebSocketAdapter(server, {
  hub,
  path: "/ws",
  channel: "lobby",
  onConnection: async (connection) => {
    await connection.hub.send(connection, {
      type: "welcome",
      clientId: connection.clientId,
      metadata: connection.metadata,
    });
  },
  onMessage: async (message, connection) => {
    await connection.hub.broadcast(connection.channel, {
      type: "chat",
      sender: connection.clientId,
      payload: message,
    });
  },
});

server.listen(3000, () => {
  console.log("Realtime server running on ws://localhost:3000/ws");
});

// 3. Graceful shutdown: close sockets, hub, and HTTP server in order
// await realtime.close();
// hub.close();
// server.close();
```

### Existing `ws.WebSocketServer`

If your application already manages its own `WebSocketServer`, pass it via the `server` option. A passed server remains owned by the caller and is never closed by the adapter:

```typescript
import { WebSocketServer } from "ws";
import { attachWebSocketAdapter, createRealtimeHub } from "@oneunit/realtime";

const hub = await createRealtimeHub();
const wss = new WebSocketServer({ noServer: true });

const realtime = await attachWebSocketAdapter(server, {
  hub,
  server: wss,
  path: "/ws",
});
```

---

## Transport Adapters

`src/adapter.ts` provides a transport integration layer that decouples socket implementations from the core hub logic.

| Export | Purpose |
| :--- | :--- |
| `createConnectionAdapter(options)` | Constructs an adapter over any socket satisfying `Connection`. |
| `attachWebSocketAdapter(server, options)` | Connects an adapter and wires the `upgrade` listener onto `http.Server`. |
| `matchesPath(url, path)` | Subtree and exact path matcher for WebSocket upgrade requests. |

### `createConnectionAdapter`

```typescript
import { createConnectionAdapter, createRealtimeHub } from "@oneunit/realtime";

const hub = await createRealtimeHub();
const adapter = createConnectionAdapter({
  hub,
  channel: "general",
  onConnection: (conn) => console.log(`Client connected: ${conn.clientId}`),
  onMessage: (msg, conn) => conn.hub.broadcast(conn.channel, msg),
});

// Attach any socket implementing Connection (readyState, send, close)
await adapter.attach(rawSocket, { request });

// Release membership without closing the underlying socket
adapter.release(clientId);

// Terminate all managed sockets
adapter.close();
```

### `attachWebSocketAdapter`

When attached to an `http.Server`, `attachWebSocketAdapter`:
- Listens for HTTP `upgrade` requests on the specified `path`.
- Ignores requests to other paths, allowing other upgrade handlers to coexist.
- Prevents double attachment: attaching twice to the same HTTP server throws a `TypeError`.
- Closes all open connections and removes its listeners when `realtime.close()` is invoked.

### Pre-handshake Refusals

A refused client is handled at the appropriate protocol layer:

| Transport Scenario | Refusal Mechanism | Result |
| :--- | :--- | :--- |
| `attachWebSocketAdapter` (server-managed upgrade) | HTTP `401 Unauthorized` before handshake completes | Zero socket opened; no connection slot or heartbeat cost. |
| Server closed during upgrade | HTTP `503 Service Unavailable` | Zero socket opened. |
| Existing open socket (`adapter.attach(socket)`) | WebSocket Close code `1008` (Policy Violation) | Immediate socket termination. |
| Fastify (`websocketLibrary: "fastify"`) | WebSocket Close code `1008` (`@fastify/websocket` completes upgrade) | Immediate socket termination. |

---

## Fastify Integration

The Fastify plugin (`@oneunit/realtime/plugin` or root) provides effortless integration into Fastify applications.

### Plugin Registration

```typescript
import Fastify from "fastify";
import { registerRealtime } from "@oneunit/realtime";

const app = Fastify({ logger: true });

const hub = await registerRealtime(app, {
  channel: "lobby",
  path: "/ws",
  onConnection: async (connection) => {
    await connection.hub.send(connection, { type: "connected" });
  },
  onMessage: async (message, connection) => {
    await connection.hub.broadcast(connection.channel, message);
  },
});

await app.listen({ port: 3000 });
```

### Library Modes

- `websocketLibrary: "fastify"` (default): Registers `@fastify/websocket` and drives `app.websocketServer`.
- `websocketLibrary: "ws"`: Creates a standalone `ws.WebSocketServer` attached to `app.server`, handling pre-handshake authentication with HTTP 401 refusals.

### Custom Route Handling

For applications that need custom per-route WebSocket logic rather than an automatic catch-all handler, set `attachConnections: false`:

```typescript
const hub = await registerRealtime(app, {
  attachConnections: false,
});

app.get("/ws/rooms/:roomId", { websocket: true }, (socket, req) => {
  const roomId = req.params.roomId;
  void hub.join(roomId, socket);
});
```

---

## Channels and Clients

Channels are lightweight in-memory groupings identified by string names. Clients are representations of active connections.

### Client Queries and Frozen Snapshots

To prevent concurrent state corruption, querying methods return frozen immutable snapshots:

```typescript
// Active participants in a channel
const participants = hub.participants("lobby");

// Total counts
const lobbyCount = hub.channelCount("lobby");
const totalSubscribers = hub.totalSubscribers();
const clientCount = hub.clientCount();

// Channel membership for a client
const channels = hub.channelsFor(clientId);

// Lookup a specific client
const client = hub.client(clientId);
if (client) {
  console.log(client.id, client.metadata, client.channels);
}
```

### Frame Serialization and `decodeMessage`

Hub delivery serializes JavaScript objects to binary using `notepack.io`. Incoming messages from clients can be binary or JSON text. Use `decodeMessage(frame, isBinary)`:

```typescript
import { decodeMessage } from "@oneunit/realtime";

socket.on("message", (data: Buffer, isBinary: boolean) => {
  // Binary: decoded with notepack.io
  // Text: parsed with JSON.parse (falls back to raw string on invalid JSON)
  const message = decodeMessage(data, isBinary);
  console.log("Decoded frame:", message);
});
```

---

## Authentication

Authentication is an asynchronous hook that validates credentials before allowing a connection to enter the hub.

```typescript
const hub = await createRealtimeHub({
  async authenticate({ connection, request }) {
    const authHeader = request?.headers?.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      throw new Error("Missing bearer token");
    }

    const token = authHeader.slice(7);
    const session = await verifyUserToken(token);
    if (!session) {
      throw new Error("Invalid session");
    }

    // Returned object is attached to connection.metadata
    return { userId: session.userId, role: session.role };
  },
});
```

Attach additional metadata to an active connection at runtime using `hub.attachMetadata(clientId, patch)`.

---

## Authorization

Authorization governs fine-grained permissions for operations on the hub:

```typescript
const hub = await createRealtimeHub({
  async authorize({ action, channel, client }) {
    const role = client?.metadata?.role;

    switch (action) {
      case "connect":
        return Boolean(client?.metadata?.userId);
      case "join":
        return channel !== "admin" || role === "admin";
      case "send":
        return role !== "guest";
      case "broadcast":
        return role === "admin" || role === "moderator";
      default:
        return true;
    }
  },
});
```

| Action | Evaluated On | Behavior on Denial |
| :--- | :--- | :--- |
| `connect` | First `join()` for a new connection | Throws `AuthorizationError`; releases connection immediately. |
| `join` | Every channel subscription | Throws `AuthorizationError`; channel is not created or joined. |
| `send` | `send()`, `sendRaw()`, `sendEncrypted()` | Throws `AuthorizationError`; write is skipped. |
| `broadcast` | Publisher authorization before channel fan-out | Throws `AuthorizationError`; broadcast aborted. |
| `leave` | Unsubscription | Never gated (clients can always leave). |

---

## Capacity Limits

Protect your process against denial-of-service and out-of-memory crashes by configuring bounded limits:

```typescript
const hub = await createRealtimeHub({
  limits: {
    maxConnections: 10_000,       // Global connection ceiling (default: Infinity)
    maxClientsPerChannel: 500,    // Per-channel member limit (default: Infinity)
    maxChannelsPerClient: 20,     // Max channels a single client can join (default: Infinity)
    maxMessageSize: 64 * 1024,    // Max encoded frame size (default: 64 KiB)
    maxChannelNameLength: 128,    // Channel identifier length bound (default: 128 chars)
  },
});
```

Exceeding limits throws typed errors: `ConnectionLimitError`, `MessageTooLargeError`, or `ChannelError`.

---

## Heartbeat and Sweeping

A single shared timer sweeps all connections at a configured interval. No per-connection timers are spawned, maintaining $O(N)$ efficiency regardless of connection volume.

```typescript
hub.startHeartbeat({
  intervalMs: 30_000, // Ping interval
  timeoutMs: 60_000,  // Disconnect if no activity for 60s
});

// Check status
console.log("Heartbeat running:", hub.isHeartbeatRunning);

// Stop timer
hub.stopHeartbeat();
```

- Sends protocol `ping()` to transports supporting ping frames.
- Dead peers missing deadlines are terminated with close code `1001` and cleaned up.
- For transports lacking protocol pings (such as browser `WebSocket`), call `hub.touch(clientId)` upon receiving application traffic to reset liveness.
- The heartbeat timer is `unref`'d so it never prevents clean Node process exits.

---

## Adaptive Backpressure

Slow clients cannot stall or crash the hub. Writes to overloaded sockets are skipped, counted, and eventually disconnected:

```typescript
const hub = await createRealtimeHub({
  backpressure: {
    maxBufferedBytes: 1024 * 1024, // 1 MiB threshold on socket.bufferedAmount
    maxConsecutiveDrops: 32,       // Drop allowance before termination
  },
});
```

1. If `connection.bufferedAmount` exceeds `maxBufferedBytes`, write is skipped and `messagesDropped` increments.
2. If consecutive drops reach `maxConsecutiveDrops`, the connection is terminated with close code `1013` (Try Again Later).
3. If `socket.send()` throws, the connection is terminated with close code `1011` (Internal Error).
4. `send()` returns `false` on backpressure failure; `broadcast()` returns the exact number of successful writes. **Delivery never throws.**

---

## Lifecycle and Teardown

Hub shutdown is idempotent and cleans up all state:

```typescript
const hub = await createRealtimeHub();

console.log(hub.isClosed); // false
hub.close();               // Closes all sockets, stops timers, clears maps
hub.close();               // Idempotent: no-op, never throws
```

### Proper Teardown Order

To prevent hung connections when stopping an HTTP server:

1. `await realtime.close()` — Terminate active sockets and detach HTTP upgrade listeners.
2. `hub.close()` — Stop heartbeat timer and release channel tables.
3. `server.close()` — Close HTTP server without hanging.

---

## Typed Error Hierarchy

All errors inherit from `RealtimeError` and carry a machine-readable `code`:

| Error Class | `code` | Description |
| :--- | :--- | :--- |
| `RealtimeError` | `REALTIME_ERROR` | Base class for all package errors. |
| `ConnectionError` | `CONNECTION_ERROR` | Connection is invalid, unusable, or duplicate. |
| `ConnectionClosedError` | `CONNECTION_CLOSED` | Hub or connection is already closed. |
| `AuthenticationError` | `AUTHENTICATION_ERROR` | Authentication hook rejected connection. |
| `AuthorizationError` | `AUTHORIZATION_ERROR` | Authorization hook denied requested action. |
| `ChannelError` | `CHANNEL_ERROR` | Channel name exceeds limit, is empty, or has control chars. |
| `MessageTooLargeError` | `MESSAGE_TOO_LARGE` | Encoded payload exceeds `maxMessageSize`. |
| `ConnectionLimitError` | `CONNECTION_LIMIT` | Capacity threshold reached (`maxConnections`, etc.). |

---

## Observability and Logging

Observability is lightweight and requires no heavy APM or metric libraries:

```typescript
const hub = await createRealtimeHub({
  // Structured event listener
  onEvent: (event) => {
    console.log(`[Event: ${event.name}]`, event);
  },
  // Injected logger (supports console, pino, winston)
  logger: {
    debug: (msg, meta) => console.debug(msg, meta),
    info: (msg, meta) => console.info(msg, meta),
    warn: (msg, meta) => console.warn(msg, meta),
    error: (msg, meta) => console.error(msg, meta),
  },
});
```

Inspect counters at any time using `hub.stats()`:

```typescript
const stats = hub.stats();
console.log({
  connections: stats.connections,
  channels: stats.channels,
  subscribers: stats.subscribers,
  messagesSent: stats.messagesSent,
  messagesDropped: stats.messagesDropped,
  sendFailures: stats.sendFailures,
  authorizationsDenied: stats.authorizationsDenied,
  heartbeatsSent: stats.heartbeatsSent,
  connectionsTerminated: stats.connectionsTerminated,
});
```

---

## End-to-End Encryption (E2EE)

Opt-in encryption module built on Libsodium (X25519 key exchange + XSalsa20-Poly1305 authenticated symmetric encryption):

```typescript
import { createRealtimeHub } from "@oneunit/realtime";

const hub = await createRealtimeHub({ e2ee: true });

// Hub public key
const serverPubKey = hub.e2eePublicKey;

// Register client public key
hub.registerClientKey(connection, clientPublicKeyBase64);

// Send encrypted frame ({ type: "e2ee", ciphertext: "..." })
await hub.sendEncrypted(client, { secret: "confidential message" });

// Decrypt inbound frame from client
const decrypted = hub.decryptFromClient(connection, incomingFrame);
```

### Security Properties and Realistic Limitations

- **Not TLS Replacement**: Does not protect socket metadata; always use `wss://`.
- **Server Visibility**: The server operator can inspect messages if running the hub. E2EE protects against wire observers and unauthorized channel peers.
- **Strict Invariant**: A channel participant without a registered public key is **skipped, never downgraded to plaintext**.
- **Ephemeral**: Keys are stored in-memory; no persistence or key rotation is included.

---

## Horizontal Scaling Pattern

The package is strictly single-process. To scale horizontally across multiple servers, wire an external message broker to the `BroadcastTarget` interface:

```text
         ┌──────────────┐
         │ Event Broker │
         │ (Redis/Kafka)│
         └───────┬──────┘
                 │
       external broker adapter
                 │
    ┌────────────┼────────────┐
    ▼            ▼            ▼
   Hub 1        Hub 2        Hub 3
    │            │            │
  clients      clients      clients
```

```typescript
import type { BroadcastTarget } from "@oneunit/realtime";

// RealtimeHub directly satisfies BroadcastTarget
function wireBrokerSubscriber(broker: AnyBrokerConsumer, hub: BroadcastTarget) {
  broker.onMessage(async (channel, payload) => {
    // Fan out broker messages to local connections
    await hub.broadcast(channel, payload);
  });
}
```

---

## Runnable Examples

The `examples/` directory contains complete, runnable TypeScript examples:

| Script | Command | Description |
| :--- | :--- | :--- |
| `standalone.ts` | `npm run example:standalone` | Plain `node:http` server with pre-handshake upgrade authentication. |
| `chat.ts` | `npm run example:chat` | Fastify chat server with room-based authorization. |
| `client.ts` | `npm run example:client` | Node.js client connecting and interacting with `chat.ts`. |
| `plugin-ws.ts` | `npm run example:plugin-ws` | Fastify integration using `websocketLibrary: "ws"`. |
| `e2ee.ts` | `npm run example:e2ee` | End-to-end encrypted hub server with key exchange. |
| `e2ee-client.ts` | `npm run example:e2ee-client` | Client communicating with `e2ee.ts` over encrypted frames. |
| `adapter.ts` | `npm run example:adapter` | External broker adapter pattern broadcasting across hubs. |

All examples are continuously validated by `test/examples.test.ts` on live ports in CI.

---

## Development and Verification

Run the full verification pipeline before committing:

```bash
# Inside packages/realtime:
npm run verify

# Or step-by-step:
npm run clean
npm run build
npm run typecheck
npm run lint
npm test
npm run pack:check
```

### From Monorepo Root

```bash
pnpm --filter @oneunit/realtime verify
pnpm --filter @oneunit/realtime test
```

---

## Architecture & Contributing

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Detailed architectural decisions, boundary constraints, and trade-offs.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Development guidelines, test suite map, and security rules.
- [CHANGELOG.md](./CHANGELOG.md) — Full release history and migration guide.

---

## License

[MIT](./LICENSE) © 2026 mayank