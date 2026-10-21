# Rate Limiting

## Overview & Purpose

The **Rate Limit Plugin** integrates `@fastify/rate-limit` into `@oneunit/server` to defend services against brute-force attacks, credential stuffing, scraping, and accidental DDoS loops.

Key capabilities:
- **Per-Route Key Generation by Default**: Automatically scopes limit quotas by `${ip}:${route}`, preventing heavy traffic on one route from exhausting limits on other endpoints.
- **Immediate Blacklist Blocking**: Rejects blacklisted IPs with HTTP `429 Too Many Requests` in the `onRequest` phase before route handlers or database lookups run.
- **Allowlist & Whitelist Support**: Maps `whitelist` and `allowList` to bypass rate limits for trusted IPs, internal microservices, and monitoring nodes.
- **Distributed Redis Support**: Pluggable Redis store for enforcing synchronized rate limits across autoscaled, multi-instance server clusters.
- **Default Baseline**: Enabled by default with a generous baseline of `1000 requests per minute`.

---

## Architecture & How It Works

```
Incoming Request
  │
  ▼
[onRequest Hook]
  │
  ├─ Is request.ip in blacklist?
  │    ├─ YES ──► Immediate HTTP 429 "Rate limit exceeded"
  │    │
  │    └─ NO
  │
  ▼
[@fastify/rate-limit]
  │
  ├─ Is request.ip in allowList/whitelist?
  │    ├─ YES ──► Bypass limits, proceed to handler
  │    │
  │    └─ NO
  │
  ▼
Key Generation: `${ip}:${route}` (or custom keyGenerator)
  │
  ▼
Evaluate against memory or Redis store
  │
  ├─ Under limit: Increment count, set headers, proceed
  │    - X-RateLimit-Limit
  │    - X-RateLimit-Remaining
  │    - X-RateLimit-Reset
  │
  └─ Over limit: Returns HTTP 429 with Retry-After header
```

---

## Installation & Import Requirements

```typescript
import {
  rateLimitPlugin,
  type RateLimitPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { rateLimitPlugin } from "@oneunit/server/plugins";
```

Optional peer dependencies:
```bash
npm install @fastify/rate-limit
# Optional for distributed multi-instance clusters:
npm install @oneunit/redis ioredis
```

---

## Configuration Options

When configuring `rateLimit` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `rateLimit` | `boolean \| RateLimitPluginOptions` | `true` | Enabled by default (1000 req/min). Set to `false` to disable. |
| `max` | `number` | `1000` | Maximum number of requests allowed during the time window. |
| `timeWindow` | `string \| number` | `"1 minute"` | Window duration in ms or string format (e.g., `"1 minute"`, `60000`, `"15 minutes"`). |
| `allowList` | `string[]` | `[]` | Array of IP addresses exempt from rate limiting. |
| `whitelist` | `string[]` | `[]` | Alias of `allowList` for backwards compatibility. |
| `blacklist` | `string[]` | `[]` | Array of IP addresses immediately rejected with HTTP 429. |
| `redis` | `unknown` | — | Redis client instance for distributed clustering. |
| `keyGenerator` | `(req: FastifyRequest) => string` | `${ip}:${route}` | Custom function to compute the unique quota key. |
| `skipOnError` | `boolean` | `false` | When true, ignores rate limit errors if the storage store fails. |
| `global` | `boolean` | `true` | When true, applies limits to all registered routes by default. |

---

## Usage Examples

### 1. Default Server with Custom Allowlist and Blacklist

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "public-gateway",
  rateLimit: {
    max: 100,
    timeWindow: "1 minute",
    allowList: ["127.0.0.1", "10.0.0.5"], // Internal monitoring IPs
    blacklist: ["198.51.100.2"],          // Abusive scraper IP
  },
});
```

### 2. Distributed Rate Limiting via Redis

In multi-pod Kubernetes clusters, in-memory limits are isolated to each pod. Pass the Redis client to synchronize limits across all pods:

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  redis: {
    url: "redis://127.0.0.1:6379",
  },
  configure: (server) => {
    // server.redis is decorated by the redis plugin
  },
  // Or pass redis configuration directly to rateLimit:
  rateLimit: {
    max: 500,
    timeWindow: 60000,
    redis: myRedisClient,
  },
});
```

### 3. Stricter Rate Limits on Authentication Routes

You can override global rate limits on specific sensitive routes using route-level Fastify config:

```typescript
server.post(
  "/api/auth/login",
  {
    config: {
      rateLimit: {
        max: 5,                  // Max 5 attempts
        timeWindow: "15 minutes",// per 15 minutes per IP
      },
    },
  },
  async (request, reply) => {
    return handleLogin(request, reply);
  }
);
```

---

## Common Use Cases & Best Practices

1. **Protect Authentication Endpoints**: Set strict limits (e.g. 5 attempts / 15 minutes) on `/login`, `/forgot-password`, and `/signup` routes.
2. **Key by User ID for Authenticated APIs**: For authenticated APIs, override `keyGenerator` to track quotas by `request.user.id` rather than IP address, preventing corporate NAT gateways from sharing a single IP quota.
3. **Handle `429` on the Frontend**: When rate limits are exceeded, Fastify sends `Retry-After: <seconds>`. Frontends should parse this header and display a countdown timer.

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@fastify/rate-limit` is not installed, `@oneunit/server` logs a warning and proceeds without rate limiting.
- **Reverse Proxy IP Resolution**: Ensure Fastify's `trustProxy: true` is configured in `fastify` server options if running behind AWS ALB, Cloudflare, or Nginx; otherwise, all clients will share the proxy's IP.

---

## Related Features

- [Redis](redis.md)
- [Error Handling](error-handling.md)
- [Bootstrap](bootstrap.md)
