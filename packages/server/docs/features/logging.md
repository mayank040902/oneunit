# Structured Logging

## Overview & Purpose

The **Logger Plugin** integrates `@oneunit/server` with the enterprise `@oneunit/logger` package, decorating Fastify with high-performance, structured JSON logging powered by Pino.

Key capabilities:
- **Service-Aware Child Bindings**: Injects `{ service: serviceName }` and caller-provided child bindings into every single log line automatically.
- **Fastify Instance & Request Decorators**: Replaces `server.log` and decorates `server.logger`, ensuring both server-level logs and per-request `request.log` use identical formatting and levels.
- **Custom Serializers**: Sanitizes and formats complex objects (incoming HTTP requests, response objects, headers, error traces) before output.
- **Graceful Fallback**: If `@oneunit/logger` is not installed, logs a warning and cleanly falls back to Fastify's native Pino logger without interrupting startup.

---

## Installation & Import Requirements

```typescript
import {
  loggerPlugin,
  type LoggerPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { loggerPlugin } from "@oneunit/server/plugins";
```

Optional peer dependency:
```bash
npm install @oneunit/logger
```

---

## Configuration Options

When configuring `logger` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `useHttpLogger` | `boolean` | `true` | When true, enables Fastify's automated request and response cycle logging. |
| `serviceName` | `string` | `options.serviceName` | Service identifier appended to every log entry under `service`. Defaults to the bootstrap service name. |
| `mode` | `"development" \| "production" \| "test"` | `NODE_ENV` | Logging mode. Development uses human-readable pretty-printing; production uses raw NDJSON. |
| `childBindings` | `Record<string, unknown>` | `{}` | Key-value pairs attached to every log line (e.g. `env`, `region`, `version`). |
| `serializers` | `Record<string, unknown>` | `{}` | Custom Pino serializer functions for redacting or formatting fields. |
| `pino` | `Record<string, unknown>` | `{}` | Direct low-level options forwarded directly to Pino. |

To completely disable logging (e.g., in unit tests):
```typescript
const app = await createServer({ logger: false });
```

---

## Usage Examples

### 1. Production Configuration with Custom Bindings

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "billing-service",
  logger: {
    useHttpLogger: true,
    childBindings: {
      environment: process.env.NODE_ENV,
      region: process.env.AWS_REGION || "us-east-1",
      commitHash: process.env.GIT_COMMIT,
    },
    serializers: {
      // Redact sensitive headers
      req(req) {
        return {
          method: req.method,
          url: req.url,
          headers: {
            ...req.headers,
            authorization: req.headers.authorization ? "[REDACTED]" : undefined,
          },
        };
      },
    },
  },
  configure: (server) => {
    server.post("/charge", async (request, reply) => {
      // request.log automatically includes service, region, requestId, etc.
      request.log.info({ amount: 5000, currency: "USD" }, "Processing payment");
      return reply.ok({ data: { status: "processed" } });
    });
  },
});
```

### 2. Using `server.log` vs `request.log`

```typescript
// Server-level logs (background jobs, lifecycle events)
server.log.info("Cron job started");

// Request-level logs (automatically contains request id and route context)
server.get("/items", async (request, reply) => {
  request.log.debug("Fetching items from cache");
  return reply.ok({ data: [] });
});
```

---

## Common Use Cases & Best Practices

1. **Keep `serviceName` Consistent**: Ensure `serviceName` in bootstrap matches across your observability stack (Elasticsearch, Datadog, Grafana Loki).
2. **Never Log Plaintext Credentials**: Use Pino serializers or `redactDetails` in the error handler to strip tokens, credit card numbers, and passwords.
3. **Use Appropriate Log Levels**:
   - `trace` / `debug`: Fine-grained troubleshooting (disabled in production).
   - `info`: Key business transactions and startup lifecycle events.
   - `warn`: Recoverable issues, 4xx client errors, retries.
   - `error`: Uncaught exceptions, 5xx server errors, dependency drops.
   - `fatal`: Process crash or unrecoverable system failure.

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@oneunit/logger` is missing, `@oneunit/server` does not throw an error; it falls back to standard Fastify logger configuration.
- **Log Buffering**: Under extreme I/O load, synchronous disk writes can block the event loop. In high-throughput production services, configure asynchronous logging streams through pino transport.

---

## Related Features

- [Bootstrap](bootstrap.md)
- [Error Handling](error-handling.md)
- [Request Context](request-context.md)
