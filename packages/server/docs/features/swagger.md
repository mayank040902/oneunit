# Swagger / OpenAPI Specification

## Overview & Purpose

The **Swagger Plugin** integrates `@fastify/swagger` into `@oneunit/server` to automatically generate standardized **OpenAPI 3.0** documentation contracts directly from your Fastify routes and Zod validation schemas.

Key capabilities:
- **Zero-Duplication OpenAPI Generation**: Automatically inspects route definitions, query parameters, route params, request bodies, and response schemas, converting them into valid OpenAPI 3.0 specs.
- **Deep Zod Integration**: When paired with `fastify-type-provider-zod`, Zod schema structures, default values, min/max constraints, and enums are seamlessly transformed into OpenAPI component schemas.
- **Programmatic Spec Access**: Decorates the server with `server.swagger()`, allowing dynamic export of the generated OpenAPI JSON or YAML spec for CI pipelines, contract testing, or SDK generation.

---

## Installation & Import Requirements

```typescript
import {
  swaggerPlugin,
  type SwaggerPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { swaggerPlugin } from "@oneunit/server/plugins";
```

Optional peer dependency:
```bash
npm install @fastify/swagger
```

---

## Configuration Options

When configuring `swagger` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `swagger` | `boolean \| SwaggerPluginOptions` | `false` | Disabled by default. Set to `true` or pass configuration object to enable. |
| `openapi.info.title` | `string` | — | Title of the API displayed in documentation. |
| `openapi.info.version` | `string` | — | Semantic version of the API contract (e.g. `"1.0.0"`). |
| `openapi.info.description`| `string` | — | High-level summary of the service. |
| `openapi.components.securitySchemes`| `object` | — | Defines authentication mechanisms (`bearerAuth`, `apiKey`, `oauth2`). |
| `openapi.tags` | `Array<{ name: string; description?: string }>` | `[]` | Route categorization groups. |
| `openapi.externalDocs` | `object` | — | Links to external documentation or developer portals. |
| `hideUntagged` | `boolean` | `false` | When true, hides any routes that do not have explicit tags attached. |
| `stripBasePath` | `boolean` | `false` | When true, strips common URL base paths from documentation. |
| `mode` | `"dynamic" \| "static"` | `"dynamic"` | `"dynamic"` generates spec from routes; `"static"` loads pre-generated JSON/YAML files. |

---

## Usage Examples

### 1. Generating OpenAPI 3.0 Spec with Bearer Authentication

```typescript
import { startServer } from "@oneunit/server";
import { z } from "zod";

const { app } = await startServer({
  serviceName: "customer-api",
  swagger: {
    openapi: {
      info: {
        title: "Customer Microservice API",
        version: "1.2.0",
        description: "Public API contract for managing customer accounts",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
      tags: [
        { name: "Customers", description: "Customer profile operations" },
      ],
    },
  },
  configure: (server) => {
    // Add documented route with Zod schema
    server.post(
      "/customers",
      {
        schema: {
          tags: ["Customers"],
          summary: "Create a new customer account",
          security: [{ bearerAuth: [] }],
          body: z.object({
            name: z.string().min(2),
            email: z.string().email(),
          }),
          response: {
            201: z.object({
              id: z.string().uuid(),
              name: z.string(),
              email: z.string(),
            }),
          },
        },
      },
      async (request, reply) => {
        return reply.status(201).send({
          id: "123e4567-e89b-12d3-a456-426614174000",
          name: request.body.name,
          email: request.body.email,
        });
      }
    );
  },
});
```

### 2. Exporting OpenAPI JSON Programmatically

```typescript
import { createServer } from "@oneunit/server";
import { writeFileSync } from "node:fs";

const app = await createServer({
  swagger: { openapi: { info: { title: "API", version: "1.0.0" } } },
});

await app.ready();

// Export the OpenAPI spec object:
const spec = (app as any).swagger();
writeFileSync("./openapi.json", JSON.stringify(spec, null, 2));
console.log("Exported openapi.json successfully");
```

---

## Common Use Cases & Best Practices

1. **Pair with Swagger UI**: Enable both `swagger: true` and `swaggerUI: true` to instantly serve an interactive browser dashboard.
2. **Automate Client SDK Generation**: Export `openapi.json` during CI builds to generate TypeScript or Python client SDKs using tools like `openapi-typescript` or `orval`.
3. **Use Descriptive Summaries**: Add `summary` and `description` to route schemas so API consumers understand the purpose of every parameter and endpoint.

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@fastify/swagger` is missing from `node_modules`, `@oneunit/server` logs a warning and proceeds without Swagger.
- **Timing**: Route schemas must be registered before `await app.ready()` runs for dynamic specification generation to discover them.

---

## Related Features

- [Swagger UI](swagger-ui.md)
- [Data Validation with Zod](data-validation.md)
- [Bootstrap](bootstrap.md)
