# Combining packages

This is the integration map for using every `@bootstrap-framework/*` package in one service.

Runnable reference: `examples/combined`.

## What "combined" means

One Node.js process that:

| Concern | Package |
| :--- | :--- |
| HTTP server | `@bootstrap-framework/server` |
| Structured logs | `@oneunit/logger` |
| Typed HTTP errors | `@bootstrap-framework/errors` |
| JWT + RBAC + passwords | `@oneunit/auth` |
| PostgreSQL | `@oneunit/database` |
| Cache, sessions, jobs | `@oneunit/redis` |
| Domain events | `@oneunit/kafka` |
| WebSocket fan-out | `@bootstrap-framework/realtime` |

Workers can reuse the same packages without Fastify: `createDatabase`, `createClient`, `createWorker`, `createKafkaClient`.

## Install set

```bash
npm install \
  @bootstrap-framework/server \
  @oneunit/logger \
  @bootstrap-framework/errors \
  @oneunit/auth \
  @oneunit/database \
  @oneunit/redis \
  @oneunit/kafka \
  @bootstrap-framework/realtime \
  @fastify/cors \
  @fastify/helmet \
  @fastify/cookie \
  @fastify/compress \
  @fastify/rate-limit \
  @fastify/websocket \
  fastify-plugin \
  dotenv
```

## Wiring order

1. Create `auth` with `createAuth({ secret, rbac, userStore })`
2. Call `startServer` / `createServer` with plugin flags
3. Register `fastifyAdapter(auth)` in `extraPlugins` or `configure`
4. In `configure`, add routes that use `server.db`, `server.redis`, `server.kafka`, `server.realtime`
5. Optionally start a BullMQ worker and a Kafka consumer in the same process or a sibling process
6. Close everything through Fastify `onClose` (plugins already hook this)

```javascript
import { startServer } from "@bootstrap-framework/server";
import { createAuth, fastifyAdapter } from "@oneunit/auth";
import { NotFoundError } from "@bootstrap-framework/errors";

const auth = createAuth({
  secret: process.env.AUTH_SECRET,
  issuer: "combined-api",
  rbac: {
    defaultRole: "member",
    roles: {
      member: { permissions: ["profile.read"] },
      admin: { inherits: "member", permissions: ["user.manage"] },
    },
  },
});

const { app, address } = await startServer({
  serviceName: "combined-api",
  logger: { useHttpLogger: true, mode: "production" },
  database: true,
  redis: { url: process.env.REDIS_URL, healthCheck: true },
  kafka: { brokers: process.env.KAFKA_BROKERS, autoConnectProducer: true },
  realtime: { websocketLibrary: "fastify" },
  extraPlugins: [fastifyAdapter(auth)],
  configure: async (server) => {
    server.get("/me", { preHandler: [server.authenticate()] }, async (request) => {
      const user = await server.db.queryOne(
        "SELECT id, email, roles FROM users WHERE id = $1",
        [request.user.userId],
      );
      if (!user) {
        throw new NotFoundError("User", request.user.userId);
      }
      return user;
    });
  },
  gracefulShutdown: true,
});
```

## Shared logger

Pass the Fastify logger (already a Pino logger when the logger plugin is on) into Kafka and Redis:

- Kafka plugin uses `createKafkaClient(server.log, options)`
- Redis plugin uses `createClient(options, server.log)`
- Database plugin uses `createDatabase({ logger: server.log, ... })`

Standalone workers:

```javascript
import { createLogger } from "@oneunit/logger";
import { createKafkaClient, createLoggerAdapter } from "@oneunit/kafka";

const logger = createLogger({ mode: "production", childBindings: { service: "worker" } });
const kafka = createKafkaClient(createLoggerAdapter(logger), { brokers: process.env.KAFKA_BROKERS });
```

## Auth + database

Implement `userStore` with Postgres:

- `findByCredentials(identifier)` — lookup by email
- `create(input)` — insert hashed password (auth hashes before `create` when using `register`)
- `updatePassword(id, passwordHash)`
- Optional OAuth: `findByProvider`, `findByEmail`, `createFromProvider`, `linkProvider`

## Auth + redis

Use Redis as `refreshStore`:

- Key: `refresh:${id}`
- Value: JSON `RefreshRecord`
- TTL: refresh token lifetime

```javascript
import { createAuth } from "@oneunit/auth";
import { createClient } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });

const auth = createAuth({
  secret: process.env.AUTH_SECRET,
  userStore,
  refreshStore: {
    save: (record) =>
      redis.set(`refresh:${record.id}`, JSON.stringify(record), "EX", ttlSeconds),
    get: async (id) => {
      const raw = await redis.get(`refresh:${id}`);
      return raw ? JSON.parse(raw) : null;
    },
    // GETDEL reads and deletes in one round-trip. Without an atomic
    // operation, two concurrent refreshes with the same token both succeed.
    consume: (id) => redis.getdel(`refresh:${id}`).then((raw) => (raw ? JSON.parse(raw) : null)),
    revoke: (id) => redis.del(`refresh:${id}`),
  },
});
```

`consume` and `revoke` are what make rotation and logout work. If a store
implements neither, `auth.refresh()` and `auth.logout()` throw
`ConfigurationError` rather than report a logout that never happened.

Use Redis as a session cache keyed by `session:${userId}` after login.

## Broker + realtime

`@bootstrap-framework/realtime` owns no broker client, so the adapter belongs to
the application. It consumes from the broker and calls `broadcast` on the hub;
replacing Kafka with Redis or NATS changes this block and nothing in the realtime
package. `examples/combined/src/index.ts` is a working version.

```javascript
import type { BroadcastTarget } from "@bootstrap-framework/realtime";

const hub: BroadcastTarget = server.realtime;
const consumer = await server.kafka.getConsumer("api-realtime");

await consumer.subscribe({ topic: "user-events", fromBeginning: false });
await consumer.run({
  // `broadcast` is async because authorization may be.
  eachMessage: async ({ message }) => {
    await hub.broadcast("events", JSON.parse(message.value.toString()));
  },
});

server.addHook("onClose", async () => {
  await consumer.disconnect();
});
```

HTTP handlers can also `server.kafka.send("user-events", event)` and `await server.realtime.broadcast("events", event)` in the same request.

## Redis + kafka workers

Split processes if load requires it:

- **API process:** server + auth + db + redis cache + kafka producer + websocket
- **Worker process:** redis `createWorker` for emails
- **Consumer process:** kafka `consume` for projections

All three share the same packages and env vars.

## Errors across packages

Throw `@bootstrap-framework/errors` from route handlers. Auth adapters already send auth errors. Kafka/Redis/database failures should be wrapped:

```javascript
import { DatabaseError, tryCatchAsync } from "@bootstrap-framework/errors";

const { data, error } = await tryCatchAsync(
  server.db.queryOne("SELECT 1"),
  (err) => new DatabaseError("health query failed", undefined, err),
);
```

## Disable unused pieces

Every server plugin accepts `false`:

```javascript
await createServer({
  logger: true,
  database: false,
  kafka: false,
  redis: false,
  realtime: false,
});
```

The combined example turns plugins on only when the matching env var is set, so you can run HTTP+auth without Postgres.
