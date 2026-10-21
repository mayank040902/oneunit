# Realtime (WebSockets)

## Overview & Purpose

The **Realtime Plugin** provides WebSocket and bidirectional streaming support for `@oneunit/server` via the optional peer package `@oneunit/realtime`.

Key capabilities:
- **Fastify Decorator**: Exposes `server.realtime` (the `RealtimeHub`), providing centralized room management, client broadcasting, and connection tracking.
- **WebSocket Route Binding**: Mounts WebSocket routes alongside standard HTTP REST routes under a unified server instance and port.
- **Automated Health Probe**: Registers a `realtime` provider into `server.healthRegistry`.
- **Clean Socket Termination**: Automatically terminates open WebSocket connections during graceful server shutdown.

---

## Installation & Import Requirements

```typescript
import {
  realtimePlugin,
  type RealtimeServerPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { realtimePlugin } from "@oneunit/server/plugins";
```

Optional peer dependency:
```bash
npm install @oneunit/realtime
```

---

## Configuration Options

When configuring `realtime` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `realtime` | `boolean \| RealtimeServerPluginOptions` | `false` | Disabled by default. Set to `true` or pass configuration object to enable. |
| `websocketLibrary` | `"fastify" \| "ws"` | `"fastify"` | Underlying WebSocket engine. |
| `path` | `string` | `"/ws"` | Default WebSocket upgrade path. |
| `channel` | `string` | — | Default channel/topic name. |
| `heartbeat` | `boolean` | `true` | When true, enables automated ping/pong connection liveness checks. |
| `heartbeatInterval`| `number` | `30000` | Milliseconds between ping/pong heartbeats. |
| `maxPayload` | `number` | `1048576` (1MB) | Maximum allowable payload size per message frame. |
| `e2ee` | `boolean` | `false` | Enable end-to-end encryption if supported by RealtimeHub. |
| `routes` | `(app: FastifyInstance) => Promise<void>` | — | Callback function to register custom WebSocket route handlers. |

---

## Usage Examples

### 1. Realtime Server with Rooms and Broadcasting

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "chat-service",
  realtime: {
    websocketLibrary: "fastify",
    path: "/ws",
    heartbeat: true,
    routes: async (server) => {
      // Register custom websocket routes using server.realtime
      server.get("/ws/chat", { websocket: true }, (connection, req) => {
        const hub = (server as any).realtime;

        connection.socket.on("message", (message: string) => {
          const data = JSON.parse(message.toString());
          // Broadcast to everyone in the room
          hub.broadcast("room-1", data);
        });
      });
    },
  },
  configure: (server) => {
    // Normal HTTP routes can also broadcast to WebSockets!
    server.post("/api/alerts", async (request, reply) => {
      const alert = request.body;
      (server as any).realtime.broadcast("alerts", alert);
      return reply.ok({ message: "Alert broadcasted" });
    });
  },
});
```

---

## Common Use Cases & Best Practices

1. **Unified HTTP and WebSocket Port**: Keep your architecture clean by serving REST endpoints and WebSockets on the same port, avoiding CORS issues and eliminating duplicate port configurations.
2. **Authenticate During Upgrade**: Validate authentication tokens (JWT or cookies) in the HTTP upgrade request before establishing the WebSocket connection.
3. **Heartbeat Monitoring**: Enable `heartbeat: true` to detect and disconnect dead client sockets caused by lost Wi-Fi or mobile handoffs.

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@oneunit/realtime` is not installed, `@oneunit/server` logs a warning and proceeds with realtime disabled.
- **Load Balancing**: When scaling across multiple pods, WebSockets require sticky sessions on your reverse proxy (or a Redis-backed pub/sub adapter) to broadcast messages across pods.

---

## Related Features

- [Bootstrap](bootstrap.md)
- [Health Checks](health-checks.md)
- [Graceful Shutdown](graceful-shutdown.md)
