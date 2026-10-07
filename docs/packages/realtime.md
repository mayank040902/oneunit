# @bootstrap-framework/realtime

Local realtime connection management: channels, fan-out, backpressure,
heartbeats, limits, auth hooks, E2EE helpers, a transport adapter, and an
optional Fastify plugin.

`ws` is a runtime dependency of the adapter; `fastify` and `@fastify/websocket`
are optional peers. **Event brokers stay in the application, behind an adapter.**
Kafka, Redis and NATS are not part of this package and it ships no broker client.

Package README: `packages/realtime/README.md`
Design notes: `packages/realtime/ARCHITECTURE.md`

## Install

```bash
npm install @bootstrap-framework/realtime
npm install fastify @fastify/websocket   # only for the Fastify plugin
```

## Quick start

```javascript
import Fastify from "fastify";
import { registerRealtime, type Connection } from "@bootstrap-framework/realtime";

const app = Fastify({ logger: true });

const hub = await registerRealtime(app, {
    // This app defines its own routes, so it joins explicitly.
    attachConnections: false,
    routes: async (server) => {
        server.get("/ws/room", { websocket: true }, async (socket, request) => {
            const room = String(request.query?.room ?? "general");
            const client = await hub.join(room, {
                connection: socket as unknown as Connection,
            });

            socket.on("close", () => {
                void hub.disconnect(client.id);
            });
        });
    },
});

await app.listen({ port: 4002 });
```

Membership and delivery are asynchronous because authentication and
authorization hooks may be asynchronous.

`import "@bootstrap-framework/realtime/fastify"` adds the `app.realtime` type.

## Transport adapter

The same integration works without Fastify, and the Fastify plugin is a binding
over it rather than a separate implementation.

```javascript
import { createServer } from "node:http";
import { attachWebSocketAdapter, createRealtimeHub } from "@bootstrap-framework/realtime";

const hub = await createRealtimeHub({ authenticate: verifyFromRequest });
const server = createServer();

const realtime = await attachWebSocketAdapter(server, {
    hub,
    path: "/ws",              // default "/ws"; children match too
    channel: "lobby",
    onMessage: (message, connection) =>
        connection.hub.broadcast(connection.channel, { type: "relay", payload: message }),
});

server.listen(4002);

// Sockets first, then the hub, then the HTTP server.
await realtime.close();
hub.close();
```

| Export | Purpose |
| :--- | :--- |
| `attachWebSocketAdapter(server, options)` | Adapter plus the `ws` upgrade on `node:http` / `node:https` |
| `createConnectionAdapter(options)` | Adapter alone, for a transport you already own |
| `matchesPath(url, path)` | Upgrade path matching |

Refusals match the protocol: a peer this adapter refuses before its handshake gets
`401`, while a transport that has already handshaken (`server`, or
`@fastify/websocket`) gets a `1008` close. A `ws` server passed as `server` is
yours and is never closed by `realtime.close()`.

## Plugin options

| Option | Default | Description |
| :--- | :--- | :--- |
| `attachConnections` | `true` | Join and route every accepted socket |
| `routes` | – | Registers your WebSocket routes |
| `websocketLibrary` | `"fastify"` | `"fastify"` or `"ws"` |
| `path` | `"/ws"` | Upgrade prefix in `"ws"` mode |
| `channel` | `"default"` | Channel joined by every accepted socket |
| `e2ee` | `false` | Generate the hub key pair during registration |
| `maxPayload` | `1048576` | Largest accepted frame |
| `heartbeat` / `heartbeatInterval` | `true` / `30000` | Dead-peer detection |
| `limits` / `backpressure` | see below | Capacity and delivery bounds |
| `authenticate` / `authorize` | – | Async hooks; throw or return `false` to deny |
| `onConnection` / `onMessage` | – | Connection and frame hooks |
| `onEvent` / `logger` | – | Observability; logging stays optional |

## Hub API

Every membership and delivery method returns a promise.

| Method | Description |
| :--- | :--- |
| `authenticate(context)` | Run the auth hook, return metadata for `join` |
| `join(channelName, { id, connection, metadata })` | Add a connection to a channel; idempotent |
| `leave(channelName, clientId)` | Remove one membership; releases a client holding no channel |
| `disconnect(clientId)` | Leave every channel and close the connection |
| `send(target, message)` | Send to one connection or client |
| `broadcast(channelName, message, opts?)` | Fan out; returns how many were written |
| `sendRaw` / `broadcastRaw` | Send a pre-encoded frame |
| `sendEncrypted` / `broadcastEncrypted` | Per-recipient libsodium encryption |
| `registerClientKey` / `encryptForClient` / `decryptFromClient` | E2EE key registry and custom wire formats |
| `participants` / `channelCount` / `totalSubscribers` / `clientCount` | Frozen snapshots, never internal state |
| `startHeartbeat()` / `stopHeartbeat()` / `touch(id)` | Shared liveness timer |
| `stats()` | Connections, channels, deliveries, drops, rejections |
| `close()` | Idempotent: closes sockets, stops timers, clears state |

`broadcast` options: `exclude`, `include`, `metadata`, `authorizeRecipients`.

## Limits and errors

`limits`: `maxConnections`, `maxClientsPerChannel`, `maxChannelsPerClient`,
`maxMessageSize` (64 KiB), `maxChannelNameLength` (128).

`backpressure`: `maxBufferedBytes` (1 MiB), `maxConsecutiveDrops` (32). Byte
accounting needs `bufferedAmount`, which `ws` provides and the browser
`WebSocket` API does not.

Typed errors in `@bootstrap-framework/realtime`: `RealtimeError`,
`ConnectionError`, `ConnectionClosedError`, `ChannelError`, `AuthenticationError`,
`AuthorizationError`, `MessageTooLargeError`, `ConnectionLimitError`. Each has a
`code`.

## Other exports

| Export | Description |
| :--- | :--- |
| `registerRealtime(app, options?)` | Fastify plugin, decorates `app.realtime` |
| `createRealtimeHub(options?)` | Standalone hub factory |
| `attachWebSocketAdapter(server, options?)` | Hub on a plain HTTP server, auth before the handshake |
| `createConnectionAdapter(options?)` | Transport adapter over the `Connection` contract |
| `matchesPath(url, path)` | Upgrade path matching |
| `decodeMessage(frame, isBinary?)` | Decode a notepack binary frame or a JSON text frame |
| `e2eeReady()` | Await libsodium before using E2EE helpers |
| `generateKeyPair` / `encrypt` / `decrypt` | E2EE helpers |

Subpaths: `/hub`, `/adapter`, `/plugin`, `/fastify`, `/e2ee`.

## Scaling

```text
         ┌──────────────┐
         │ Event Broker │
         └───────┬──────┘
                 │
      external realtime adapter
                 │
   ┌─────────────┼─────────────┐
   ▼             ▼             ▼
  RT1           RT2           RT3
```

An adapter consumes from the broker and calls `hub.broadcast(channel, message)`.
That is the whole contract: `BroadcastTarget`. Use `wss://` in production,
authenticate before joining private channels, and keep `maxPayload` low. See
`docs/security.md`.