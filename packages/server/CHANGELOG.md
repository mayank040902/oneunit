# Changelog

All notable changes to this project are documented in this file.

## 1.0.0 - 2026-09-26

### Added

- `startBootstrapServer` / `createBootstrapServer` as canonical exports, with `startServer` / `createServer` as convenience aliases
- Overloaded entry point: `(port, options)` or `(options)` call signatures
- `BootstrapServerOptions` covering all builtin and infrastructure plugin knobs
- `StartedBootstrapServer` return type with `app`, `address`, `port`, `host`, and `close()`

**Framework plugins (enabled by default):**
- `logger` — structured logging via `@oneunit/logger` or Fastify/Pino
- `errorHandler` — global error normalization with dev/prod stack-trace control
- `responseManagement` — common response serialization layer
- `msgpack` — optional MessagePack serialization via `@msgpack/msgpack`
- `zod` — Zod type provider via `fastify-type-provider-zod`
- `cors` — CORS headers via `@fastify/cors` (default: `origin: true, credentials: true`)
- `helmet` — security headers via `@fastify/helmet`
- `cookie` — cookie parsing via `@fastify/cookie`
- `compress` — response compression via `@fastify/compress`
- `rateLimit` — rate limiting via `@fastify/rate-limit` (default: 1000 req/min)
- `requestContext` — per-request context via `@fastify/request-context`

**Infrastructure plugins (optional peers):**
- `database` — PostgreSQL integration via `@oneunit/database`
- `redis` — Redis integration via `@oneunit/redis`
- `kafka` — Kafka producer/consumer via `@oneunit/kafka`
- `realtime` — WebSocket/realtime via `@oneunit/realtime`

**Optional plugins (disabled by default):**
- `multipart` — file upload via `@fastify/multipart`
- `csrf` — CSRF protection via `@fastify/csrf-protection`
- `underPressure` — back-pressure monitoring via `@fastify/under-pressure`
- `swagger` — OpenAPI schema generation via `@fastify/swagger`
- `swaggerUI` — Swagger UI via `@fastify/swagger-ui`

**Plugin registry:**
- Deterministic 8-phase builtin plugin registration order
- Lazy optional-dependency loading — missing peer packages skip or fail gracefully
- `PluginConfig<T>` unified type (`boolean | T`) for every plugin option

**Health system:**
- Health registry registered before infrastructure plugins so each plugin can add health providers
- Built-in system health provider (memory/CPU metrics)
- `GET /health` route with aggregated status (`healthy` / `degraded` / `unhealthy`)
- `BootstrapHealthOptions` for customization; disable with `health: false`

**Plugin structure:**
- Plugins organized into subdirectories: `core/`, `http/`, `security/`, `performance/`, `infrastructure/`, `realtime/`, `documentation/`
- All individual plugin factories exported from `@oneunit/server/plugins`

**Other:**
- Environment loading via `dotenv` with `env` option; skip with `env: false`
- Hooks: request lifecycle (`onRequest`, `preParsing`, `preValidation`, `preHandler`, `preSerialization`, `onSend`, `onResponse`, `onError`, `onTimeout`, `onRequestAbort`) and server lifecycle (`onReady`, `onListen`, `onClose`, `onRoute`, `onRegister`)
- Graceful shutdown on `SIGINT`/`SIGTERM` with idempotent `close()` (opt-in via `gracefulShutdown: true`)
- `configure(app)` callback runs after all builtin and custom plugins
- `extraPlugins` array for additional application plugins alongside the `plugins` shorthand
- TypeScript declarations, Vitest tests, runnable `examples/`, and npm package metadata
- Published independently as `@oneunit/server`; sibling packages are optional peer dependencies
