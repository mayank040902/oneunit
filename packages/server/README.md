# @oneunit/server

Fastify-based enterprise server bootstrap with deterministic plugin ordering, graceful lifecycle management, unified response envelopes, health monitoring, security defaults, and pluggable infrastructure (Postgres, Redis, Kafka, WebSockets).

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## Table of Contents

- [Overview](#overview)
- [Requirements & Installation](#requirements--installation)
- [Quick Start](#quick-start)
  - [Start Server (Listening)](#start-server-listening)
  - [Create Server (Testing & Injection)](#create-server-testing--injection)
  - [Custom Plugins & Configuration](#custom-plugins--configuration)
- [Bootstrap Architecture & Plugin Ordering](#bootstrap-architecture--plugin-ordering)
- [Bootstrap Options Reference](#bootstrap-options-reference)
- [Features & Usage Guide](#features--usage-guide)
  - [1. Server Bootstrap & Lifecycle](#1-server-bootstrap--lifecycle)
  - [2. Configuration & Environment Loading](#2-configuration--environment-loading)
  - [3. Lifecycle Hooks (Request & Server)](#3-lifecycle-hooks-request--server)
  - [4. Health Checks & System Monitoring](#4-health-checks--system-monitoring)
  - [5. Response Management & Unified Envelope](#5-response-management--unified-envelope)
  - [6. Global Error Handling](#6-global-error-handling)
  - [7. Data Validation with Zod](#7-data-validation-with-zod)
  - [8. Structured Logging](#8-structured-logging)
  - [9. Security Plugins](#9-security-plugins)
    - [Helmet (Security Headers)](#helmet-security-headers)
    - [CORS (Cross-Origin Resource Sharing)](#cors-cross-origin-resource-sharing)
    - [Cookie Parsing & Presets](#cookie-parsing--presets)
    - [CSRF Protection](#csrf-protection)
  - [10. HTTP Middleware & Performance](#10-http-middleware--performance)
    - [Response Compression](#response-compression)
    - [Rate Limiting (Allowlist, Blacklist, Redis)](#rate-limiting-allowlist-blacklist-redis)
    - [Multipart File Uploads](#multipart-file-uploads)
    - [Under Pressure (Load Shedding)](#under-pressure-load-shedding)
    - [Per-Request Context](#per-request-context)
    - [MessagePack Serialization](#messagepack-serialization)
  - [11. Infrastructure Plugins (Optional Peers)](#11-infrastructure-plugins-optional-peers)
    - [Database (PostgreSQL)](#database-postgresql)
    - [Redis](#redis)
    - [Kafka](#kafka)
    - [Realtime (WebSockets)](#realtime-websockets)
  - [12. OpenAPI & Swagger Documentation](#12-openapi--swagger-documentation)
    - [Swagger (OpenAPI Generator)](#swagger-openapi-generator)
    - [Swagger UI](#swagger-ui)
  - [13. Graceful & Bounded Shutdown](#13-graceful--bounded-shutdown)
  - [14. Shared Utilities & System Status](#14-shared-utilities--system-status)
- [Subpath Exports](#subpath-exports)
- [Executable Examples](#executable-examples)
- [Development & Quality Gates](#development--quality-gates)
- [License](#license)

---

## Overview

`@oneunit/server` provides a pre-configured, production-ready Fastify server container. Instead of manually stitching together dozen of plugins, error handlers, and lifecycle hooks, `@oneunit/server` wires them up in a deterministic order with safe production defaults.

Key capabilities:
- **Deterministic 8-Phase Registration**: Avoids plugin race conditions and ensures dependencies are registered in the correct order.
- **Unified JSON Response Envelope**: Built-in reply helpers (`reply.ok()`, `reply.created()`, `reply.notFound()`, `reply.paginated()`, etc.) ensuring consistent response structure across services.
- **Observability & Diagnostics**: Built-in `/health` endpoint aggregating system memory/CPU checks with database, Redis, and Kafka readiness probes.
- **Bounded Graceful Shutdown**: Protects against hanging keep-alive sockets on deploy or teardown with automated connection termination deadlines.
- **Modular Infrastructure**: Optional peer dependencies for PostgreSQL (`@oneunit/database`), Redis (`@oneunit/redis`), Kafka (`@oneunit/kafka`), WebSockets (`@oneunit/realtime`), logging (`@oneunit/logger`), and errors (`@oneunit/errors`). Install only what you use.

---

## Requirements & Installation

Requires **Node.js 20+**.

```bash
npm install @oneunit/server
```

### Optional Sibling Packages

Install only the sibling packages required for features you enable:

```bash
# Structured logging integration
npm install @oneunit/logger

# Canonical error taxonomy
npm install @oneunit/errors

# PostgreSQL database integration
npm install @oneunit/database

# Redis integration
npm install @oneunit/redis

# Kafka producer/consumer integration
npm install @oneunit/kafka

# Realtime WebSocket integration
npm install @oneunit/realtime
```

---

## Quick Start

### Start Server (Listening)

`startServer` (or `startBootstrapServer`) configures plugins, hooks, binds to the network port, and returns runtime details with a clean `close()` method:

```typescript
import { startServer } from "@oneunit/server";

const { app, address, port, host, close } = await startServer(8080, {
  serviceName: "user-service",
  logger: true,
  gracefulShutdown: true,
});

console.log(`Server listening on ${address} (host=${host}, port=${port})`);
```

### Create Server (Testing & Injection)

`createServer` (or `createBootstrapServer`) configures everything but skips `app.listen()`. This allows immediate use with Fastify's `.inject()` without binding real network sockets:

```typescript
import { createServer } from "@oneunit/server";

const app = await createServer({
  serviceName: "test-api",
  logger: false,
  env: false,
  health: true,
  configure: (server) => {
    server.get("/ping", async () => ({ pong: true }));
  },
});

await app.ready();

const res = await app.inject({ method: "GET", url: "/ping" });
console.log(res.statusCode, res.json()); // 200 { pong: true }

await app.close();
```

### Custom Plugins & Configuration

```typescript
import type { FastifyInstance } from "fastify";
import { startServer } from "@oneunit/server";

async function authPlugin(server: FastifyInstance) {
  server.decorateRequest("user", null);
}

await startServer({
  serviceName: "api",
  plugins: [authPlugin],
  configure(app) {
    app.get("/", async (request, reply) => {
      return reply.ok({ data: { message: "Hello World" } });
    });
  },
});
```

---

## Bootstrap Architecture & Plugin Ordering

To eliminate ordering bugs between middleware, security headers, context storage, and error handling, builtin plugins are registered in a strictly defined 8-phase pipeline:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 1: Framework Primitives                                          │
│         zod -> logger -> errorHandler -> responseManagement -> msgpack │
├────────────────────────────────────────────────────────────────────────┤
│ Phase 2: Request Infrastructure                                        │
│         requestContext                                                 │
├────────────────────────────────────────────────────────────────────────┤
│ Phase 3: Security                                                      │
│         helmet -> cookie -> csrf                                       │
├────────────────────────────────────────────────────────────────────────┤
│ Phase 4: HTTP Middleware                                               │
│         cors -> compress -> rateLimit -> multipart                     │
├────────────────────────────────────────────────────────────────────────┤
│ Phase 5: Performance & Protection                                      │
│         underPressure                                                  │
├────────────────────────────────────────────────────────────────────────┤
│ Phase 6: Infrastructure (Optional Peers)                               │
│         database -> redis -> kafka -> realtime                         │
├────────────────────────────────────────────────────────────────────────┤
│ Phase 7: Health & Monitoring                                           │
│         healthRegistry -> systemHealthProvider -> GET /health route    │
├────────────────────────────────────────────────────────────────────────┤
│ Phase 8: Documentation                                                 │
│         swagger -> swaggerUI                                           │
├────────────────────────────────────────────────────────────────────────┤
│ Application Extension:                                                 │
│         plugins[] -> extraPlugins[] -> configure(app)                  │
└────────────────────────────────────────────────────────────────────────┘
```

> [!NOTE]
> Custom application plugins and the `configure(app)` callback always run **after** all builtin framework and infrastructure plugins are registered and ready.

---

## Bootstrap Options Reference

All options can be passed to `createServer` / `startServer`.

### Core Server Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `serviceName` | `string` | `"app"` | Service name used in logs, health checks, and metrics |
| `host` | `string` | `"127.0.0.1"` | Host address to bind (`HOST` env var fallback) |
| `port` | `number` | `8080` | Port to listen on (`PORT` env var fallback) |
| `fastify` | `FastifyServerOptions` | `{}` | Raw Fastify server options passed to `fastify({...})` |
| `listen` | `FastifyListenOptions` | — | Overrides `host`/`port` for `app.listen()` |
| `env` | `false \| LoadEnvOptions` | `{}` | Options for `dotenv` file loading, or `false` to skip |
| `gracefulShutdown`| `boolean` | `false` | Automatically binds `SIGINT` and `SIGTERM` process handlers |
| `shutdownTimeout` | `number` | `10000` | Max milliseconds to wait for in-flight requests before dropping connections |

### Application Extension Options

| Option | Type | Description |
| :--- | :--- | :--- |
| `plugins` | `PluginEntry[] \| BuiltinPluginsOptions` | Array of custom Fastify plugins, or an object override for builtin plugin configs |
| `extraPlugins` | `PluginEntry[]` | Array of custom Fastify plugins (safe alongside object-based `plugins`) |
| `configure` | `(app: FastifyInstance) => void \| Promise<void>` | Callback invoked after all builtin and application plugins are registered |
| `hooks` | `BootstrapHooks` | Declarative Fastify lifecycle hooks (`onRequest`, `preHandler`, `onClose`, etc.) |
| `health` | `boolean \| BootstrapHealthOptions` | Health route and provider options, or `false` to disable entirely |

### Framework Plugins (Enabled by Default)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `logger` | `boolean \| LoggerPluginOptions` | `{ useHttpLogger: true }` | Fastify Pino logger or `@oneunit/logger` integration |
| `errorHandler` | `boolean \| ErrorHandlerPluginOptions` | `{ includeStack: false, logErrors: true }` | Global error handler and 404 handler |
| `responseManagement` | `boolean \| ResponseManagementPluginOptions` | `true` | Standard response envelope & reply helpers (`reply.ok`, `reply.notFound`, etc.) |
| `zod` | `boolean` | `true` | Zod type provider via `fastify-type-provider-zod` |
| `msgpack` | `boolean \| MsgpackPluginOptions` | `{ enableBuiltin: true }` | MessagePack request decoding and response encoding negotiation |
| `cors` | `boolean \| CorsPluginOptions` | `{ origin: true, credentials: true }` | CORS headers via `@fastify/cors` |
| `helmet` | `boolean \| HelmetPluginOptions` | `true` | Security headers via `@fastify/helmet` |
| `cookie` | `boolean \| CookiePluginOptions` | `true` | Cookie parser via `@fastify/cookie` |
| `compress` | `boolean \| CompressPluginOptions` | `true` | Response compression via `@fastify/compress` |
| `rateLimit` | `boolean \| RateLimitPluginOptions` | `{ max: 1000, timeWindow: "1 minute" }` | Rate limiting via `@fastify/rate-limit` |
| `requestContext` | `boolean \| RequestContextPluginOptions` | `true` | AsyncLocalStorage per-request context via `@fastify/request-context` |

### Infrastructure Plugins (Disabled by Default)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `database` | `boolean \| DatabasePluginOptions` | `false` | PostgreSQL pool & queries via `@oneunit/database` |
| `redis` | `boolean \| RedisPluginOptions` | `false` | Redis client integration via `@oneunit/redis` |
| `kafka` | `boolean \| KafkaPluginOptions` | `false` | Kafka producer & consumer via `@oneunit/kafka` |
| `realtime` | `boolean \| RealtimePluginOptions` | `false` | WebSocket integration via `@oneunit/realtime` |

### Optional Plugins (Disabled by Default)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `multipart` | `boolean \| MultipartPluginOptions` | `false` | File uploads via `@fastify/multipart` |
| `csrf` | `boolean \| CsrfPluginOptions` | `false` | CSRF protection via `@fastify/csrf-protection` |
| `underPressure`| `boolean \| UnderPressurePluginOptions` | `false` | Load shedding & resource monitoring via `@fastify/under-pressure` |
| `swagger` | `boolean \| SwaggerPluginOptions` | `false` | OpenAPI schema generation via `@fastify/swagger` |
| `swaggerUI` | `boolean \| SwaggerUIPluginOptions` | `false` | Interactive Swagger UI via `@fastify/swagger-ui` |

---

## Features & Usage Guide

### 1. Server Bootstrap & Lifecycle

The package exports four primary functions for creating and starting servers:

- `startServer(portOrOptions?, options?)` (alias of `startBootstrapServer`)
- `createServer(portOrOptions?, options?)` (alias of `createBootstrapServer`)

#### Function Signatures

Both functions accept overloaded parameter signatures:
- `startServer(port: number, options?: BootstrapServerOptions)`
- `startServer(options?: BootstrapServerOptions)`

```typescript
import { startServer, createServer } from "@oneunit/server";

// Signature 1: port + options
const server1 = await startServer(3000, { serviceName: "auth" });

// Signature 2: single options object
const server2 = await startServer({
  port: 8080,
  host: "0.0.0.0",
  serviceName: "api",
  gracefulShutdown: true,
  shutdownTimeout: 5000,
});

// Create without listening (for testing)
const app = await createServer({
  serviceName: "test-app",
  logger: false,
});
```

#### Return Type: `StartedBootstrapServer`

When starting the server, `startServer` resolves to:

```typescript
interface StartedBootstrapServer {
  app: FastifyInstance;  // The Fastify instance
  address: string;        // Formatted address (e.g., "http://127.0.0.1:8080")
  port: number;          // Bound port
  host: string;          // Bound host
  close(): Promise<void>;// Closes listeners & drains connections cleanly
}
```

---

### 2. Configuration & Environment Loading

Imported from `@oneunit/server` or `@oneunit/server/config`.

`@oneunit/server` automatically attempts to load `.env` and `.env.<NODE_ENV>` files using `dotenv` on startup unless `env: false` is configured.

```typescript
import {
  loadEnv,
  serviceConfig,
  nodeEnv,
  resolveNodeEnv,
  isDevelopment,
  isProduction,
  isTest,
  envString,
  envNumber,
  envBool,
  envList,
} from "@oneunit/server/config";

// 1. Manually load environment files with custom path:
await loadEnv({ dir: process.cwd(), path: "./config/.env.local" });

// 2. Resolve normalized service configurations:
const cfg = serviceConfig(8080, "127.0.0.1", "auth-service");
// Returns: { port, host, serviceName, nodeEnv, isDevelopment, isProduction, isTest }

// 3. Environment query helpers:
console.log(nodeEnv()); // e.g. "production", "development", "test"
console.log(isProduction()); // boolean

// 4. Strongly typed environment variable parsers:
const dbHost = envString("DATABASE_HOST", "localhost");
const dbPort = envNumber("DATABASE_PORT", 5432);
const debugMode = envBool("DEBUG_MODE", false); // supports "true", "1", "yes", "on"
const allowedOrigins = envList("CORS_ORIGINS", ["http://localhost:3000"]); // comma-separated
```

#### Disabling `.env` loading in tests

```typescript
const app = await createServer({
  env: false, // Prevents reading host .env files in unit/integration tests
});
```

---

### 3. Lifecycle Hooks (Request & Server)

Imported from `@oneunit/server` or `@oneunit/server/hooks`.

Register Fastify lifecycle hooks cleanly via the `hooks` bootstrap option, accepting either a single function or an array of functions for any hook:

```typescript
import { createServer, type BootstrapHooks } from "@oneunit/server";

const hooks: BootstrapHooks = {
  // Request lifecycle hooks:
  onRequest: async (request, reply) => {
    request.log.info({ url: request.url }, "Incoming request");
  },
  preParsing: async (request, reply, payload) => payload,
  preValidation: async (request, reply) => { /* validate credentials */ },
  preHandler: [
    async (request, reply) => {
      reply.header("X-Service", "user-api");
    },
    async (request, reply) => {
      // additional pre-handler logic
    },
  ],
  preSerialization: async (request, reply, payload) => payload,
  onSend: async (request, reply, payload) => payload,
  onResponse: async (request, reply) => {
    request.log.info({ statusCode: reply.statusCode }, "Request finished");
  },
  onError: async (request, reply, error) => {
    request.log.error(error);
  },
  onTimeout: async (request, reply) => { /* handle request timeout */ },
  onRequestAbort: async (request) => { /* client disconnected early */ },

  // Server lifecycle hooks:
  onReady: async () => {
    console.log("Server plugins initialized and ready to serve");
  },
  onListen: async () => {
    console.log("Listening socket opened");
  },
  onClose: async (instance) => {
    console.log("Server closing, teardown started");
  },
  onRoute: (routeOptions) => {
    // Inspect or modify routes as they are registered
  },
  onRegister: (instance, opts) => {
    // Inspect plugin registrations
  },
};

const app = await createServer({ hooks });
```

---

### 4. Health Checks & System Monitoring

Imported from `@oneunit/server` or `@oneunit/server/routes`.

The health system aggregates checks from all subsystems into a single `GET /health` endpoint with aggregate status calculation (`healthy`, `degraded`, or `unhealthy`).

#### Default Endpoint Response (`GET /health`)

```json
{
  "status": "healthy",
  "service": "api",
  "timestamp": "2026-10-21T13:34:00.000Z",
  "checks": {
    "system": { "status": "healthy" },
    "database": { "status": "healthy" }
  }
}
```

When any critical health check fails, the endpoint returns HTTP `503 Service Unavailable`.

#### Configuration Options

```typescript
const app = await createServer({
  serviceName: "order-service",
  health: {
    path: "/healthz",        // Custom route path (default: "/health")
    includeDetails: true,    // Include memory/CPU metrics and provider details
  },
});
```

#### Registering Custom Health Providers

You can register custom health providers into the health registry:

```typescript
import { createServer, createHealthProvider } from "@oneunit/server";

const app = await createServer({
  configure: (server) => {
    // Register a custom payment gateway check
    server.healthRegistry.register(
      createHealthProvider(
        "paymentGateway",
        async () => {
          const isUp = await pingPaymentGateway();
          return {
            status: isUp ? "healthy" : "unhealthy",
            details: { latencyMs: 42 },
          };
        },
        true, // isCritical: if true, failure causes HTTP 503
      )
    );
  },
});
```

#### System Health Provider

By default, `@oneunit/server` registers a system health provider that monitors heap memory, RSS, and CPU load. For security, internal OS identifiers (username, uid, homedir, shell, network MAC/IP addresses) are **never** exposed in health responses.

---

### 5. Response Management & Unified Envelope

Imported from `@oneunit/server` or `@oneunit/server/plugins`.

The `responseManagement` plugin is enabled by default. It decorates `FastifyReply` with ergonomic helper methods that enforce a standardized API response shape:

```typescript
interface ApiResponse<T = unknown> {
  success: boolean;                   // true for 2xx, false for 4xx/5xx
  code: string;                      // Application error/success code (defaults to HTTP status)
  msg: string;                       // Human-readable message
  data?: T;                          // Response body payload
  metadata?: Record<string, unknown>;// Pagination, requestId, traceId
  errors?: FieldError[];             // Field-level validation error details
}
```

#### Reply Helpers

```typescript
import { createServer, ResponseManager } from "@oneunit/server";

const app = await createServer({
  configure: (server) => {
    // 200 OK
    server.get("/users/:id", async (request, reply) => {
      const user = await findUser(request.params.id);
      if (!user) {
        return reply.notFound({ message: "User not found" });
      }
      return reply.ok({ data: user });
    });

    // 201 Created
    server.post("/users", async (request, reply) => {
      const user = await createUser(request.body);
      return reply.created({
        data: user,
        message: "User account created successfully",
        code: "USER_CREATED",
      });
    });

    // 204 No Content (No body allowed)
    server.delete("/users/:id", async (request, reply) => {
      await deleteUser(request.params.id);
      return reply.noContent();
    });

    // 200 Paginated with metadata
    server.get("/users", async (request, reply) => {
      const { page = 1, pageSize = 20 } = request.query as any;
      const { rows, total } = await listUsers(page, pageSize);

      return reply.paginated({
        data: rows,
        pagination: ResponseManager.pagination(total, Number(page), Number(pageSize)),
      });
    });

    // 400 Bad Request with field-level errors
    server.post("/register", async (request, reply) => {
      return reply.badRequest({
        message: "Validation failed",
        errors: [
          { field: "email", message: "Invalid email format" },
          { field: "password", message: "Password too short" },
        ],
      });
    });

    // Dynamic status using reply.respond()
    server.get("/custom", async (request, reply) => {
      return reply.respond({
        status: 202,
        response: { message: "Task accepted for processing", data: { jobId: "123" } },
      });
    });
  },
});
```

#### Available Reply Helpers

| Helper | HTTP Status | Type |
| :--- | :--- | :--- |
| `reply.ok()`, `reply.success()` | `200` | Success |
| `reply.created()` | `201` | Success |
| `reply.accepted()` | `202` | Success |
| `reply.noContent()` | `204` | Success (No Body) |
| `reply.paginated()` | `200` | Success (Includes `metadata.pagination`) |
| `reply.badRequest()` | `400` | Client Error |
| `reply.unauthorized()` | `401` | Client Error |
| `reply.paymentRequired()` | `402` | Client Error |
| `reply.forbidden()` | `403` | Client Error |
| `reply.notFound()` | `404` | Client Error |
| `reply.methodNotAllowed()` | `405` | Client Error |
| `reply.conflict()` | `409` | Client Error |
| `reply.gone()` | `410` | Client Error |
| `reply.payloadTooLarge()` | `413` | Client Error |
| `reply.unsupportedMediaType()` | `415` | Client Error |
| `reply.unprocessable()`, `reply.validationError()` | `422` | Client Error |
| `reply.tooManyRequests()` | `429` | Client Error |
| `reply.serverError()` | `500` | Server Error |
| `reply.notImplemented()` | `501` | Server Error |
| `reply.badGateway()` | `502` | Server Error |
| `reply.serviceUnavailable()`| `503` | Server Error |
| `reply.gatewayTimeout()` | `504` | Server Error |
| `reply.error()`, `reply.failed()` | Custom `4xx`/`5xx` | Error |
| `reply.respond()` | Any status | Dynamic |

#### Plugin Configuration Options

```typescript
const app = await createServer({
  responseManagement: {
    defaultSuccessMessage: "Operation completed", // Default: "Success"
    defaultErrorMessage: "Request processing error", // Default: "Request failed"
    includeRequestId: true,                       // Injects request id into metadata (Default: true)
  },
});
```

---

### 6. Global Error Handling

Imported from `@oneunit/server` or `@oneunit/server/plugins`.

The global error handler intercepts uncaught exceptions, Fastify validation errors, and 404 routes, converting them into platform-standard JSON error responses:

```typescript
const app = await createServer({
  errorHandler: {
    includeStack: false,      // Set to true only in development/debugging
    logErrors: true,          // Log uncaught errors with request details
    logOperationalAsWarn: true,// Log operational (4xx) errors as warn instead of error
    customHandler: async (error, request, reply) => {
      // Optional domain-specific hook
      if (error instanceof CustomDomainError) {
        return reply.status(400).send({ custom: error.message });
      }
    },
  },
});
```

---

### 7. Data Validation with Zod

By default, `@oneunit/server` enables Zod-based type checking and schema validation for Fastify routes using `fastify-type-provider-zod`:

```typescript
import { z } from "zod";
import { createServer } from "@oneunit/server";

const app = await createServer({
  configure: (server) => {
    server.post(
      "/items",
      {
        schema: {
          body: z.object({
            title: z.string().min(3),
            price: z.number().positive(),
            tags: z.array(z.string()).optional(),
          }),
          response: {
            201: z.object({
              id: z.string(),
              title: z.string(),
            }),
          },
        },
      },
      async (request, reply) => {
        // request.body is fully typed: { title: string; price: number; tags?: string[] }
        const item = await saveItem(request.body);
        return reply.status(201).send(item);
      },
    );
  },
});
```

To disable Zod provider integration:
```typescript
const app = await createServer({ zod: false });
```

---

### 8. Structured Logging

`@oneunit/server` integrates with `@oneunit/logger` (or falls back to Fastify Pino logger):

```typescript
const app = await createServer({
  serviceName: "billing-api",
  logger: {
    useHttpLogger: true,
    childBindings: { env: process.env.NODE_ENV },
    serializers: {
      req(req) {
        return { method: req.method, url: req.url };
      },
    },
  },
});
```

Inside handlers:
```typescript
server.get("/example", async (request) => {
  request.log.info({ userId: 123 }, "Processing user");
  return { status: "ok" };
});
```

To completely disable logging (e.g., during unit tests):
```typescript
const app = await createServer({ logger: false });
```

---

### 9. Security Plugins

#### Helmet (Security Headers)

Enabled by default via `@fastify/helmet`. Configures security headers (Content Security Policy, HSTS, X-Frame-Options, etc.):

```typescript
const app = await createServer({
  helmet: {
    contentSecurityPolicy: false, // Disable CSP for API-only servers
    frameguard: { action: "deny" },
  },
});
```

To disable: `helmet: false`.

#### CORS (Cross-Origin Resource Sharing)

Enabled by default via `@fastify/cors` with `{ origin: true, credentials: true }`:

```typescript
const app = await createServer({
  cors: {
    origin: ["https://app.example.com", "https://admin.example.com"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    maxAge: 86400,
  },
});
```

To disable: `cors: false`.

#### Cookie Parsing & Presets

Enabled by default via `@fastify/cookie`. Parses incoming cookies on `request.cookies`:

```typescript
import {
  createServer,
  authCookieOptions,
  accessCookieOptions,
  refreshCookieOptions,
} from "@oneunit/server";

const app = await createServer({
  cookie: {
    secret: "super-secret-signing-key",
  },
  configure: (server) => {
    server.post("/login", async (request, reply) => {
      // Set signed authentication cookie using preset options:
      reply.setCookie("refreshToken", "token_value", refreshCookieOptions);
      return reply.ok({ message: "Logged in" });
    });

    server.get("/me", async (request, reply) => {
      const token = request.cookies.refreshToken;
      return reply.ok({ data: { token } });
    });
  },
});
```

#### CSRF Protection

Disabled by default. Protects state-changing endpoints against CSRF attacks via `@fastify/csrf-protection`:

```typescript
const app = await createServer({
  cookie: { secret: "session-secret" },
  csrf: {
    cookieName: "_csrf",
    ignoreMethods: ["GET", "HEAD", "OPTIONS"],
  },
});
```

---

### 10. HTTP Middleware & Performance

#### Response Compression

Enabled by default via `@fastify/compress` (supporting gzip, deflate, and brotli):

```typescript
const app = await createServer({
  compress: {
    threshold: 1024, // Only compress responses larger than 1KB
    encodings: ["gzip", "deflate"],
  },
});
```

To disable: `compress: false`.

#### Rate Limiting (Allowlist, Blacklist, Redis)

Enabled by default via `@fastify/rate-limit` (default: 1000 requests / minute):

```typescript
const app = await createServer({
  rateLimit: {
    max: 100,
    timeWindow: "1 minute",
    allowList: ["127.0.0.1", "10.0.0.1"], // Whitelisted IPs skip limits
    blacklist: ["192.168.1.100"],         // Blacklisted IPs immediately receive 429
  },
});
```

Distributed rate limiting using Redis:
```typescript
const app = await createServer({
  redis: { url: "redis://127.0.0.1:6379" },
  rateLimit: {
    max: 500,
    timeWindow: 60000,
    redis: (server as any).redis,
  },
});
```

To disable: `rateLimit: false`.

#### Multipart File Uploads

Disabled by default. Uses `@fastify/multipart` for handling file uploads and streaming:

```typescript
const app = await createServer({
  multipart: {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB max file size
      files: 5,
    },
  },
  configure: (server) => {
    server.post("/upload", async (request, reply) => {
      const data = await request.file();
      // data.file (Readable stream), data.filename, data.mimetype
      return reply.ok({ data: { filename: data?.filename } });
    });
  },
});
```

#### Under Pressure (Load Shedding)

Disabled by default. Uses `@fastify/under-pressure` to shed traffic when the server is near resource exhaustion:

```typescript
const app = await createServer({
  underPressure: {
    maxEventLoopDelay: 1000,       // Max event loop delay in ms
    maxHeapUsedBytes: 512 * 1024 * 1024, // 512MB max heap
    maxRssBytes: 1024 * 1024 * 1024,     // 1GB max RSS
    retryAfter: 10,                // Retry-After header in seconds
  },
});
```

#### Per-Request Context

Enabled by default via `@fastify/request-context` using Node.js `AsyncLocalStorage`:

```typescript
const app = await createServer({
  requestContext: true,
  configure: (server) => {
    server.addHook("onRequest", async (request) => {
      request.requestContext.set("correlationId", request.headers["x-correlation-id"]);
    });

    server.get("/profile", async (request, reply) => {
      const correlationId = request.requestContext.get("correlationId");
      return reply.ok({ data: { correlationId } });
    });
  },
});
```

#### MessagePack Serialization

Enabled by default via `@msgpack/msgpack`. Enables transparent binary serialization:
- If a client sends `Content-Type: application/msgpack`, the body is decoded.
- If a client sends `Accept: application/msgpack`, the response is automatically encoded as MessagePack.

```typescript
const app = await createServer({
  msgpack: {
    enableBuiltin: true,
    extensions: [], // Custom extension codecs if needed
  },
});
```

---

### 11. Infrastructure Plugins (Optional Peers)

#### Database (PostgreSQL)

Powered by `@oneunit/database`:
- Automatically decorates Fastify with `app.db` and `app.database`.
- Automatically registers a database health check with `GET /health`.
- Gracefully drains the connection pool on server shutdown.

```typescript
const app = await createServer({
  database: {
    host: "localhost",
    port: 5432,
    database: "production",
    user: "postgres",
    password: "secretpassword",
    max: 20,                       // Max connection pool size
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    logQueries: false,
    healthCheckCritical: true,     // Marks /health as 503 if database check fails
  },
  configure: (server) => {
    server.get("/users", async (request, reply) => {
      const users = await (server as any).db.query("SELECT * FROM users LIMIT 10");
      return reply.ok({ data: users });
    });
  },
});
```

#### Redis

Powered by `@oneunit/redis`:
- Automatically decorates Fastify with `app.redis`.
- Registers Redis health monitoring when `healthCheck: true`.
- Automatically closes connections on server shutdown.

```typescript
const app = await createServer({
  redis: {
    url: "redis://127.0.0.1:6379",
    healthCheck: true,
    lazyConnect: false,
  },
  configure: (server) => {
    server.get("/cache-demo", async (request, reply) => {
      const redis = (server as any).redis;
      await redis.set("counter", "100", "EX", 60);
      const val = await redis.get("counter");
      return reply.ok({ data: { val } });
    });
  },
});
```

#### Kafka

Powered by `@oneunit/kafka`:
- Configures Kafka producers, consumer groups, and topics.
- Integrates producer acquisition check into `GET /health`.
- Disconnects producer and consumers on server shutdown.

```typescript
const app = await createServer({
  kafka: {
    clientId: "order-service",
    brokers: ["localhost:9092"],
    autoConnectProducer: true,
    subscribeTopics: ["order-events"],
    onMessage: async (payload) => {
      console.log("Received Kafka message:", payload);
    },
  },
});
```

#### Realtime (WebSockets)

Powered by `@oneunit/realtime`:
- Provides WebSocket integration for bidirectional communication.

```typescript
const app = await createServer({
  realtime: {
    websocketLibrary: "fastify",
    path: "/ws",
    routes: async (server) => {
      // Configure WebSocket handlers
    },
  },
});
```

---

### 12. OpenAPI & Swagger Documentation

#### Swagger (OpenAPI Generator)

Uses `@fastify/swagger` to automatically generate an OpenAPI 3.0 specification from Zod schemas and route definitions:

```typescript
const app = await createServer({
  swagger: {
    openapi: {
      info: {
        title: "Storefront API",
        description: "Public API specifications",
        version: "1.0.0",
      },
    },
  },
});

// Access generated spec programmatically:
await app.ready();
const spec = (app as any).swagger();
```

#### Swagger UI

Uses `@fastify/swagger-ui` to serve interactive Swagger documentation:

```typescript
const app = await createServer({
  swagger: true,
  swaggerUI: {
    routePrefix: "/docs", // Browse docs at http://localhost:8080/docs
  },
});
```

---

### 13. Graceful & Bounded Shutdown

Node.js servers often hang during shutdown when clients hold keep-alive HTTP connections open. `@oneunit/server` provides an integrated bounded shutdown mechanism:

```typescript
const { app, close } = await startServer({
  port: 8080,
  gracefulShutdown: true, // Listens for SIGINT & SIGTERM
  shutdownTimeout: 5000,  // Drops sockets after 5000ms if requests don't finish
});
```

#### How it works:
1. When `SIGINT` or `SIGTERM` is received, the listener stops accepting new incoming connections.
2. In-flight HTTP requests are permitted to complete normally.
3. Idle keep-alive sockets are continuously closed.
4. If requests exceed `shutdownTimeout` (default: 10000ms), remaining connections are forcefully destroyed.
5. All database, Redis, and Kafka clients close cleanly.
6. The Node process exits with status code 0.

#### Manual programmatic shutdown

You can invoke `closeWithDeadline` directly on any Fastify instance:

```typescript
import { closeWithDeadline } from "@oneunit/server/lib";

await closeWithDeadline(app, { timeoutMs: 3000 });
```

---

### 14. Shared Utilities & System Status

Imported from `@oneunit/server` or `@oneunit/server/lib`.

#### System Diagnostics (`getSystemInfo`, `getSystemStatus`)

```typescript
import { getSystemInfo, getSystemStatus } from "@oneunit/server/lib";

// Read raw hardware and runtime details:
const info = getSystemInfo();
// Returns: { memory, cpu, process, os, ... }

// Calculate health status against threshold limits:
const status = getSystemStatus(
  {
    heapUsedRatio: 0.65,
    rssBytes: 300 * 1024 * 1024,
    cpuUsageRatio: 0.45,
  },
  { database: { status: "healthy" } }
);
console.log(status); // "healthy" | "degraded" | "unhealthy"
```

#### Formatting Helpers

```typescript
import { formatBytes, formatTime, timestamp } from "@oneunit/server/lib";

console.log(formatBytes(1048576));   // "1.00 MB"
console.log(formatTime(125000));     // "2m 5s"
console.log(timestamp());            // ISO 8601 string
```

#### Secure Cookie Option Presets

```typescript
import {
  authCookieOptions,
  accessCookieOptions,
  refreshCookieOptions,
} from "@oneunit/server/lib";

reply.setCookie("token", token, authCookieOptions);
```

---

## Subpath Exports

`@oneunit/server` provides dedicated subpath exports to keep bundle sizes lean and imports organized:

| Subpath Export | Description |
| :--- | :--- |
| `@oneunit/server` | Primary export: bootstrap functions, plugins, hooks, config, health, utilities, and all TypeScript types |
| `@oneunit/server/bootstrap` | Core bootstrap functions (`createServer`, `startServer`, `createBootstrapServer`, `startBootstrapServer`) |
| `@oneunit/server/config` | Environment loaders and variable resolvers (`serviceConfig`, `loadEnv`, `nodeEnv`, `envBool`, etc.) |
| `@oneunit/server/hooks` | Lifecycle hook helpers (`registerHooks`, `registerRequestHooks`, `registerServerHooks`) |
| `@oneunit/server/plugins` | Plugin factories, response management (`ResponseManager`, `HTTP_STATUS`), and plugin options |
| `@oneunit/server/routes` | Builtin framework routes (`createHealthPlugin`) |
| `@oneunit/server/lib` | Shared utilities (`getSystemInfo`, `getSystemStatus`, `formatBytes`, `formatTime`, `timestamp`, `closeWithDeadline`) |

---

## Executable Examples

The repository includes runnable TypeScript and JavaScript examples in the [`examples/`](./examples/) folder:

| Example | Command | Description |
| :--- | :--- | :--- |
| Minimal JavaScript | `npm run example:basic` | Demonstrates starting the server with minimal JavaScript |
| Complete TypeScript | `npm run example:complete` | Demonstrates all features: plugins, hooks, custom routes, health, Zod, and response helpers |

---

## Development & Quality Gates

To contribute or test the package locally:

```bash
# Typecheck TypeScript definitions
npm run typecheck

# Build dist artifacts
npm run build

# Run Vitest test suite
npm test

# Run tests in watch mode
npm run test:watch

# Run linter
npm run lint

# Dry-run npm packaging to verify files
npm run pack:check

# Run all checks simultaneously
npm run verify
```

---

## License

MIT © [mayank](https://github.com/mayank040902)
