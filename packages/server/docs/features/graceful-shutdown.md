# Graceful and Bounded Shutdown

## Overview & Purpose

In production environments (Kubernetes, AWS ECS, Docker Swarm), services frequently receive termination signals (`SIGINT` or `SIGTERM`) during zero-downtime rolling deploys, autoscaling events, or restarts.

In Node.js, standard `server.close()` stops accepting new TCP connections, but **does not** close active keep-alive HTTP connections. If clients (browsers, proxies, API gateways) hold keep-alive sockets open, `await app.close()` hangs indefinitely, causing container orchestrators to forcefully kill the process (`SIGKILL`) and drop in-flight user requests.

The **Graceful and Bounded Shutdown** feature in `@oneunit/server` solves this by:
1. Stopping the HTTP listener immediately to prevent new incoming connections.
2. Continuously polling and closing sockets as soon as they become idle (`closeIdleConnections()`).
3. Enforcing a hard timeout deadline (`shutdownTimeout`, default 10,000ms). If any in-flight requests take longer than the deadline, remaining connections are severed (`closeAllConnections()`), ensuring the process always terminates cleanly.
4. Hooking `SIGINT` and `SIGTERM` signals automatically when `gracefulShutdown: true` is configured.

---

## Architecture & How It Works

```
Shutdown Signal (SIGINT / SIGTERM) or app.close()
  │
  ▼
1. Stop listener (`server.close()`)
  │ (No new TCP connections accepted)
  │
  ▼
2. Start Poller (`setInterval` every 25ms)
  │  calls `server.closeIdleConnections()`
  │  (As soon as an in-flight request finishes, its keep-alive socket is closed)
  │
  ├─ If all sockets close within timeout:
  │   ▼
  │   Poller cleared, all plugins close cleanly, process exits 0.
  │
  └─ If requests exceed `shutdownTimeout` (e.g. 10s):
      ▼
      Deadline fires: calls `server.closeAllConnections()`
      Remaining connections forcefully aborted, process exits 0.
```

---

## Installation & Import Requirements

```typescript
import {
  startServer,
  createServer,
  closeWithDeadline,
  installBoundedClose,
  DEFAULT_CLOSE_TIMEOUT_MS,
  type BoundedCloseOptions,
} from "@oneunit/server";

// Alternatively from subpath:
import {
  closeWithDeadline,
  installBoundedClose,
} from "@oneunit/server/lib";
```

---

## Configuration Options

When configuring `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `gracefulShutdown` | `boolean` | `false` | When true, automatically registers `process.once("SIGINT")` and `process.once("SIGTERM")` handlers that trigger graceful close followed by `process.exit(0)`. |
| `shutdownTimeout` | `number` | `10000` (10s) | Time in milliseconds the server waits for in-flight requests to complete before dropping remaining connections. |

For manual helper `closeWithDeadline`:

```typescript
interface BoundedCloseOptions {
  /** Time to wait for the drain before sockets are dropped. Default: 10000ms */
  timeoutMs?: number;
  /** How often (in ms) to poll and close idle connections. Default: 25ms */
  pollIntervalMs?: number;
}
```

---

## Usage Examples

### 1. Opt-In Automatic Process Signal Handling

```typescript
import { startServer } from "@oneunit/server";

const { app, address } = await startServer({
  port: 8080,
  gracefulShutdown: true, // Enables SIGINT & SIGTERM handling
  shutdownTimeout: 5000,  // Max 5 seconds for in-flight requests
  configure: (server) => {
    server.get("/long-operation", async (req, reply) => {
      // In-flight requests have up to 5s to complete during deploy
      await new Promise((res) => setTimeout(res, 2000));
      return reply.ok({ status: "finished" });
    });
  },
});

console.log(`Server running at ${address}. Press Ctrl+C to test graceful shutdown.`);
```

### 2. Manual Programmatic Shutdown in Tests or Scripts

```typescript
import { createServer } from "@oneunit/server";

const app = await createServer({ shutdownTimeout: 2000 });
await app.ready();

// Bounded close is already installed by bootstrap:
await app.close();
console.log("Server closed safely without hanging");
```

### 3. Applying Bounded Close to Existing Fastify Instances

If you have an existing Fastify instance not instantiated via `@oneunit/server` bootstrap:

```typescript
import fastify from "fastify";
import { closeWithDeadline, installBoundedClose } from "@oneunit/server/lib";

const app = fastify();

// Method A: Modify the app instance
installBoundedClose(app, { timeoutMs: 5000 });
await app.close();

// Method B: One-shot bounded close
await closeWithDeadline(app, { timeoutMs: 5000 });
```

---

## Common Use Cases & Best Practices

1. **Always Enable in Orchestrated Environments**: In Kubernetes or Docker containers, set `gracefulShutdown: true`. Kubernetes sends `SIGTERM`, waits for `terminationGracePeriodSeconds` (default 30s), then sends `SIGKILL`. Setting `shutdownTimeout: 10000` allows clean termination well before Kubernetes sends `SIGKILL`.
2. **Combine with Upstream Load Balancers**: Before shutting down, ensure orchestrator health probes detect the terminating state so traffic stops routing to this pod.
3. **Keep `onClose` Hooks Fast**: Database, Redis, and Kafka connection closures run inside Fastify's `onClose` hook. Keep teardown operations bounded and fast.

---

## Edge Cases & Limitations

- **Forceful Connection Severing**: If an active request exceeds `shutdownTimeout`, the socket is destroyed and the client receives a network error (`ECONNRESET`). Adjust `shutdownTimeout` if your application legitimately handles long-lived requests (e.g., large file uploads or report exports).
- **Process Signal Handling**: Signal listeners are process-global. Calling `startServer` multiple times in the same process with `gracefulShutdown: true` will register multiple signal listeners; only enable `gracefulShutdown: true` on the primary server entry point.
- **Idempotency**: Calling `app.close()` multiple times is safe and returns the same shutdown promise.

---

## Related Features

- [Bootstrap](bootstrap.md)
- [Lifecycle Hooks](hooks.md)
- [Database](database.md)
- [Kafka](kafka.md)
