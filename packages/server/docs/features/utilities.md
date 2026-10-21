# Shared Library Utilities

## Overview & Purpose

The **Shared Utilities** (`@oneunit/server/lib`) module provides foundational tools for formatting, system diagnostic collection, metadata enrichment, cookie option presets, and bounded server shutdown.

These utilities are used internally by `@oneunit/server` plugins and are also directly exported for use in custom routes, application plugins, and background workers.

---

## Installation & Import Requirements

```typescript
import {
  getSystemInfo,
  getSystemStatus,
  formatBytes,
  formatTime,
  timestamp,
  collectMetadata,
  closeWithDeadline,
  installBoundedClose,
  DEFAULT_THRESHOLDS,
  DEFAULT_CLOSE_TIMEOUT_MS,
  authCookieOptions,
  accessCookieOptions,
  refreshCookieOptions,
  type SystemStatus,
  type SystemThresholds,
  type SystemMetrics,
  type HealthChecks,
  type SystemInfo,
  type BoundedCloseOptions,
} from "@oneunit/server";

// Alternatively from subpath:
import {
  getSystemInfo,
  getSystemStatus,
  formatBytes,
  formatTime,
  timestamp,
  collectMetadata,
  closeWithDeadline,
  installBoundedClose,
  authCookieOptions,
} from "@oneunit/server/lib";
```

---

## Utility Functions & APIs

### 1. Formatting Utilities (`formatter.ts`)

#### `formatBytes(bytes: number, decimals = 2): string`
Converts raw byte counts into human-readable binary SI units (`Bytes`, `KB`, `MB`, `GB`, `TB`, `PB`, etc.).
```typescript
formatBytes(0);          // "0 Bytes"
formatBytes(1024);       // "1 KB"
formatBytes(1536);       // "1.5 KB"
formatBytes(1048576);    // "1 MB"
formatBytes(1073741824); // "1 GB"
```

#### `formatTime(ms: number): string`
Converts millisecond durations into clean units (`ms`, `s`, `m`, `h`, `d`, `y`).
```typescript
formatTime(25);      // "25ms"
formatTime(1500);    // "1.5s"
formatTime(90000);   // "1.5m"
formatTime(7200000); // "2h"
formatTime(86400000);// "1d"
```

#### `timestamp(date?: Date): string`
Generates an ISO 8601 UTC timestamp string. Defaults to `new Date()`.
```typescript
timestamp(); // e.g. "2026-10-21T13:45:00.000Z"
```

---

### 2. System Hardware Diagnostics (`getSystemInfo()`)

Extracts comprehensive runtime diagnostics from the Node.js `process` and `os` modules:
- Process uptime, PID, memory usage (heapUsed, heapTotal, rss, external)
- CPU count, model, speed, load average (1m, 5m, 15m)
- Host platform, architecture, release, total memory, free memory
- Network interfaces and host identity details

```typescript
import { getSystemInfo } from "@oneunit/server/lib";

const info = getSystemInfo();
console.log(`Node ${info.process.nodeVersion} on ${info.os.platform}`);
console.log(`Heap: ${formatBytes(info.process.memory.heapUsed)} / ${formatBytes(info.process.memory.heapTotal)}`);
```

> [!CAUTION]
> `getSystemInfo()` contains internal details (network MAC addresses, hostnames, user data). It should only be exposed on authorized internal admin endpoints, never on public unauthenticated routes.

---

### 3. System Status & Resource Thresholds (`getSystemStatus()`)

Calculates overall system health (`healthy`, `degraded`, or `unhealthy`) based on memory percentage, normalized CPU load, and external dependency checks:

```typescript
import { getSystemStatus, DEFAULT_THRESHOLDS } from "@oneunit/server/lib";

const status = getSystemStatus(
  {
    memory: { usagePercent: 82 }, // 82% memory used
    cpu: {
      cores: 4,
      loadAverage: { oneMinute: 3.2 }, // 3.2 / 4 cores = 0.8 normalized load
    },
  },
  {
    database: { status: true },
    redis: { status: true },
  },
  DEFAULT_THRESHOLDS // degraded: 75% mem / 0.7 load; unhealthy: 90% mem / 1.0 load
);

console.log(status); // "degraded" (since memory is >= 75%)
```

---

### 4. Metadata Enrichment (`collectMetadata()`)

Generates structured telemetry and audit metadata from an incoming Fastify request and reply:
- Identity context (`user_id`, `user_type`, `client_id`, `session_id`, `device_id`)
- Trace correlation (`traceId`, `requestId`)
- HTTP details (`method`, `url`, `statusCode`, `ip`, `userAgent`)

```typescript
import { collectMetadata } from "@oneunit/server/lib";

server.addHook("onResponse", async (request, reply) => {
  const metadata = collectMetadata(request as any, reply);
  // Send audit log to security monitoring pipeline
  await auditLogger.log(metadata);
});
```

---

### 5. Secure Cookie Option Presets (`cookies.ts`)

Pre-configured security presets for HTTP cookies:

| Preset | MaxAge | HTTPOnly | Secure | SameSite |
| :--- | :--- | :--- | :--- | :--- |
| `authCookieOptions` | 7 days | `true` | `isProduction()` | `"lax"` |
| `accessCookieOptions` | 15 mins | `true` | `isProduction()` | `"lax"` |
| `refreshCookieOptions` | 30 days | `true` | `isProduction()` | `"lax"` |

```typescript
import { refreshCookieOptions } from "@oneunit/server/lib";

reply.setCookie("refreshToken", token, refreshCookieOptions);
```

---

## Common Use Cases & Best Practices

1. **Use `formatBytes` and `formatTime` in Telemetry**: Human-readable metrics make command-line logs and debugging dashboards significantly easier to read.
2. **Combine `getSystemStatus` with Orchestrator Readiness**: If system status is `"unhealthy"`, route probes can signal orchestrators to pause routing traffic to that instance until load subsides.
3. **Use Pre-configured Cookie Presets**: Protect against XSS and CSRF token theft by using `authCookieOptions` or `refreshCookieOptions`.

---

## Related Features

- [Health Checks](health-checks.md)
- [System Health](system-health.md)
- [Cookies](cookies.md)
- [Graceful Shutdown](graceful-shutdown.md)
