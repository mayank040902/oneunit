# Request Context

## Overview & Purpose

The **Request Context** plugin provides asynchronous request-scoped storage backed by Node.js's native `AsyncLocalStorage` via `@fastify/request-context`.

It enables services to store and retrieve contextual data (such as trace IDs, authenticated user identity, tenant IDs, and transaction scopes) across asynchronous function calls, helper methods, database queries, and background promises without having to pass the `request` object down through every layer of the application call stack.

---

## Architecture & How It Works

1. During Fastify's `onRequest` lifecycle phase, the plugin initializes an isolated `AsyncLocalStorage` store unique to that HTTP request.
2. The store is exposed via `request.requestContext`.
3. You can set values at the HTTP boundary (in hooks or middleware) using `request.requestContext.set(key, value)`.
4. Any deeply nested function down the asynchronous call stack can retrieve these values via `request.requestContext.get(key)`.

---

## Installation & Import Requirements

```typescript
import {
  requestContextPlugin,
  type RequestContextPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { requestContextPlugin } from "@oneunit/server/plugins";
```

Optional peer dependency:
```bash
npm install @fastify/request-context
```

---

## Configuration Options

When configuring `requestContext` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `requestContext` | `boolean \| RequestContextPluginOptions` | `true` | Enabled by default. Set to `false` to disable. |
| `key` | `string` | `"requestContext"` | Fastify request decoration key. |

---

## Usage Examples

### 1. Propagating Tenant and User Context to Services

```typescript
import { startServer } from "@oneunit/server";

// Reusable business service with no Fastify dependencies
class OrderService {
  async processOrder(orderId: string, context: any) {
    const tenantId = context.get("tenantId");
    const userId = context.get("userId");
    console.log(`Processing order ${orderId} for user ${userId} in tenant ${tenantId}`);
  }
}

const orderService = new OrderService();

const { app } = await startServer({
  requestContext: true,
  configure: (server) => {
    // Populate context in an early hook
    server.addHook("onRequest", async (request) => {
      const tenantId = request.headers["x-tenant-id"] || "default-tenant";
      const userId = request.headers["x-user-id"] || "anonymous";

      request.requestContext.set("tenantId", tenantId);
      request.requestContext.set("userId", userId);
    });

    server.post("/orders/:id", async (request, reply) => {
      // Pass the request context down to business logic
      await orderService.processOrder(request.params.id, request.requestContext);
      return reply.ok({ message: "Order processed" });
    });
  },
});
```

---

## Common Use Cases & Best Practices

1. **Distributed Tracing & Correlation IDs**: Inject `correlationId` into `requestContext` on request entry, and read it in database query interceptors to tag SQL queries with the originating request ID.
2. **Multi-Tenancy Isolation**: Store `tenantId` in context to ensure database repositories automatically filter data by tenant without requiring explicit parameters on every repository method.
3. **Audit Logging**: Capture who initiated actions by reading `userId` from context during data mutation hooks.

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@fastify/request-context` is not installed, `@oneunit/server` logs a warning and skips plugin registration; `request.requestContext` will be undefined.
- **Unbound Callbacks**: `AsyncLocalStorage` safely propagates through native `async/await` and Promises. However, non-standard event emitters or `setTimeout` without unref/ref might occasionally lose context if context-loss occurs in custom native C++ addons.

---

## Related Features

- [Lifecycle Hooks](hooks.md)
- [Structured Logging](logging.md)
- [Response Management](response-management.md)
