# Server Package Architecture

## 1. Overview

This package is a **Fastify-based server runtime and bootstrap framework** for building modular HTTP services.

Its responsibility is to provide the common runtime foundation required by applications:

- Fastify application creation
- environment and service configuration
- lifecycle management
- builtin Fastify plugins
- infrastructure integrations
- request/server hooks
- health monitoring
- structured logging
- response/error management
- serialization
- graceful shutdown
- application plugin registration
- application-level configuration

The package does **not** contain application/domain logic.

The architectural boundary is:

```text
┌─────────────────────────────────────────────┐
│              SERVER PACKAGE                 │
│                                             │
│  Bootstrap                                  │
│  Configuration                              │
│  Lifecycle                                  │
│  Fastify                                    │
│  Builtin plugins                            │
│  Infrastructure                             │
│  Health                                     │
│  Logging                                    │
│  Error/response management                  │
│  Serialization                              │
│  Graceful shutdown                          │
│  Extension/plugin system                    │
└──────────────────────┬──────────────────────┘
                       │
                       │ provides runtime
                       ▼
┌─────────────────────────────────────────────┐
│                APPLICATION                  │
│                                             │
│  Routes                                     │
│  Controllers                                │
│  Services                                   │
│  Repositories                               │
│  Domain logic                               │
│  Business rules                             │
│  Application plugins                        │
└─────────────────────────────────────────────┘
```

The server package provides the runtime; the application provides the behavior.

---

# 2. Architectural Principles

The package follows these principles:

### 2.1 Bootstrap is orchestration only

`bootstrap.ts` coordinates the server lifecycle.

It should not contain implementation details for:

- PostgreSQL
- Redis
- Kafka
- WebSockets
- CORS
- validation
- logging

Those responsibilities belong to their respective modules.

### 2.2 Plugins are isolated

Each builtin plugin owns:

- initialization
- configuration
- Fastify registration
- optional dependency loading
- health registration
- cleanup

where applicable.

### 2.3 Infrastructure is lifecycle managed

External resources must follow:

```text
initialize
    ↓
register/decorate
    ↓
health registration
    ↓
application usage
    ↓
cleanup
```

Resources must not be initialized merely because their modules are imported.

### 2.4 Optional infrastructure remains optional

If an infrastructure plugin is disabled:

```ts
redis: false
```

the Redis dependency must not be initialized.

If an enabled plugin requires a missing dependency, startup must fail with a clear error.

### 2.5 Application code extends the runtime

Applications should extend the package through:

- custom plugins
- hooks
- `configure()`
- health providers
- configuration

They should not modify server internals.

---

# 3. Package Structure

```text
src/
├── server.ts
├── index.ts
├── bootstrap.ts
│
├── config/
│   ├── env.ts
│   ├── env-services.ts
│   ├── load-env.ts
│   └── index.ts
│
├── plugins/
│   ├── index.ts
│   │
│   ├── core/
│   │   ├── logger.ts
│   │   ├── errors.ts
│   │   ├── response-management.ts
│   │   ├── msgpack.ts
│   │   └── system-health.ts
│   │
│   ├── http/
│   │   ├── cors.ts
│   │   ├── helmet.ts
│   │   ├── cookie.ts
│   │   ├── compress.ts
│   │   ├── rate-limit.ts
│   │   ├── request-context.ts
│   │   ├── multipart.ts
│   │   └── zod.ts
│   │
│   ├── security/
│   │   └── csrf.ts
│   │
│   ├── performance/
│   │   └── under-pressure.ts
│   │
│   ├── infrastructure/
│   │   ├── database.ts
│   │   ├── redis.ts
│   │   └── kafka.ts
│   │
│   ├── realtime/
│   │   └── realtime.ts
│   │
│   └── documentation/
│       ├── swagger.ts
│       └── swagger-ui.ts
│
├── hooks/
│   ├── index.ts
│   ├── request.ts
│   └── server.ts
│
├── health/
│   ├── index.ts
│   ├── registry.ts
│   ├── provider.ts
│   ├── route.ts
│   └── types.ts
│
├── routes/
│   ├── index.ts
│   └── health.ts
│
├── lib/
│   ├── index.ts
│   ├── formatter.ts
│   ├── system.ts
│   ├── system-status.ts
│   ├── collect-metadata.ts
│   └── cookies.ts
│
└── types/
    ├── index.ts
    ├── bootstrap.ts
    ├── plugins.ts
    ├── health.ts
    └── hooks.ts
```

---

# 4. Entry Points

## 4.1 `src/server.ts`

Executable/CLI entry point. Remains minimal:

```ts
import { startBootstrapServer } from "./bootstrap.js";
import { serviceConfig } from "./config/env-services.js";

export async function start() {
  const config = serviceConfig(8080, "127.0.0.1", "server");
  return startBootstrapServer({
    serviceName: config.serviceName,
    host: config.host,
    port: config.port,
    logger: config.isDevelopment,
    gracefulShutdown: true,
  });
}
```

It must not contain database initialization, route definitions, or domain logic.

---

## 4.2 `src/index.ts`

Public package API. Only public APIs intended for consumers are exported.

Exports include:

```ts
export {
  createBootstrapServer,
  startBootstrapServer,
  createServer,        // alias
  startServer,         // alias
} from "./bootstrap.js";

export type {
  BootstrapServerOptions,
  StartedBootstrapServer,
  PluginEntry,
  Configurer,
} from "./types/bootstrap.js";

export type {
  BuiltinPluginsOptions,
  PluginConfig,
  DatabasePluginOptions,
  KafkaPluginOptions,
  RedisPluginOptions,
  RealtimePluginOptions,
  LoggerPluginOptions,
  // ...all plugin option types
} from "./types/plugins.js";

export type {
  HealthStatus,
  HealthCheckResult,
  HealthProvider,
  HealthRegistry,
  // ...
} from "./types/health.js";

export type { BootstrapHooks, HookList } from "./types/hooks.js";
```

Internal implementation details must not be exported accidentally.

---

# 5. Bootstrap

`src/bootstrap.ts` is the central orchestration layer.

Its responsibilities are:

1. Resolve options (port overload or options object)
2. Load environment (`loadEnv`)
3. Resolve service configuration (`serviceConfig`)
4. Create Fastify instance
5. Register health registry (early, before plugins)
6. Register system health provider
7. Register lifecycle hooks
8. Register all builtin plugins (in deterministic order)
9. Register health route
10. Register application/custom plugins
11. Execute `configure()`
12. Return the Fastify instance (`createBootstrapServer`)
13. Call `app.listen()` (`startBootstrapServer`)
14. Optionally attach graceful shutdown

---

# 6. Bootstrap Lifecycle

The canonical lifecycle is:

```text
startBootstrapServer(options)
  │
  ▼
resolveOptions()
  │
  ▼
loadEnv()
  │
  ▼
serviceConfig()
  │
  ▼
fastify(options)
  │
  ├── registerHealthRegistry()
  │
  ├── registerSystemHealthProvider()
  │
  ├── registerHooks()
  │
  ├── registerBuiltinPlugins()
  │   ├── framework primitives (zod, logger, errors, responseManagement, msgpack)
  │   ├── request infrastructure (requestContext)
  │   ├── security (helmet, cookie, csrf)
  │   ├── HTTP middleware (cors, compress, rateLimit, multipart)
  │   ├── performance (underPressure)
  │   ├── infrastructure (database, redis, kafka, realtime)
  │   ├── health providers (system)
  │   └── documentation (swagger, swaggerUI)
  │
  ├── register health route (GET /health)
  │
  ├── register application plugins (plugins / extraPlugins)
  │
  └── configure(app)
  │
  ▼
app.listen()          [startBootstrapServer only]
  │
  ▼
attachGracefulShutdown()   [if gracefulShutdown: true]
  │
  ▼
StartedBootstrapServer { app, address, port, host, close }
```

---

# 7. Bootstrap Ordering

Plugin ordering is deterministic. The phases registered by `registerBuiltinPlugins` are:

```text
1. Framework primitives
   ├── zod (type provider)
   ├── logger
   ├── errorHandler
   ├── responseManagement
   └── msgpack

2. Request infrastructure
   └── requestContext

3. Security
   ├── helmet
   ├── cookie
   └── csrf

4. HTTP middleware
   ├── cors
   ├── compress
   ├── rateLimit
   └── multipart

5. Performance
   └── underPressure

6. Infrastructure
   ├── database
   ├── redis
   ├── kafka
   └── realtime

7. Health providers
   └── system health provider

8. Documentation
   ├── swagger
   └── swaggerUI
```

After all builtins:

```text
9. Application/custom plugins (plugins / extraPlugins)
10. configure()
```

Any intentional deviation must be documented.

---

# 8. Bootstrap Types

The main configuration type is:

```ts
interface BootstrapServerOptions {
  serviceName?: string;
  host?: string;
  port?: number;

  // Framework plugins
  logger?: boolean | LoggerPluginOptions | FastifyServerOptions["logger"];
  errorHandler?: PluginConfig<ErrorHandlerPluginOptions>;
  responseManagement?: PluginConfig;
  msgpack?: PluginConfig<MsgpackPluginOptions>;
  zod?: boolean;

  // HTTP plugins
  cors?: PluginConfig<CorsPluginOptions>;
  helmet?: PluginConfig<HelmetPluginOptions>;
  cookie?: PluginConfig<CookiePluginOptions>;
  compress?: PluginConfig<CompressPluginOptions>;
  rateLimit?: PluginConfig<RateLimitPluginOptions>;
  requestContext?: PluginConfig<RequestContextPluginOptions>;
  multipart?: PluginConfig<MultipartPluginOptions>;

  // Security
  csrf?: PluginConfig<CsrfPluginOptions>;

  // Performance
  underPressure?: PluginConfig<UnderPressurePluginOptions>;

  // Infrastructure
  database?: boolean | DatabasePluginOptions;
  redis?: PluginConfig<RedisPluginOptions>;
  kafka?: PluginConfig<KafkaPluginOptions>;
  realtime?: PluginConfig<RealtimePluginOptions>;

  // Documentation
  swagger?: PluginConfig<SwaggerPluginOptions>;
  swaggerUI?: PluginConfig<SwaggerUIPluginOptions>;

  // Extension
  fastify?: FastifyServerOptions;
  plugins?: PluginEntry[] | BuiltinPluginsOptions;
  extraPlugins?: PluginEntry[];
  hooks?: BootstrapHooks;
  configure?: (app: FastifyInstance) => void | Promise<void>;
  health?: false | BootstrapHealthOptions;
  listen?: FastifyListenOptions;
  env?: false | LoadEnvOptions;
  gracefulShutdown?: boolean;
}
```

The started server exposes:

```ts
interface StartedBootstrapServer {
  app: FastifyInstance;
  address: string;
  port: number;
  host: string;
  close(): Promise<void>;
}
```

---

# 9. Configuration

```text
config/
├── env.ts           – typed env helpers: envString(), envNumber(), envBool()
├── env-services.ts  – serviceConfig(), nodeEnv, isDevelopment, isTest
├── load-env.ts      – .env file loading, validation, environment precedence
└── index.ts         – re-exports
```

### `env.ts`

Provides typed environment helpers:

```text
envString()
envNumber()
envBool()
```

### `env-services.ts`

Provides service-level configuration:

```text
serviceConfig()  → { serviceName, host, port, isDevelopment, isTest, ... }
nodeEnv
```

### `load-env.ts`

Responsible for:

- loading environment files (`.env`, `.env.local`, etc.)
- environment validation
- environment precedence
- environment-specific behavior

Environment loading remains separate from infrastructure initialization.

---

# 10. Plugins

Builtin plugins are organized into eight categories, each in their own subdirectory.

## 10.1 Core / Framework plugins

```text
plugins/core/
├── logger.ts            – @oneunit/logger or Pino integration
├── errors.ts            – global error handler
├── response-management.ts – common response layer
├── msgpack.ts           – MessagePack serialization
└── system-health.ts     – system health provider registration
```

These implement common runtime behavior supplied by the server package.

## 10.2 HTTP plugins

```text
plugins/http/
├── cors.ts              – @fastify/cors
├── helmet.ts            – @fastify/helmet
├── cookie.ts            – @fastify/cookie
├── compress.ts          – @fastify/compress
├── rate-limit.ts        – @fastify/rate-limit
├── request-context.ts   – @fastify/request-context
├── multipart.ts         – @fastify/multipart
└── zod.ts               – fastify-type-provider-zod
```

These modify Fastify's HTTP/request behavior.

## 10.3 Security plugins

```text
plugins/security/
└── csrf.ts              – @fastify/csrf-protection
```

## 10.4 Performance plugins

```text
plugins/performance/
└── under-pressure.ts    – @fastify/under-pressure
```

## 10.5 Infrastructure plugins

```text
plugins/infrastructure/
├── database.ts          – @oneunit/database (PostgreSQL)
├── redis.ts             – @oneunit/redis
└── kafka.ts             – @oneunit/kafka
```

These integrate external resources and must own their lifecycle.

## 10.6 Realtime plugins

```text
plugins/realtime/
└── realtime.ts          – @oneunit/realtime (WebSocket)
```

## 10.7 Documentation plugins

```text
plugins/documentation/
├── swagger.ts           – @fastify/swagger
└── swagger-ui.ts        – @fastify/swagger-ui
```

---

# 11. Builtin Plugin Registry

`src/plugins/index.ts` provides the central builtin plugin registry.

Each builtin plugin supports:

```ts
false        // disabled
true         // enabled with defaults
{ ... }      // enabled with custom options
```

The unified `PluginConfig<T>` type is:

```ts
type PluginConfig<T extends object = Record<string, unknown>> = boolean | T;
```

Default values for all plugins are defined in `DEFAULT_BUILTIN_PLUGINS`:

```ts
const DEFAULT_BUILTIN_PLUGINS: BuiltinPluginsOptions = {
  cors: { origin: true, credentials: true },
  helmet: true,
  cookie: true,
  compress: true,
  rateLimit: { max: 1000, timeWindow: "1 minute" },
  zod: true,
  responseManagement: true,
  logger: { useHttpLogger: true },
  database: { logQueries: false },
  kafka: { autoConnectProducer: false },
  redis: { healthCheck: false },
  realtime: false,
  errorHandler: { includeStack: false, logErrors: true },
  msgpack: { enableBuiltin: true },
  requestContext: true,
  multipart: false,
  csrf: false,
  underPressure: false,
  swagger: false,
  swaggerUI: false,
};
```

The registry is responsible for:

- resolving enabled plugins via `mergeBuiltinPlugins()`
- applying defaults
- loading optional dependencies lazily
- registering plugins in deterministic order through `registerBuiltinPlugins()`

---

# 12. Optional Dependencies

Optional infrastructure dependencies are loaded lazily through dynamic `import()`.

```text
database disabled
    ↓
PostgreSQL dependency is not initialized

database enabled
    ↓
@oneunit/database is loaded
```

If a required dependency is missing:

```text
plugin enabled
+
dependency missing (peer not installed)
        ↓
clear startup error
```

The package must not silently continue with a broken infrastructure plugin.

Missing optional peers where the plugin is disabled are silently skipped.

---

# 13. Plugin Lifecycle

An infrastructure plugin follows:

```text
Plugin registration
       ↓
Dependency initialization
       ↓
Fastify decoration
       ↓
Health provider registration
       ↓
Application usage
       ↓
Fastify close
       ↓
Resource cleanup
```

For example:

```text
database
   │
   ├── connect
   ├── app.decorate("db", ...)
   ├── health.register(...)
   └── onClose → disconnect
```

The same principle applies to Redis, Kafka, and realtime infrastructure.

---

# 14. Custom Plugins

Applications extend the server through:

```ts
plugins?: PluginEntry[];
extraPlugins?: PluginEntry[];
```

`PluginEntry` is either a plain `FastifyPluginAsync` or a `{ plugin, options }` registration object.

Example:

```ts
await startServer({
  plugins: [
    accountPlugin,
    authPlugin,
    { plugin: userPlugin, options: { prefix: "/users" } },
  ],
});
```

Custom plugins execute after all builtin infrastructure has been registered.

---

# 15. `plugins` vs `extraPlugins`

`plugins` accepts two forms:

1. `PluginEntry[]` — application plugin list
2. `BuiltinPluginsOptions` — shorthand object to configure builtin plugins

When `plugins` is a `BuiltinPluginsOptions` object, application plugins must be passed via `extraPlugins`.

```ts
// Named builtin configuration
await startServer({
  plugins: {
    cors: { origin: ["http://localhost:5173"] },
    rateLimit: { max: 100 },
  },
  extraPlugins: [greetPlugin],
});
```

Internally, `resolvePluginEntries()` normalizes both into a single plugin list.

---

# 16. Configure Hook

Applications may provide:

```ts
configure(app)
```

This runs after builtin and custom plugins have been registered.

```ts
await startServer({
  configure(app) {
    app.get("/users", async () => []);
  },
});
```

`configure()` can:

- register routes
- register decorators
- register application-specific hooks
- configure application-specific Fastify behavior

It must not be responsible for initializing builtin infrastructure.

---

# 17. Hooks

Hooks are divided into request and server lifecycle hooks.

Types are defined in `src/types/hooks.ts` and registered in `src/hooks/`.

## Request lifecycle

```text
onRequest
preParsing
preValidation
preHandler
preSerialization
onSend
onResponse
onError
onTimeout
onRequestAbort
```

## Server lifecycle

```text
onReady
onListen
onClose
onRoute
onRegister
```

The package provides centralized registration while allowing applications to supply custom hooks through `BootstrapHooks`.

---

# 18. Health System

Health is a first-class subsystem.

```text
health/
├── index.ts       – exports
├── registry.ts    – HealthRegistry, registerHealthRegistry()
├── provider.ts    – provider runner
├── route.ts       – GET /health handler
└── types.ts       – HealthStatus, HealthCheckResult, HealthProvider
```

The health registry is registered on the Fastify instance **before any infrastructure plugins** so that each plugin can call `health.register()` during its own initialization.

The health system provides:

- provider registration
- provider execution
- status aggregation
- `/health` endpoint
- infrastructure health checks

---

# 19. Health Providers

Infrastructure plugins register health providers.

```ts
health.register({
  name: "database",
  async check() {
    await db.query("SELECT 1");
    return { status: "healthy" };
  },
});
```

The system health provider is always registered and reports memory and CPU metrics.

The health route must not contain hardcoded knowledge of individual infrastructure systems.

---

# 20. Health Status

```ts
type HealthStatus = "healthy" | "degraded" | "unhealthy";
```

Overall status aggregation:

```text
all healthy         → healthy
healthy + degraded  → degraded
any unhealthy       → unhealthy
```

Provider exceptions are converted to `{ status: "unhealthy" }` rather than crashing the health subsystem.

---

# 21. Health Endpoint

Default endpoint:

```text
GET /health
```

Response structure:

```json
{
  "status": "healthy",
  "service": "api",
  "checks": {
    "system": { "status": "healthy", "memory": { ... }, "uptime": 123 },
    "database": { "status": "healthy" }
  }
}
```

Health is customizable through `options.health`. Disable with `health: false`.

---

# 22. Routes

The default route layer:

```text
routes/
├── index.ts
└── health.ts    – createHealthPlugin(), GET /health
```

The health route is framework infrastructure.

Application routes should be registered through:

- custom plugins
- `configure()`

They must not be hardcoded into the server package.

---

# 23. Library

`src/lib/` contains reusable low-level utilities.

```text
lib/
├── index.ts           – re-exports
├── formatter.ts       – byte/time formatting utilities
├── system.ts          – system information and metrics
├── system-status.ts   – runtime status helpers
├── collect-metadata.ts – request metadata collection
└── cookies.ts         – cookie option presets
```

Library modules are independent from application/domain logic and contain no Fastify-specific registration code.

---

# 24. System Status

`lib/system-status.ts` is the single authoritative implementation for runtime system status helpers.

There is no duplicate `config/system-status.ts`. Configuration-related thresholds live in `config/`, while runtime health/status behavior lives in `lib/`.

---

# 25. Database Plugin

`plugins/infrastructure/database.ts` provides PostgreSQL integration via `@oneunit/database`.

Responsibilities:

```text
configuration         – from DatabasePluginOptions
connection            – lazy connect on plugin registration
Fastify decoration    – app.decorate("db", ...)
health provider       – registers "database" check
query/client access   – exposed via app.db
shutdown cleanup      – disconnect on onClose
```

Options:

```text
connectionString, host, port, database, user, password
max, idleTimeoutMillis, connectionTimeoutMillis, ssl
logQueries, logParameters, slowQueryMs, queryTimeout
retry, onQuery, onError, onRetry callbacks
```

It must not define application repositories or domain models.

---

# 26. Redis Plugin

`plugins/infrastructure/redis.ts` provides Redis integration via `@oneunit/redis`.

Responsibilities:

```text
configuration         – from RedisPluginOptions
connection            – lazy connect
Fastify decoration    – app.decorate("redis", ...)
health provider       – optional ping check
shutdown cleanup      – disconnect on onClose
```

Redis must not be initialized when disabled.

---

# 27. Kafka Plugin

`plugins/infrastructure/kafka.ts` provides Kafka producer/consumer integration via `@oneunit/kafka`.

Responsibilities:

```text
configuration         – from KafkaPluginOptions
producer lifecycle    – optional auto-connect
consumer lifecycle    – optional subscribe + message handler
Fastify integration   – app.decorate("kafka", ...)
health provider       – connection check
shutdown cleanup      – disconnect producer/consumer
```

Options include `brokers`, `clientId`, `groupId`, `ssl`, `sasl`, `autoConnectProducer`, `subscribeTopics`, `onMessage`, `producer`, `consumer`, `admin`.

Kafka application topics and domain event semantics belong to the application.

---

# 28. Realtime Plugin

`plugins/realtime/realtime.ts` provides WebSocket/realtime infrastructure via `@oneunit/realtime`.

Responsibilities:

```text
WebSocket initialization   – fastify or ws library
connection lifecycle
Fastify integration
optional route registration
shutdown cleanup
```

Options: `websocketLibrary` (`"fastify"` | `"ws"`), `path`, `routes`.

Application-specific WebSocket events belong to application plugins.

---

# 29. Logger

Logging is centralized in `plugins/core/logger.ts`.

The package uses Fastify/Pino logging with optional `@oneunit/logger` integration.

Development defaults:

```text
logger enabled
pretty output
```

Production defaults:

```text
structured JSON logging
HTTP request logging
```

`LoggerPluginOptions`: `useHttpLogger`, `serviceName`, `mode`, `serializers`, `childBindings`.

Plugins must not independently create unrelated global logger instances.

---

# 30. Error Handling

`plugins/core/errors.ts` provides global error handling.

`ErrorHandlerPluginOptions`: `includeStack`, `logErrors`, `customHandler`.

It should:

- normalize known errors
- preserve appropriate HTTP status
- integrate with response management
- log unexpected errors
- avoid exposing sensitive information in production
- include stack traces in development when `includeStack: true`

Domain-specific error semantics belong to the application.

---

# 31. Response Management

`plugins/core/response-management.ts` provides the common response layer.

It integrates with:

```text
validation (zod)
error handling
HTTP status
logging
serialization (msgpack)
```

The package must not impose application-specific response payloads.

---

# 32. MessagePack

`plugins/core/msgpack.ts` provides optional MessagePack serialization via `@msgpack/msgpack`.

`MsgpackPluginOptions`: `enableBuiltin`, `extensions`.

MessagePack must not force all HTTP responses to use binary encoding.

---

# 33. CSRF Protection

`plugins/security/csrf.ts` provides CSRF protection via `@fastify/csrf-protection`.

Disabled by default (`csrf: false`).

`CsrfPluginOptions`: `cookieOpts`, `cookieName`, `sessionKey`, `sessionPlugin`, `getToken`, `getUserInfo`, `ignoreMethods`, `ignoreRoutes`, `keyGenerator`, `skipCheck`.

---

# 34. Under Pressure

`plugins/performance/under-pressure.ts` monitors back-pressure via `@fastify/under-pressure`.

Disabled by default (`underPressure: false`).

`UnderPressurePluginOptions`: `maxEventLoopDelay`, `maxHeapUsedBytes`, `maxRssBytes`, `maxEventLoopUtilization`, `message`, `retryAfter`, `exposeRoute`, `healthCheck`.

---

# 35. Swagger / OpenAPI

Documentation plugins are disabled by default.

```ts
swagger: false,
swaggerUI: false,
```

`plugins/documentation/swagger.ts` — `@fastify/swagger`
`plugins/documentation/swagger-ui.ts` — `@fastify/swagger-ui`

`SwaggerPluginOptions`: `openapi.info`, `openapi.components.securitySchemes`, `openapi.tags`, `hideUntagged`, `stripBasePath`, `transform`, `transformSpec`.

`SwaggerUIPluginOptions`: `routePrefix`, `uiConfig`, `staticCSP`, `transformSpecification`.

---

# 36. Fastify Decorations

Infrastructure resources exposed through Fastify must use Fastify module augmentation.

Example:

```ts
declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    redis: Redis;
    kafka: KafkaClients;
  }
}
```

Avoid `any`. Decorations should only exist when the corresponding plugin is enabled.

---

# 37. Graceful Shutdown

The server supports:

```text
SIGINT
SIGTERM
```

Shutdown is opt-in via `gracefulShutdown: true`.

Shutdown sequence:

```text
signal
  ↓
shuttingDown guard (idempotent)
  ↓
server.close()
  ↓
plugin onClose hooks
  ↓
infrastructure cleanup
  ↓
process.exit(0)
```

Shutdown is idempotent: calling `close()` multiple times must not cause duplicate cleanup or errors.

Signal handlers are registered with `process.once()` to prevent duplicate registration.

---

# 38. Startup Failure Cleanup

If plugin registration throws, Fastify's built-in error propagation handles cleanup.

Conceptually:

```text
Plugin A → success
Plugin B → success
Plugin C → failure
    ↓
Fastify error propagates
    ↓
startup rejects
```

No partially initialized server should remain running.

---

# 39. Defaults

```text
Port:   8080
Host:   127.0.0.1
```

Default health:

```text
GET /health
```

Default shutdown signals (when gracefulShutdown: true):

```text
SIGINT
SIGTERM
```

Default builtin plugin states:

```text
Enabled by default:
  cors, helmet, cookie, compress, rateLimit, zod
  logger, errorHandler, responseManagement, msgpack, requestContext

Disabled by default:
  database, kafka, redis, realtime
  multipart, csrf, underPressure, swagger, swaggerUI
```

---

# 40. Environment Modes

The runtime supports:

```text
development  – human-readable logging, development diagnostics
test         – minimal external dependencies, deterministic behavior
production   – structured JSON logging, secure defaults, reduced diagnostics
```

Mode is detected from `NODE_ENV` via `env-services.ts`.

---

# 41. Public Extension Points

The supported extension points are:

### 1. Custom plugins

```ts
plugins: []        // PluginEntry[]
extraPlugins: []   // PluginEntry[]
```

### 2. Hooks

```ts
hooks: BootstrapHooks
```

### 3. Configure callback

```ts
configure(app: FastifyInstance)
```

### 4. Health providers

```ts
// via health registry on app
app.health.register({ name, check })
```

### 5. Environment configuration

```ts
env: LoadEnvOptions
```

These are the primary application integration mechanisms.

---

# 42. Public API Example

Minimal application:

```ts
import { startServer } from "@oneunit/server";

const { address, close } = await startServer({
  port: 4000,
  serviceName: "api",
  gracefulShutdown: true,

  plugins: [accountPlugin, authPlugin],

  configure(app) {
    app.get("/", async () => ({ status: "ok" }));
  },
});
```

The application should not need to manually initialize Fastify, logger, health, shutdown, or environment unless intentionally overriding framework defaults.

---

# 43. Testing Architecture

Tests reside in `test/`.

Currently:

```text
test/
└── bootstrap.test.ts   – bootstrap integration tests
```

Tests use real Fastify instances via Vitest.

Testing should cover:

```text
configuration
plugins
plugin ordering
plugin lifecycle
hooks
health
bootstrap
startup failure
shutdown
custom extensions
HTTP behavior (injection)
public API
```

---

# 44. Integration Testing

Integration tests use real Fastify instances.

They verify:

```text
Fastify
+
builtin plugins
+
hooks
+
health
+
custom plugins
+
HTTP (inject)
```

Use Fastify's injection mechanism (`app.inject()`) where possible.

External infrastructure should be tested separately using isolated services.

---

# 45. Static Validation

The package must pass:

```bash
npm run typecheck
# → tsc -p tsconfig.json --noEmit
```

---

# 46. Test Commands

Available scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -w -p tsconfig.json"
  }
}
```

---

# 47. Architecture Data Flow

```text
                         APPLICATION
                              │
                    plugins / configure
                              │
                              ▼
┌──────────────────────────────────────────────────┐
│                  BOOTSTRAP                       │
│                                                  │
│  loadEnv                                         │
│      ↓                                           │
│  serviceConfig                                   │
│      ↓                                           │
│  create Fastify                                  │
│      ↓                                           │
│  health registry (early)                         │
│      ↓                                           │
│  system health provider                          │
│      ↓                                           │
│  hooks                                           │
│      ↓                                           │
│  framework primitives                            │
│      ↓                                           │
│  request infrastructure                          │
│      ↓                                           │
│  security                                        │
│      ↓                                           │
│  HTTP middleware                                 │
│      ↓                                           │
│  performance                                     │
│      ↓                                           │
│  infrastructure plugins                          │
│      ↓                                           │
│  documentation                                   │
│      ↓                                           │
│  health route                                    │
│      ↓                                           │
│  application plugins                             │
│      ↓                                           │
│  configure()                                     │
│      ↓                                           │
│  app.listen()                                    │
│                                                  │
└────────────────────────┬─────────────────────────┘
                         │
                         ▼
                    RUNNING SERVER
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
          HTTP        Health    Infrastructure
             │           │           │
             └───────────┼───────────┘
                         ▼
                      Shutdown
                         │
                         ▼
                     Cleanup
```

---

# 48. Complete Architecture Summary

The package consists of six major runtime layers:

```text
┌──────────────────────────────────────────────┐
│  1. CONFIGURATION                            │
│  env / service configuration / validation   │
├──────────────────────────────────────────────┤
│  2. BOOTSTRAP                                │
│  server creation / orchestration             │
├──────────────────────────────────────────────┤
│  3. PLUGIN RUNTIME                           │
│  core / HTTP / security / performance /      │
│  infrastructure / realtime / documentation   │
├──────────────────────────────────────────────┤
│  4. LIFECYCLE                                │
│  hooks / startup / shutdown                  │
├──────────────────────────────────────────────┤
│  5. HEALTH                                   │
│  registry / providers / health endpoint      │
├──────────────────────────────────────────────┤
│  6. EXTENSION                                │
│  application plugins / configure / hooks     │
└──────────────────────────────────────────────┘
```

The resulting responsibility model:

```text
Server Package
    │
    ├── creates runtime
    ├── manages lifecycle
    ├── manages infrastructure
    ├── provides common HTTP behavior
    ├── exposes health
    ├── manages errors/logging
    └── provides extension points
             │
             ▼
Application
    │
    ├── routes
    ├── controllers
    ├── services
    ├── repositories
    ├── domain logic
    └── business behavior
```

This separation keeps the server package reusable across multiple services while allowing each application to define its own behavior without modifying the framework runtime.