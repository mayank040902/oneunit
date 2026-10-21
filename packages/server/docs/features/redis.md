# Redis

## Overview & Purpose

The **Redis Plugin** integrates Redis connectivity into `@oneunit/server` via the optional peer package `@oneunit/redis`.

Key capabilities:
- **Fastify Decorator**: Decorates the server instance with `server.redis`, making the Redis client accessible across all plugins, hooks, and route handlers.
- **Automated Health Probes**: Registers a Redis health check with `server.healthRegistry` and optionally exposes a standalone readiness route at `/health/redis`.
- **Integrated Distributed Rate Limiting**: Can be directly paired with the `rateLimit` plugin for synchronized rate-limiting across distributed server nodes.
- **Graceful Connection Shutdown**: Closes and drains active Redis connections when the server closes, preventing unclosed sockets from holding the process open.

---

## Installation & Import Requirements

```typescript
import {
  redisPlugin,
  type RedisPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { redisPlugin } from "@oneunit/server/plugins";
```

Optional peer dependencies:
```bash
npm install @oneunit/redis ioredis
```

---

## Configuration Options

When configuring `redis` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `redis` | `boolean \| RedisPluginOptions` | `false` | Disabled by default. Set to `true` or pass configuration object to enable. |
| `url` | `string` | — | Redis connection URL (e.g. `redis://:secret@localhost:6379/0`). |
| `host` | `string` | `"localhost"` | Redis server hostname. |
| `port` | `number` | `6379` | Redis server port. |
| `password` | `string` | — | Redis authentication password. |
| `db` | `number` | `0` | Redis logical database index. |
| `lazyConnect` | `boolean` | `false` | When true, delays network connection until the first command is executed. |
| `maxRetriesPerRequest` | `number` | — | Maximum command retries before throwing an error. |
| `retryStrategy` | `(times: number) => number \| null` | — | Custom exponential backoff reconnection strategy. |
| `healthCheck` | `boolean` | `false` | When true, exposes a dedicated diagnostic endpoint at `healthCheckPath`. |
| `healthCheckPath` | `string` | `"/health/redis"` | Path for the standalone Redis health endpoint. |

---

## Usage Examples

### 1. Connecting Redis for Caching and Session Storage

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "catalog-api",
  redis: {
    url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
    healthCheck: true, // Mounts GET /health/redis
    maxRetriesPerRequest: 3,
  },
  configure: (server) => {
    server.get("/products/:id", async (request, reply) => {
      const cacheKey = `product:${request.params.id}`;
      const redis = (server as any).redis;

      // 1. Try reading from cache
      const cached = await redis.get(cacheKey);
      if (cached) {
        return reply.ok({ data: JSON.parse(cached), metadata: { source: "cache" } });
      }

      // 2. Fall back to database
      const product = await fetchProductFromDB(request.params.id);
      if (!product) return reply.notFound();

      // 3. Cache with 5-minute TTL
      await redis.set(cacheKey, JSON.stringify(product), "EX", 300);

      return reply.ok({ data: product, metadata: { source: "database" } });
    });
  },
});
```

### 2. Standalone Redis Health Endpoint

When `healthCheck: true` is configured, querying `GET /health/redis` returns latency and connectivity status:

```json
{
  "status": "up",
  "latency": {
    "value": 1.45,
    "unit": "ms"
  }
}
```

---

## Common Use Cases & Best Practices

1. **Use `lazyConnect: true` in Test Suites**: Prevents unit tests from hanging or failing immediately if a local Redis instance is not running on the developer's machine.
2. **Key Namespacing**: Always prefix Redis keys with the service name or domain (e.g. `auth:session:123`, `cache:product:456`) to avoid key collisions on shared Redis clusters.
3. **Always Set TTLs on Caches**: Never run unbounded `SET` commands without an expiration (`EX` in seconds or `PX` in milliseconds) to prevent Redis memory from filling up over time.

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@oneunit/redis` is not installed, `@oneunit/server` logs a warning and proceeds without Redis decoration.
- **Automatic Lifecycle Hook**: Active Redis connections are cleanly disconnected in Fastify's `onClose` hook when `app.close()` is called.

---

## Related Features

- [Rate Limiting](rate-limiting.md)
- [Health Checks](health-checks.md)
- [Database](database.md)
