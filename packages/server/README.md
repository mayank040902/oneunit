# @oneunit/server

Fastify-based server bootstrap with optional plugins for logging, database, Kafka, Redis, realtime, CSRF, Swagger/OpenAPI, compression, and more.

Monorepo: https://github.com/mayank040902/oneunit

Sibling packages are optional peers. Install only the ones you enable.

## Install

```bash
npm install @oneunit/server
```

Requires **Node.js 20+**.

Optional sibling packages:

```bash
npm install @oneunit/logger
npm install @oneunit/database
npm install @oneunit/kafka
npm install @oneunit/redis
npm install @oneunit/realtime
npm install @oneunit/errors
```

## Quick start

```typescript
import { startServer } from "@oneunit/server";

const { address, close } = await startServer(8080, {
  serviceName: "api",
  logger: true,
  gracefulShutdown: true,
});

console.log(`listening at ${address}`);
```

### Create without listening

```typescript
import { createServer } from "@oneunit/server";

const app = await createServer({
  serviceName: "api",
  logger: true,
  database: false,
  kafka: false,
  realtime: false,
});

await app.ready();
// inject requests, run tests, then:
await app.close();
```

### Custom plugins and routes

```typescript
import type { FastifyInstance } from "fastify";
import { startServer } from "@oneunit/server";

async function myPlugin(server: FastifyInstance) {
  server.get("/hello", async () => ({ hello: "world" }));
}

await startServer({
  serviceName: "api",
  plugins: [myPlugin],
  configure(app) {
    app.get("/", async () => ({ status: "ok" }));
  },
});
```

## Options

### Core

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `serviceName` | `string` | `"app"` | Service name used in health and logs |
| `host` | `string` | `"127.0.0.1"` | Listen host |
| `port` | `number` | `8080` | Listen port |
| `fastify` | `FastifyServerOptions` | — | Raw Fastify instance options |
| `listen` | `FastifyListenOptions` | — | Fastify listen options (overrides `host`/`port`) |
| `env` | `false \| LoadEnvOptions` | `{}` | `.env` file loading options, or `false` to skip |
| `gracefulShutdown` | `boolean` | `false` | Register `SIGINT`/`SIGTERM` handlers automatically |

### Application extension

| Option | Type | Description |
| :--- | :--- | :--- |
| `plugins` | `FastifyPluginAsync[] \| BuiltinPluginsOptions` | Custom application plugins, or a builtin plugin config object |
| `extraPlugins` | `FastifyPluginAsync[]` | Additional custom plugins (always an array) |
| `configure` | `(app) => void \| Promise<void>` | Extra Fastify setup called after all plugins |
| `hooks` | `BootstrapHooks` | Fastify lifecycle hooks |
| `health` | `false \| BootstrapHealthOptions` | Health route options, or `false` to disable |

### Framework plugins (enabled by default)

| Option | Type | Description |
| :--- | :--- | :--- |
| `logger` | `boolean \| LoggerPluginOptions` | Fastify logger or `@oneunit/logger` plugin |
| `errorHandler` | `boolean \| ErrorHandlerPluginOptions` | Global error handler |
| `responseManagement` | `boolean` | Response management layer |
| `msgpack` | `boolean \| MsgpackPluginOptions` | MessagePack serialization support |
| `zod` | `boolean` | Zod type provider for Fastify |
| `cors` | `boolean \| CorsPluginOptions` | CORS headers (`origin: true, credentials: true` by default) |
| `helmet` | `boolean \| HelmetPluginOptions` | Security headers via `@fastify/helmet` |
| `cookie` | `boolean \| CookiePluginOptions` | Cookie parsing via `@fastify/cookie` |
| `compress` | `boolean \| CompressPluginOptions` | Response compression via `@fastify/compress` |
| `rateLimit` | `boolean \| RateLimitPluginOptions` | Rate limiting (`1000 req/min` by default) |
| `requestContext` | `boolean \| RequestContextPluginOptions` | Per-request context via `@fastify/request-context` |

### Infrastructure plugins (disabled by default)

| Option | Type | Description |
| :--- | :--- | :--- |
| `database` | `boolean \| DatabasePluginOptions` | PostgreSQL via `@oneunit/database` |
| `redis` | `boolean \| RedisPluginOptions` | Redis via `@oneunit/redis` |
| `kafka` | `boolean \| KafkaPluginOptions` | Kafka producer/consumer via `@oneunit/kafka` |
| `realtime` | `boolean \| RealtimePluginOptions` | WebSocket/realtime via `@oneunit/realtime` |

### Optional plugins (disabled by default)

| Option | Type | Description |
| :--- | :--- | :--- |
| `multipart` | `boolean \| MultipartPluginOptions` | File upload via `@fastify/multipart` |
| `csrf` | `boolean \| CsrfPluginOptions` | CSRF protection via `@fastify/csrf-protection` |
| `underPressure` | `boolean \| UnderPressurePluginOptions` | Back-pressure monitoring via `@fastify/under-pressure` |
| `swagger` | `boolean \| SwaggerPluginOptions` | OpenAPI schema generation via `@fastify/swagger` |
| `swaggerUI` | `boolean \| SwaggerUIPluginOptions` | Swagger UI via `@fastify/swagger-ui` |

## API

### `startServer(portOrOptions?, options?)`

Alias for `startBootstrapServer`. Creates the Fastify instance, registers all plugins, listens, and returns:

```typescript
interface StartedBootstrapServer {
  app: FastifyInstance;
  address: string;
  port: number;
  host: string;
  close(): Promise<void>;
}
```

### `createServer(portOrOptions?, options?)`

Alias for `createBootstrapServer`. Same as `startServer` but does **not** call `app.listen()`. Returns the `FastifyInstance` directly. Useful for testing.

### `startBootstrapServer` / `createBootstrapServer`

The canonical named exports. Accept `(port, options)` or `(options)` overloads.

## Health endpoint

`GET /health` is registered by default and reports:

```json
{
  "status": "healthy",
  "service": "api",
  "checks": {
    "system": { "status": "healthy", "memory": { ... }, "cpu": { ... } },
    "database": { "status": "healthy" }
  }
}
```

Disable with `health: false`.

## Plugin ordering

Builtin plugins register in this deterministic order:

```
1. Framework primitives  – zod, logger, errorHandler, responseManagement, msgpack
2. Request infrastructure – requestContext
3. Security              – helmet, cookie, csrf
4. HTTP middleware        – cors, compress, rateLimit, multipart
5. Performance           – underPressure
6. Infrastructure        – database, redis, kafka, realtime
7. Health providers      – system health
8. Documentation         – swagger, swaggerUI
```

Application plugins and `configure()` run after all builtins.

## Examples

See [`examples/ts/`](./examples/ts/) for runnable TypeScript examples:

- [`basic.ts`](./examples/ts/basic.ts) — minimal server
- [`plugins.ts`](./examples/ts/plugins.ts) — builtin plugin configuration
- [`hooks.ts`](./examples/ts/hooks.ts) — lifecycle hooks
- [`custom.ts`](./examples/ts/custom.ts) — custom plugins and `configure()`
- [`auth.ts`](./examples/ts/auth.ts) — authentication plugin pattern

## License

MIT. Copyright (c) 2026 mayank.
