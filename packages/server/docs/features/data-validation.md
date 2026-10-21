# Data Validation with Zod

## Overview & Purpose

The **Data Validation with Zod** integration enables end-to-end type safety, runtime input validation, and response serialization across Fastify routes using Zod schemas.

Key capabilities:
- **Hybrid Schema Support**: `@oneunit/server` configures an intelligent compiler wrapper that automatically detects whether a route schema is a Zod schema or a standard JSON Schema (Ajv). It validates Zod schemas with `fastify-type-provider-zod` and delegates standard JSON schemas to Fastify's native compiler.
- **Full TypeScript Type Inference**: Route handlers automatically infer the static TypeScript types of `request.body`, `request.query`, `request.params`, and `request.headers` directly from your Zod schemas.
- **Response Filtering & Serialization**: Serializes response bodies using Zod schemas, stripping unexpected fields before data leaves the server.
- **Automated OpenAPI Integration**: When paired with the Swagger plugin, Zod schemas are automatically converted into OpenAPI 3.0 specification models.

---

## Architecture & How It Works

```
Incoming HTTP Request
  │
  ▼
[Fastify Schema Controller]
  │
  ├─ Is schema an instance of Zod?
  │    ├─ YES ──► fastify-type-provider-zod validatorCompiler
  │    │           (Parses, coerces, and validates via Zod)
  │    │
  │    └─ NO  ──► Fastify Native Ajv validatorCompiler
  │                (Standard JSON schema validation)
  │
  ▼
Validation Outcome:
  ├─ Valid: Handler runs with strongly typed request object
  │
  └─ Invalid: Fastify throws validation error ──► Global Error Handler (400 / 422)
```

---

## Installation & Import Requirements

```typescript
import {
  applyZodTypeProvider,
  createServer,
  startServer,
} from "@oneunit/server";

import { z } from "zod";
```

Optional peer dependencies:
```bash
npm install zod fastify-type-provider-zod
```

If these packages are not installed, `@oneunit/server` safely skips Zod provider registration and preserves Fastify's default JSON Schema validation.

---

## Configuration Options

When configuring `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `zod` | `boolean` | `true` | When true (default), automatically initializes the Zod validator and serializer compilers. Set to `false` to disable. |

---

## Usage Examples

### 1. Route Validation with Automatic Type Inference

```typescript
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { startServer } from "@oneunit/server";

// 1. Define schemas
const CreateUserSchema = {
  body: z.object({
    username: z.string().min(3).max(30),
    email: z.string().email(),
    age: z.number().int().positive().optional(),
    role: z.enum(["admin", "user", "guest"]).default("user"),
  }),
  params: z.object({
    orgId: z.string().uuid(),
  }),
  response: {
    201: z.object({
      id: z.string(),
      username: z.string(),
      email: z.string(),
      createdAt: z.string(),
    }),
  },
};

const { app } = await startServer({
  configure: (server) => {
    // Cast instance with withTypeProvider<ZodTypeProvider>() for strict autocomplete
    server.withTypeProvider<ZodTypeProvider>().post(
      "/orgs/:orgId/users",
      { schema: CreateUserSchema },
      async (request, reply) => {
        // request.params.orgId is string (UUID)
        const { orgId } = request.params;

        // request.body is fully typed:
        // { username: string; email: string; role: "admin" | "user" | "guest"; age?: number }
        const { username, email, role } = request.body;

        const user = await db.users.create({ orgId, username, email, role });

        return reply.status(201).send({
          id: user.id,
          username: user.username,
          email: user.email,
          createdAt: user.createdAt.toISOString(),
        });
      }
    );
  },
});
```

### 2. Query String Coercion and Pagination Validation

```typescript
const ListQuerySchema = {
  querystring: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().optional(),
    sortBy: z.enum(["name", "created_at"]).default("created_at"),
  }),
};

server.withTypeProvider<ZodTypeProvider>().get(
  "/search",
  { schema: ListQuerySchema },
  async (request, reply) => {
    // request.query.page and limit are guaranteed numbers, not strings!
    const { page, limit, search, sortBy } = request.query;
    const results = await performSearch({ page, limit, search, sortBy });
    return reply.ok({ data: results });
  }
);
```

### 3. Mixed Usage: Zod Schemas alongside Native JSON Schemas

Because `@oneunit/server` uses a dual-delegating compiler, you can freely mix Zod and raw JSON schemas on the same server:

```typescript
// Route A: Validated with Zod
server.post("/zod-route", {
  schema: {
    body: z.object({ value: z.string() }),
  },
}, async (req) => ({ ok: true }));

// Route B: Validated with Fastify native Ajv JSON Schema
server.post("/ajv-route", {
  schema: {
    body: {
      type: "object",
      required: ["rawField"],
      properties: { rawField: { type: "number" } },
    },
  },
}, async (req) => ({ ok: true }));
```

---

## Common Use Cases & Best Practices

1. **Use `z.coerce` for Query and Path Params**: Query parameters and URL path tokens arrive as raw strings. Use `z.coerce.number()` or `z.coerce.boolean()` to automatically cast them into native JavaScript types.
2. **Define Shared Schema Dictionaries**: Centralize reusable entity schemas (e.g. `UserSchema`, `PaginationSchema`, `UuidParamSchema`) across routes.
3. **Always Specify Response Schemas**: Supplying a `response` schema ensures sensitive database fields (like `passwordHash` or `salt`) are never accidentally leaked to clients.

---

## Edge Cases & Limitations

- **Peer Dependency Requirement**: `zod` and `fastify-type-provider-zod` must be added to your project's `dependencies`. If omitted, Zod schemas will cause runtime registration errors.
- **Complex Custom Formats**: Custom `.refine()` and `.transform()` functions run during route validation. If a transformation throws an unhandled exception, it is caught and translated into a 400 validation error.

---

## Related Features

- [Error Handling](error-handling.md)
- [Response Management](response-management.md)
- [Swagger (OpenAPI)](swagger.md)
