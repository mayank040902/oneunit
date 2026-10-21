# Health Checks & Central Registry

## Overview & Purpose

The **Health Checks** subsystem provides an enterprise health, liveness, and readiness monitoring architecture for `@oneunit/server`. It aggregates checks from the system runtime (CPU, memory) alongside infrastructure dependencies (PostgreSQL, Redis, Kafka) and user-defined custom services into a single, cohesive health contract.

Key capabilities:
- **Central Health Registry**: Decorates Fastify with `server.healthRegistry`, allowing plugins and application code to register/unregister health providers dynamically.
- **Aggregated Health Status**: Resolves checks in parallel to compute an overall status (`healthy`, `degraded`, or `unhealthy`).
- **Critical Failure Signaling**: If any provider designated as `critical` fails, the HTTP route immediately answers with `503 Service Unavailable`, signaling container orchestrators (Kubernetes, AWS ECS) to stop routing traffic.
- **Details Toggle**: In normal mode, summary outputs prevent information leakage. When `includeDetails: true` is configured, detailed diagnostic objects and an additional `GET /health/details` route are mounted.

---

## Architecture & How It Works

```
                        ┌───────────────────────────────┐
                        │      Fastify Instance         │
                        │    server.healthRegistry      │
                        └──────────────┬────────────────┘
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            ▼                          ▼                          ▼
 ┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
 │ System Health Probe  │   │  Database Provider   │   │ Custom Provider (e.g.│
 │   (CPU, Memory)      │   │     (SELECT 1)       │   │   Payment Gateway)   │
 └──────────┬───────────┘   └──────────┬───────────┘   └──────────┬───────────┘
            │                          │                          │
            └──────────────────────────┼──────────────────────────┘
                                       │ registry.checkAll()
                                       ▼
                       ┌───────────────────────────────┐
                       │ Aggregated Calculation:       │
                       │ Has critical failure? -> 503  │
                       │ Any unhealthy? -> unhealthy   │
                       │ Any degraded? -> degraded     │
                       └───────────────┬───────────────┘
                                       │
                                       ▼
                             HTTP 200 / HTTP 503
                                 GET /health
```

---

## Installation & Import Requirements

```typescript
import {
  createHealthRegistry,
  getHealthRegistry,
  registerHealthRegistry,
  createHealthProvider,
  createDatabaseHealthProvider,
  createRedisHealthProvider,
  createKafkaHealthProvider,
  createHealthRoute,
  createHealthPlugin,
  type HealthStatus,
  type HealthCheckResult,
  type HealthProvider,
  type HealthRegistry,
  type BootstrapHealthOptions,
  type HealthRouteOptions,
} from "@oneunit/server";

// Alternatively from subpaths:
import { createHealthPlugin } from "@oneunit/server/routes";
import { getHealthRegistry, createHealthProvider } from "@oneunit/server";
```

---

## Configuration Options

When configuring `health` in `startServer` or `createServer`:

```typescript
interface BootstrapHealthOptions {
  /** Route path for health endpoint. Defaults to "/health" */
  path?: string;
  /** Service name displayed in output. Defaults to options.serviceName or "app" */
  serviceName?: string;
  /** When true, exposes provider details and mounts GET /health/details. Defaults to false */
  includeDetails?: boolean;
}
```

Disable health checks completely:
```typescript
const app = await createServer({ health: false });
```

---

## Usage Examples

### 1. Default Setup with Detail Inspection

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "orders-service",
  health: {
    path: "/healthz",        // Route mounted at /healthz
    includeDetails: true,    // Also mounts /healthz/details
  },
});
```

Sample Response (`GET /healthz`):
```json
{
  "service": "orders-service",
  "status": "healthy",
  "timestamp": "2026-10-21T14:00:00.000Z",
  "checks": {
    "system": {
      "status": "healthy",
      "details": {
        "memory": { "usagePercent": 42 },
        "cpu": { "cores": 8, "loadAverage": { "oneMinute": 0.45 } }
      }
    }
  }
}
```

### 2. Registering Custom Application Providers

```typescript
import { createServer, createHealthProvider } from "@oneunit/server";

const app = await createServer({
  configure: (server) => {
    // Non-critical check (e.g. background queue)
    server.healthRegistry.register(
      createHealthProvider("backgroundQueue", async () => {
        const queueDepth = await getQueueDepth();
        if (queueDepth > 10000) {
          return { status: "degraded", details: { queueDepth } };
        }
        return { status: "healthy", details: { queueDepth } };
      }, false) // critical = false: will mark overall as degraded, but won't trigger 503
    );

    // Critical check (e.g. primary billing partner API)
    server.healthRegistry.register(
      createHealthProvider("paymentGateway", async () => {
        const isUp = await pingPaymentApi();
        if (!isUp) {
          return { status: "unhealthy", details: { reason: "Connection timeout" } };
        }
        return { status: "healthy" };
      }, true) // critical = true: triggers HTTP 503 when unhealthy
    );
  },
});
```

### 3. Using Builtin Infrastructure Providers Manually

When not using the automatic `database: true` or `redis: true` bootstrap flags:

```typescript
import {
  createServer,
  createDatabaseHealthProvider,
  createRedisHealthProvider,
} from "@oneunit/server";

const app = await createServer({
  configure: (server) => {
    server.healthRegistry.register(
      createDatabaseHealthProvider(async () => {
        await myCustomPool.query("SELECT 1");
      }, true)
    );

    server.healthRegistry.register(
      createRedisHealthProvider(async () => {
        await myCustomRedis.ping();
      }, false)
    );
  },
});
```

---

## Health Status Calculation Rules

| Check Results | Overall Status | HTTP Status Code | Orchestrator Action |
| :--- | :--- | :--- | :--- |
| All checks healthy | `"healthy"` | `200 OK` | Pass traffic |
| One or more checks degraded (no critical unhealthiness) | `"degraded"` | `200 OK` | Pass traffic with warning |
| Non-critical check unhealthy | `"unhealthy"` | `200 OK` | Pass traffic, alert ops |
| **Critical check unhealthy** | `"unhealthy"` | **`503 Service Unavailable`** | **Stop traffic / restart pod** |

---

## Common Use Cases & Best Practices

1. **Kubernetes Liveness vs Readiness**:
   - Use `/health` as the **Readiness Probe**: Critical dependency failures will return 503 and Kubernetes will pull the pod out of the service mesh without killing it.
   - For **Liveness Probes**, verify if the Node.js event loop is responding (the basic system check or a simple `/healthcheck` route).
2. **Handle Timeouts in Providers**: Always ensure external ping checks in `check()` have short, bounded timeouts (e.g. 1-2 seconds) so the `/health` endpoint responds quickly.
3. **Keep Sensitive Details Disabled in Production**: Avoid `includeDetails: true` on public endpoints to keep internal infrastructure metrics private.

---

## Edge Cases & Limitations

- **Provider Exceptions**: If a registered provider's `check()` throws an unexpected error, the registry automatically catches the error and marks that provider's status as `"unhealthy"` with the error message in details.
- **Provider Name Uniqueness**: Providers are keyed by `name`. Calling `register()` with an existing name replaces the previously registered provider.

---

## Related Features

- [System Health](system-health.md)
- [Database](database.md)
- [Redis](redis.md)
- [Kafka](kafka.md)
