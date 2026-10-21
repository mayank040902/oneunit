# Under Pressure (Load Shedding)

## Overview & Purpose

The **Under Pressure Plugin** integrates `@fastify/under-pressure` into `@oneunit/server` to provide active **load shedding** and back-pressure management.

When high-throughput services experience traffic spikes, database slowdowns, or memory leaks, unconstrained request processing can exhaust Node.js event-loop cycles or cause Out-Of-Memory (OOM) crashes.

The `underPressure` plugin continuously samples:
- **Event Loop Delay**: Lag in the Node.js event loop scheduling cycle.
- **Event Loop Utilization (ELU)**: The ratio of event-loop active time vs idle time.
- **V8 Heap Memory**: Current heap used vs allowable threshold.
- **Process RSS Memory**: Total resident memory allocated to the Node.js process.

If any metric exceeds configured thresholds, the plugin automatically sheds load by intercepting requests and responding with HTTP `503 Service Unavailable` with a `Retry-After` header, protecting the process from crashing.

---

## Installation & Import Requirements

```typescript
import {
  underPressurePlugin,
  type UnderPressurePluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { underPressurePlugin } from "@oneunit/server/plugins";
```

Optional peer dependency:
```bash
npm install @fastify/under-pressure
```

---

## Configuration Options

When configuring `underPressure` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `underPressure` | `boolean \| UnderPressurePluginOptions` | `false` | Disabled by default. Set to `true` or pass configuration object to enable. |
| `maxEventLoopDelay` | `number` | — | Maximum acceptable event loop delay in milliseconds (e.g. `1000` for 1s delay). |
| `maxEventLoopUtilization`| `number` | — | Maximum ELU ratio between 0 and 1 (e.g. `0.98` for 98% utilization). |
| `maxHeapUsedBytes` | `number` | — | Maximum V8 heap size in bytes before shedding (e.g. `512 * 1024 * 1024` for 512MB). |
| `maxRssBytes` | `number` | — | Maximum resident set size in bytes before shedding (e.g. `1024 * 1024 * 1024` for 1GB). |
| `message` | `string` | `"Service Unavailable"` | Custom message returned in 503 response body. |
| `retryAfter` | `string \| number` | `10` | Value set in the `Retry-After` response header (seconds). |
| `exposeRoute` | `string` | — | Route path to expose a status monitoring endpoint (e.g. `"/status"`). |
| `healthCheck` | `boolean` | — | When true, includes check status in upstream health endpoints. |

---

## Usage Examples

### 1. Production Load Shedding Setup

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "high-throughput-api",
  underPressure: {
    maxEventLoopDelay: 1000,             // 1000ms event loop lag threshold
    maxEventLoopUtilization: 0.95,       // 95% event loop saturation
    maxHeapUsedBytes: 512 * 1024 * 1024, // 512 MB heap limit
    maxRssBytes: 1024 * 1024 * 1024,     // 1 GB process memory limit
    retryAfter: 5,                       // Tell clients to retry in 5 seconds
    message: "Server is temporarily under heavy load. Please retry shortly.",
  },
  configure: (server) => {
    server.get("/data", async (request, reply) => {
      // Under extreme resource pressure, requests never reach this handler!
      return reply.ok({ data: "heavy computation result" });
    });
  },
});
```

---

## Common Use Cases & Best Practices

1. **Protect Against Cascading Failures**: When downstream databases slow down, pending asynchronous promises pile up in Node.js memory. Under Pressure stops new requests early, allowing pending promises to clear out and memory to recover.
2. **Set Thresholds Below Container Limits**: If your Docker container has a 1GB memory limit, set `maxRssBytes: 850 * 1024 * 1024` (850MB). This ensures the server sheds load and recovers rather than being killed by the Linux kernel OOM Killer.
3. **Use with Kubernetes Ingress Retries**: Configure ingress controllers (e.g. Envoy, NGINX) to automatically retry HTTP 503 responses with another healthy replica pod.

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@fastify/under-pressure` is missing from `node_modules`, `@oneunit/server` logs a warning and proceeds without back-pressure monitoring.
- **Initial Warmup Spikes**: During cold starts or JIT compilation, event loop delay may briefly spike. Avoid setting `maxEventLoopDelay` too low (e.g. under 250ms) to avoid false-positive rejections on startup.

---

## Related Features

- [Health Checks](health-checks.md)
- [System Health](system-health.md)
- [Rate Limiting](rate-limiting.md)
