# Bootstrap (`createBootstrapServer`, `startBootstrapServer`, `createServer`, `startServer`)

## Overview & Purpose

The **Bootstrap** module is the central orchestrator of `@oneunit/server`. It provides an enterprise-ready Fastify server container that handles:
- Deterministic 8-phase plugin registration, preventing dependency order issues (e.g., registering authentication or error handlers before routes).
- Automated `.env` configuration resolution with fallback defaults.
- Integrated health check registration and system metrics.
- Comprehensive request and server lifecycle hook installation.
- Bounded graceful shutdown with active connection draining to prevent hanging keep-alive sockets during deploys or terminations.

Two primary entry points are exposed, each with convenience aliases:
- **`startServer` / `startBootstrapServer`**: Configures all plugins, binds to the network port, installs process signal handlers (if opt-in), and returns running server details along with an idempotent `close()` method.
- **`createServer` / `createBootstrapServer`**: Configures all plugins, hooks, and routes identically to `startServer`, but does **not** call `app.listen()`. This provides an immediate `FastifyInstance` ready for testing with `app.inject()` without consuming network ports.

---

## Architecture & How It Works

When `createBootstrapServer(options)` is invoked, it executes the following deterministic initialization pipeline:

1. **Environment Loading**: If `env !== false`, loads `.env` and `.env.<NODE_ENV>` via `dotenv`.
2. **Service Config Resolution**: Computes fallback defaults (`port`, `host`, `serviceName`, `nodeEnv`) using `serviceConfig`.
3. **Fastify Initialization**: Creates the raw `fastify({...})` instance, setting the default logger based on whether the environment is test or production.
4. **Health Registry Initialization**: Injects the central `HealthRegistry` onto `server.healthRegistry` early, allowing subsequent infrastructure plugins to attach readiness checks.
5. **System Health Provider**: Registers OS CPU and memory metrics providers (unless `health: false`).
6. **Hook Registration**: Installs custom lifecycle hooks supplied via `options.hooks`.
7. **Builtin Plugin Registration**: Merges options and registers all builtin plugins in an 8-phase order.
8. **Health Route Registration**: If `health !== false`, mounts the aggregated `GET /health` endpoint.
9. **Application Plugins**: Iterates through custom plugins provided in `plugins` (if array) and `extraPlugins`.
10. **Post-Plugin Configurer**: Awaits the `configure(server)` callback for custom route definitions and final decorations.
11. **Bounded Close Installation**: Wraps `server.close()` with `installBoundedClose` to enforce socket termination deadlines.

---

## Installation & Import Requirements

```typescript
import {
  createServer,
  startServer,
  createBootstrapServer,
  startBootstrapServer,
  type BootstrapServerOptions,
  type StartedBootstrapServer,
} from "@oneunit/server";

// Alternatively from subpath:
import {
  createServer,
  startServer,
} from "@oneunit/server/bootstrap";
```

Runtime dependency: `fastify`. All sibling packages (`@oneunit/logger`, `@oneunit/database`, etc.) are optional peers.

---

## Configuration Options

`BootstrapServerOptions` supports the following properties:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `port` | `number` | `8080` (or `PORT` env) | Port to bind the server to |
| `host` | `string` | `"127.0.0.1"` (or `HOST` env) | Host interface to bind to |
| `serviceName` | `string` | `"app"` (or `SERVICE_NAME` env) | Logical service identifier used in logs, health checks, and metrics |
| `fastify` | `FastifyServerOptions` | `{}` | Direct configuration passed to `fastify({...})` |
| `listen` | `FastifyListenOptions` | — | Overrides `host`/`port` directly when calling `app.listen()` |
| `env` | `false \| LoadEnvOptions` | `{}` | Dotenv loading options, or `false` to completely disable `.env` file reads |
| `gracefulShutdown` | `boolean` | `false` | When true, binds `SIGINT` and `SIGTERM` handlers to cleanly close the server |
| `shutdownTimeout` | `number` | `10000` | Max milliseconds to wait for in-flight requests during shutdown before forcing socket close |
| `health` | `boolean \| BootstrapHealthOptions` | `true` | Health endpoint configuration (`path`, `serviceName`, `includeDetails`), or `false` to disable |
| `hooks` | `BootstrapHooks` | `{}` | Declarative Fastify lifecycle hooks (`onRequest`, `preHandler`, etc.) |
| `plugins` | `PluginEntry[] \| BuiltinPluginsOptions` | — | Array of custom Fastify plugins, OR object overriding builtin plugin configs |
| `extraPlugins` | `PluginEntry[]` | `[]` | Additional custom plugins (safe to use alongside object-form `plugins`) |
| `configure` | `(server: FastifyInstance) => void \| Promise<void>` | — | Callback invoked after all builtin and application plugins are registered |
| *Builtin Plugins* | `PluginConfig<T>` | *Defaults vary* | `cors`, `helmet`, `cookie`, `compress`, `rateLimit`, `zod`, `responseManagement`, `logger`, `database`, `redis`, `kafka`, `realtime`, `errorHandler`, `msgpack`, `requestContext`, `multipart`, `csrf`, `underPressure`, `swagger`, `swaggerUI` |

---

## Usage Examples

### 1. Production Server Startup

```typescript
import { startServer } from "@oneunit/server";

const { app, address, port, host, close } = await startServer({
  serviceName: "payment-api",
  port: 3000,
  host: "0.0.0.0",
  gracefulShutdown: true,
  shutdownTimeout: 5000,
  logger: {
    useHttpLogger: true,
  },
  cors: {
    origin: ["https://checkout.example.com"],
    credentials: true,
  },
  configure: async (server) => {
    server.get("/api/v1/ping", async (req, reply) => {
      return reply.ok({ data: { status: "alive" } });
    });
  },
});

console.log(`Server running at ${address} (bound to ${host}:${port})`);
```

### 2. Testing with `createServer` and Fastify `.inject()`

```typescript
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createServer } from "@oneunit/server";
import type { FastifyInstance } from "fastify";

describe("Users API", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createServer({
      serviceName: "test-service",
      env: false,        // Avoid loading real .env in tests
      logger: false,     // Keep test logs clean
      health: false,     // Skip default /health route if not needed
      configure: (server) => {
        server.get("/users/:id", async (req, reply) => {
          return reply.ok({ data: { id: req.params.id, name: "Alice" } });
        });
      },
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns user details", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/users/42",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ id: "42", name: "Alice" });
  });
});
```

### 3. Custom Application Plugins

```typescript
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { startServer } from "@oneunit/server";

const metricsPlugin = fp(async (server: FastifyInstance) => {
  server.decorate("metrics", { count: 0 });
  server.addHook("onRequest", async () => {
    server.metrics.count++;
  });
});

await startServer({
  plugins: [metricsPlugin],
  configure: (server) => {
    server.get("/metrics", async () => ({ requests: server.metrics.count }));
  },
});
```

---

## Implementation Details & Return Values

### `startBootstrapServer` Return Object

```typescript
interface StartedBootstrapServer {
  app: FastifyInstance;   // The underlying Fastify instance
  address: string;         // Address string formatted by Fastify (e.g., "http://127.0.0.1:8080")
  port: number;           // Actual bound port (useful when port 0 is passed)
  host: string;           // Actual bound host IP
  close(): Promise<void>; // Idempotent shutdown method that stops listener and closes sockets
}
```

### Bounded Close Behavior
By default, standard Node.js HTTP servers will hang on `server.close()` if clients maintain persistent HTTP keep-alive connections. `@oneunit/server` installs bounded close handlers that:
1. Stop accepting new connections.
2. Allow in-flight requests to finish.
3. Actively destroy idle keep-alive connections on an interval.
4. If requests exceed `shutdownTimeout` (default 10s), forcefully destroys remaining active sockets.

---

## Common Use Cases & Best Practices

1. **Use `createServer` for Unit/Integration Tests**: Fastify's `.inject()` performs simulated HTTP requests in-memory without binding TCP ports, avoiding port conflicts in parallel CI test runs.
2. **Explicitly Disable Unneeded Peers in Tests**: Set `database: false`, `redis: false`, `kafka: false`, `realtime: false` in test setups where external containers are not running.
3. **Keep `configure(app)` Focused on Routes**: Use `configure` for route definitions and controller attachment. For reusable middleware or decorators, write modular plugins and pass them into `plugins` or `extraPlugins`.
4. **Use Port 0 for Dynamic Binding**: Passing `port: 0` allows the operating system to allocate any available free port, accessible via the returned `port` property.

---

## Edge Cases & Troubleshooting

- **`plugins` Array vs Object**: If `plugins` is an array (`PluginEntry[]`), it is treated as a list of application plugins. If it is an object, it is treated as overrides for builtin plugins (`BuiltinPluginsOptions`). If you need both, use `plugins` for builtin overrides and `extraPlugins` for custom Fastify plugins.
- **Port Conflicts**: If the port is already in use (`EADDRINUSE`), `startBootstrapServer` rejects with Fastify's network error.
- **Process Signal Handlers**: Signal handling (`SIGINT`/`SIGTERM`) is opt-in via `gracefulShutdown: true`. If your orchestrator (Kubernetes, AWS ECS) sends SIGTERM, enable this option so the server shuts down cleanly without dropping traffic.

---

## Related Features

- [Configuration and Environment](configuration-and-environment.md)
- [Graceful Shutdown](graceful-shutdown.md)
- [Lifecycle Hooks](hooks.md)
- [Health Checks](health-checks.md)
