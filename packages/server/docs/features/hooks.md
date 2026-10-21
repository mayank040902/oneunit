# Lifecycle Hooks

## Overview & Purpose

The **Hooks** system provides declarative registration of Fastify's request and server lifecycle handlers through the `hooks` option in `BootstrapServerOptions`.

Rather than manually chaining multiple `server.addHook(...)` statements across disparate files, `@oneunit/server` normalizes hook registration:
- Supports either a single handler function or an array of handlers (`HookList<T> = T | T[]`) for every hook.
- Enforces proper execution order: hooks registered via `hooks` run after all framework and security plugins have initialized.
- Covers the full Fastify lifecycle: 10 request-phase hooks and 5 server-level lifecycle hooks.

---

## Fastify Lifecycle Sequence

### Request Lifecycle
```
Incoming Request
  │
  ▼
[onRequest]               ── Headers parsed, initial request inspection
  │
  ▼
[preParsing]             ── Payload streams, custom decoders (e.g. msgpack)
  │
  ▼
[preValidation]          ── Before route validation runs
  │
  ▼
[preHandler]             ── Route auth, permission checks, rate limit validations
  │
  ▼
  Handler executes
  │
  ▼
[preSerialization]       ── Transform response data before JSON/msgpack serialization
  │
  ▼
[onSend]                 ── Modify serialized payload (compression, headers)
  │
  ▼
[onResponse]             ── Response sent to client; access logging, metrics
  │
  └─ If Error: [onError] ── Error interception
  └─ If Timeout: [onTimeout]
  └─ If Aborted: [onRequestAbort]
```

### Server Lifecycle
- `onReady`: Server and all plugins are registered and compiled.
- `onListen`: Listening port/socket is open and accepting traffic.
- `onRoute`: Fired synchronously every time a new route is registered.
- `onRegister`: Fired synchronously every time a plugin is encapsulated.
- `onClose`: Triggered during server shutdown for resource cleanup.

---

## Installation & Import Requirements

```typescript
import {
  registerHooks,
  registerRequestHooks,
  registerServerHooks,
  type BootstrapHooks,
  type HookList,
} from "@oneunit/server";

// Alternatively from subpath:
import {
  registerHooks,
  type BootstrapHooks,
} from "@oneunit/server/hooks";
```

---

## Configuration Options

`BootstrapHooks` accepts all standard Fastify lifecycle handlers as single functions or arrays:

| Hook Name | Type | Description |
| :--- | :--- | :--- |
| **`onRequest`** | `HookList<onRequestHookHandler>` | First hook on incoming request. Great for correlation IDs and request timing. |
| **`preParsing`** | `HookList<preParsingHookHandler>` | Executed before parsing the payload stream. |
| **`preValidation`** | `HookList<preValidationHookHandler>` | Executed after parsing the body, but before route schema validation. |
| **`preHandler`** | `HookList<preHandlerHookHandler>` | Executed before the route handler. Ideal for authentication and role authorization. |
| **`preSerialization`** | `HookList<preSerializationHookHandler>` | Executed before serializing the reply payload. |
| **`onSend`** | `HookList<onSendHookHandler>` | Executed before transmitting the raw payload over the socket. |
| **`onResponse`** | `HookList<onResponseHookHandler>` | Executed after the response is completely sent. Ideal for access logs and latency metrics. |
| **`onError`** | `HookList<onErrorHookHandler>` | Executed when an unhandled error is thrown during request handling. |
| **`onTimeout`** | `HookList<onTimeoutHookHandler>` | Executed when a request exceeds Fastify's connection timeout. |
| **`onRequestAbort`** | `HookList<onRequestAbortHookHandler>` | Executed when the client closes the connection prematurely. |
| **`onReady`** | `HookList<onReadyHookHandler>` | Executed when the server instance is completely ready to listen. |
| **`onListen`** | `HookList<onListenHookHandler>` | Executed when the network socket starts listening. |
| **`onClose`** | `HookList<onCloseHookHandler>` | Executed when `app.close()` is initiated. Used for teardown. |
| **`onRoute`** | `HookList<onRouteHookHandler>` | Executed synchronously when a route is defined. |
| **`onRegister`** | `HookList<onRegisterHookHandler>` | Executed synchronously when a plugin is registered. |

---

## Usage Examples

### 1. Request Timing & Correlation ID Hook

```typescript
import { startServer, type BootstrapHooks } from "@oneunit/server";
import { randomUUID } from "node:crypto";

const hooks: BootstrapHooks = {
  onRequest: async (request, reply) => {
    // Attach or forward trace ID
    const correlationId = request.headers["x-correlation-id"] || randomUUID();
    reply.header("x-correlation-id", correlationId);
    (request as any).startTime = process.hrtime.bigint();
  },

  onResponse: async (request, reply) => {
    const startTime = (request as any).startTime as bigint;
    if (startTime) {
      const elapsedMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      request.log.info({
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        latencyMs: elapsedMs.toFixed(2),
      }, "Request completed");
    }
  },
};

await startServer({
  serviceName: "api-gateway",
  hooks,
});
```

### 2. Multi-Stage Handlers with Arrays (`HookList`)

```typescript
import { createServer } from "@oneunit/server";

const app = await createServer({
  hooks: {
    preHandler: [
      // Handler 1: Authenticate token
      async (request, reply) => {
        const token = request.headers.authorization;
        if (!token && request.url.startsWith("/api/secure")) {
          return reply.unauthorized({ message: "Missing authorization token" });
        }
      },
      // Handler 2: Audit log
      async (request) => {
        if (request.url.startsWith("/api/secure")) {
          request.log.info("Accessed secure endpoint");
        }
      },
    ],
  },
  configure: (server) => {
    server.get("/api/secure/data", async () => ({ secret: "42" }));
  },
});
```

### 3. Server Startup & Teardown Lifecycle Hooks

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  hooks: {
    onReady: async () => {
      console.log("All schemas and plugins registered. Initializing in-memory cache...");
      await warmCache();
    },
    onListen: async () => {
      console.log("Listening socket active and accepting traffic.");
    },
    onClose: async (instance) => {
      console.log("Shutting down external worker threads...");
      await stopWorkers();
    },
  },
});
```

---

## Common Use Cases & Best Practices

1. **Use `onRequest` for Context & Metadata**: Set headers and request IDs in `onRequest` so downstream plugins and error handlers can read them.
2. **Use `preHandler` for Security Guards**: Place JWT authentication and role checks in `preHandler`. If you return a reply inside `preHandler` (e.g. `reply.unauthorized()`), Fastify aborts the rest of the execution chain immediately.
3. **Keep `onResponse` Non-Blocking**: Do not perform slow asynchronous database calls in `onResponse`, as it will delay socket cleanup.
4. **Use Arrays for Independent Concerns**: When combining cross-cutting logic (e.g., rate limit checks, tracing, header injection), separate them into clean discrete functions passed as an array to `preHandler`.

---

## Edge Cases & Limitations

- **Short-Circuiting**: Returning a value or calling `reply.send()` inside `onRequest`, `preParsing`, `preValidation`, or `preHandler` terminates the lifecycle and prevents subsequent hooks and route handlers from running.
- **Hook Exceptions**: Any uncaught rejection in an async hook jumps directly to the `onError` hook and the global error handler.
- **Payload Immutability in `onSend`**: `onSend` handlers must return the payload (either original or transformed string/Buffer). Forgetting to return a payload will result in an empty response body.

---

## Related Features

- [Bootstrap](bootstrap.md)
- [Error Handling](error-handling.md)
- [Logging](logging.md)
- [Graceful Shutdown](graceful-shutdown.md)
