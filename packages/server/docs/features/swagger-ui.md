# Swagger UI

## Overview & Purpose

The **Swagger UI Plugin** integrates `@fastify/swagger-ui` into `@oneunit/server` to serve an interactive API documentation dashboard in the web browser.

It turns your generated OpenAPI schema into a live sandbox:
- **Interactive API Explorer**: Developers can browse endpoints, view request/response models, and inspect parameter validation rules.
- **"Try It Out" Testing**: Execute real HTTP calls directly from the browser with authentication tokens attached.
- **Custom Route Prefix**: Serve documentation at `/documentation` (default), `/docs`, or custom internal paths.
- **Embedded Security**: Configures Content Security Policy (CSP) options to allow Swagger UI scripts and assets to render safely alongside the `helmet` plugin.

---

## Installation & Import Requirements

```typescript
import {
  swaggerUIPlugin,
  type SwaggerUIPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { swaggerUIPlugin } from "@oneunit/server/plugins";
```

Optional peer dependencies:
```bash
npm install @fastify/swagger-ui @fastify/swagger
```

---

## Configuration Options

When configuring `swaggerUI` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `swaggerUI` | `boolean \| SwaggerUIPluginOptions` | `false` | Disabled by default. Requires `swagger` to also be enabled. |
| `routePrefix` | `string` | `"/documentation"` | URL path where Swagger UI is hosted. |
| `staticCSP` | `boolean` | `true` | When true, automatically generates inline CSP directives for Swagger UI assets. |
| `uiConfig.docExpansion` | `"list" \| "full" \| "none"` | `"list"` | Controls default expansion depth of tags and routes. |
| `uiConfig.deepLinking` | `boolean` | `true` | Enables deep linking to specific tags and routes in the URL hash. |
| `uiConfig.displayRequestDuration` | `boolean` | `true` | Displays request latency (in ms) for "Try It Out" requests. |
| `uiConfig.filter` | `boolean \| string` | `true` | Adds a search filter box at the top of Swagger UI. |
| `uiConfig.tryItOutEnabled` | `boolean` | `true` | Automatically expands the "Try It Out" button on routes. |

---

## Usage Examples

### 1. Enabling Swagger UI at `/docs`

```typescript
import { startServer } from "@oneunit/server";

const { address } = await startServer({
  serviceName: "inventory-api",
  // Swagger generation must be enabled for Swagger UI to work:
  swagger: {
    openapi: {
      info: {
        title: "Inventory Service API",
        version: "1.0.0",
      },
    },
  },
  swaggerUI: {
    routePrefix: "/docs", // Browse at http://localhost:8080/docs
    uiConfig: {
      docExpansion: "list",
      filter: true,
      displayRequestDuration: true,
    },
  },
  configure: (server) => {
    server.get("/items", async (req, reply) => {
      return reply.ok({ data: ["item-1", "item-2"] });
    });
  },
});

console.log(`Explore interactive API docs at ${address}/docs`);
```

---

## Common Use Cases & Best Practices

1. **Restrict to Non-Production Environments**: In public production environments with sensitive internal APIs, you may want to disable Swagger UI or restrict `/docs` behind authentication:
   ```typescript
   const isProd = process.env.NODE_ENV === "production";
   const app = await startServer({
     swagger: true,
     swaggerUI: !isProd, // Enabled in local and staging, disabled in production
   });
   ```
2. **Always Keep `staticCSP: true`**: Swagger UI loads internal scripts and styles; `staticCSP: true` ensures `@fastify/helmet` does not block these assets from rendering.

---

## Edge Cases & Limitations

- **Requires Swagger Plugin**: `@fastify/swagger-ui` requires `@fastify/swagger` to be registered first. `@oneunit/server` guarantees that Swagger is registered in Phase 8 right before Swagger UI.
- **Peer Dependency Fallback**: If `@fastify/swagger-ui` is not installed, `@oneunit/server` logs a warning and skips mounting the UI route.

---

## Related Features

- [Swagger (OpenAPI)](swagger.md)
- [Helmet (Security Headers)](helmet.md)
- [Bootstrap](bootstrap.md)
