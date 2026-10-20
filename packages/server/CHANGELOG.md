# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- `ResponseManagementPluginOptions` is no longer empty: `redactMetadata`, `metadataLimits`, `defaultMessage`, and `defaultCode` configure the response layer
- `reply.validationFailed({ fields, message?, metadata? })` — a 400 failure whose payload is a field-keyed error map, the shape a client binds to its inputs
- `errorHandler: { errorEnvelope: true }` — answers framework errors (malformed body, unsupported media type, unmatched route, route schema that did not validate) in the response layer's envelope, so the client reads one shape for every failure
- `toValidationFields(issues)` — maps the issues of any validation library (Zod, Joi, Yup) to that field-keyed map, keeping only the issue message and dropping validator internals
- `sanitizeMetadata(metadata, options)` and the `DEFAULT_METADATA_LIMITS` / `DEFAULT_SENSITIVE_METADATA_KEYS` constants
- `ResponseManager`, `ApiResponse`, `PaginationMeta`, `MetadataLimits`, `ValidationErrorPayload`, `resolveHttpStatus`, and the `ResponseOptions` / `SuccessOptions` / `PaginatedOptions` / `FailureOptions` / `FailedOptions` / `ValidationFailedOptions` types are exported from the package barrel

### Changed

- **Breaking** — every reply helper takes a single options object with named fields. The parts of a response must be identifiable by name: `data` and `metadata` share a type, so a positional API could not tell a swapped argument apart, and the order was not consistent across the family (a success took the payload first, a failure took the message first). Passing the old positional shape now throws
- **Breaking** — the error helpers take `(message?, data?, metadata?)` in the positional form, which is replaced by `({ message?, data?, metadata? })`; `failed` takes `({ message?, code?, data?, metadata?, statusCode? })`
- **Breaking** — the error helpers report the platform error code rather than the HTTP status as a string: `badRequest` → `"BAD_REQUEST"`, `unauthorized` → `"AUTHENTICATION_ERROR"`, `forbidden` → `"AUTHORIZATION_ERROR"`, `notFound` → `"NOT_FOUND"`, `conflict` → `"CONFLICT"`, `unprocessable` → `"UNPROCESSABLE_ENTITY"`, `serverError` → `"INTERNAL_ERROR"`, `validationFailed` → `"VALIDATION_ERROR"`. A success keeps the HTTP status (`"200"`, `"201"`). A numeric `code` is still accepted and still sets the HTTP status
- Response `metadata` is sanitised before it is sent: sensitive keys are masked and the payload is bounded. The `data` payload is never rewritten
- A symbolic `code` now resolves to its HTTP status (`NOT_FOUND` → 404) instead of silently degrading to 400; pass `statusCode` to override
- `ApiResponse.data` is no longer limited to success responses

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
