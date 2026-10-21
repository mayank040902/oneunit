# System Health Provider

## Overview & Purpose

The **System Health Provider** is registered automatically by `@oneunit/server` during server startup (unless `health: false`). It continuously monitors:
- **Memory Pressure**: Heap used vs total, RSS (Resident Set Size), and system total memory percentage.
- **CPU Saturation**: Core count, normalized 1-minute load averages.
- **Process Metrics**: Uptime, PID, and Node.js runtime information.

Crucially, the provider enforces a **security-first diagnostics model**: it strips out host identities, user accounts, system shells, and network topology/MAC addresses, preventing unauthenticated attackers from mapping host infrastructure through health endpoints.

---

## Architecture & How It Works

1. During bootstrap, `registerSystemHealthProvider(server, options)` adds a provider named `"system"` to `server.healthRegistry`.
2. When `/health` is queried, the provider reads runtime OS data using `getSystemInfo()`.
3. It normalizes CPU load:
   $$\text{Normalized Load} = \frac{\text{1-Minute Load Average}}{\text{CPU Cores}}$$
4. Compares memory percentage and normalized load against configured thresholds:
   - **Degraded**: Memory $\ge 75\%$ OR Normalized Load $\ge 0.70$
   - **Unhealthy**: Memory $\ge 90\%$ OR Normalized Load $\ge 1.00$
5. In automated test environments (`NODE_ENV === "test"` or `VITEST === "true"`), thresholds are relaxed to avoid transient test failures during heavy CPU compilations.
6. Details expose only safe metrics: `process`, `performance`, `memory`, and `cpu`. Host identity fields (`user`, `network`, `shell`, `homedir`) are omitted.

---

## Installation & Import Requirements

```typescript
import {
  registerSystemHealthProvider,
  type SystemHealthOptions,
  type SystemThresholds,
} from "@oneunit/server";

// Alternatively from subpaths:
import { registerSystemHealthProvider } from "@oneunit/server/plugins";
import { DEFAULT_THRESHOLDS } from "@oneunit/server/lib";
```

---

## Configuration Options

```typescript
interface SystemHealthOptions {
  /** When true, skips provider registration completely */
  disabled?: boolean;
  /** Custom memory and CPU load thresholds */
  thresholds?: SystemThresholds;
}

interface SystemThresholds {
  memory: {
    degraded: number;  // Default: 75%
    unhealthy: number; // Default: 90%
  };
  load: {
    degraded: number;  // Default: 0.7 (70% load per core)
    unhealthy: number; // Default: 1.0 (100% saturation)
  };
}
```

---

## Usage Examples

### 1. Default Bootstrap Usage with Detailed Checks

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "search-api",
  health: {
    includeDetails: true, // Output contains the system details below
  },
});
```

Sample output excerpt (`GET /health`):
```json
{
  "service": "search-api",
  "status": "healthy",
  "timestamp": "2026-10-21T14:15:00.000Z",
  "checks": {
    "system": {
      "status": "healthy",
      "details": {
        "memory": {
          "totalBytes": 17179869184,
          "freeBytes": 8589934592,
          "usedBytes": 8589934592,
          "usagePercent": 50.0
        },
        "cpu": {
          "cores": 8,
          "loadAverage": {
            "oneMinute": 1.25,
            "fiveMinutes": 1.10,
            "fifteenMinutes": 0.95
          }
        },
        "process": {
          "pid": 12345,
          "uptimeSeconds": 3600,
          "memory": {
            "heapUsed": 45000000,
            "heapTotal": 65000000,
            "rss": 110000000
          }
        }
      }
    }
  }
}
```

### 2. Custom Thresholds for High-Memory Workloads

If you are running in memory-heavy data caching environments:

```typescript
import { createServer, registerSystemHealthProvider } from "@oneunit/server";

const app = await createServer({
  // Override thresholds using custom provider initialization
  configure: (server) => {
    registerSystemHealthProvider(server, {
      thresholds: {
        memory: { degraded: 85, unhealthy: 95 },
        load: { degraded: 0.85, unhealthy: 1.2 },
      },
    });
  },
});
```

---

## Common Use Cases & Best Practices

1. **Autoscaling Triggers**: In Kubernetes (HPA), use normalized CPU load and memory usage reported by the system provider to trigger horizontal pod autoscaling before nodes run out of memory (OOM).
2. **Prevent False Alarms in CI**: `@oneunit/server` detects test environments automatically and relaxes load limits so CI runner spikes don't fail tests.
3. **Combine with Under Pressure**: The system health provider is purely diagnostic; pair it with the `underPressure` plugin to actively shed HTTP traffic when limits are exceeded.

---

## Edge Cases & Limitations

- **Container Shared Kernels**: In certain containerized environments without cgroup v2 limits mounted, Node.js `os.loadavg()` reflects the host machine's total load rather than container slice limits.
- **Burst CPU Usage**: Temporary CPU bursts (e.g. during JIT warmup or JSON parsing) can briefly report `"degraded"`. Status calculations consider the 1-minute smoothed load average to minimize flutter.

---

## Related Features

- [Health Checks](health-checks.md)
- [Under Pressure](under-pressure.md)
- [Shared Utilities](utilities.md)
