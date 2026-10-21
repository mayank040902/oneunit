# Database (PostgreSQL via `@oneunit/database`)

## Overview & Purpose

The **Database Plugin** integrates PostgreSQL database connectivity into `@oneunit/server` via the optional peer package `@oneunit/database`.

Key capabilities:
- **Fastify Decorators**: Automatically decorates the server instance with `server.db` and `server.database`, exposing connection pooling, query execution, and transaction helpers.
- **Automated Health Probes**: Registers a database health check (`SELECT 1`) with `server.healthRegistry`. If the database becomes unreachable, the health probe reports it, optionally marking `GET /health` as HTTP 503 if `healthCheckCritical: true`.
- **Query Performance Instrumentation**: Configurable logging for slow queries, parameter redaction, query timing metrics, and query hooks (`onQuery`, `onError`, `onRetry`).
- **Clean Lifecycle Teardown**: Hooks into Fastify's `onClose` server lifecycle to drain connection pool sockets cleanly on shutdown, avoiding dangling database connections.

---

## Installation & Import Requirements

```typescript
import {
  databasePlugin,
  type DatabasePluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { databasePlugin } from "@oneunit/server/plugins";
```

Optional peer dependencies:
```bash
npm install @oneunit/database pg
```

---

## Configuration Options

When configuring `database` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `connectionString` | `string` | — | Full PostgreSQL connection URI (e.g. `postgresql://user:pass@localhost:5432/app`). |
| `host` | `string` | `"localhost"` | Database host server. |
| `port` | `number` | `5432` | Database port. |
| `database` | `string` | — | Database name. |
| `user` | `string` | — | Database username. |
| `password` | `string` | — | Database password. |
| `max` | `number` | `10` | Maximum number of clients in the connection pool. |
| `idleTimeoutMillis`| `number` | `30000` | Milliseconds a client must sit idle before being closed and freed. |
| `connectionTimeoutMillis` | `number` | `0` | Milliseconds to wait before timing out when connecting a new client. |
| `ssl` | `boolean \| object` | `false` | SSL configuration (or CA cert options) for managed cloud databases (RDS, Neon, Supabase). |
| `application_name` | `string` | — | Application identifier reported in PostgreSQL `pg_stat_activity`. |
| `logQueries` | `boolean` | `false` | When true, logs executed SQL text. Recommended only in development. |
| `logParameters` | `boolean` | `false` | When true, logs query parameters alongside SQL. Protect against logging sensitive PII! |
| `slowQueryMs` | `number` | `0` | Threshold in ms to trigger slow-query warning logs. |
| `queryTimeout` | `number` | `0` | Max milliseconds a query may run before being aborted. |
| `healthCheckCritical` | `boolean` | `false` | When true, a failed database health check causes `GET /health` to respond with HTTP 503. |
| `retry` | `boolean \| number \| object` | — | Automated connection and query retry policy. |
| `onQuery` | `(info) => void` | — | Hook called on every executed query with SQL, parameters, durationMs, and rowCount. |
| `onError` | `(info) => void` | — | Hook called on query execution errors with SQL and durationMs. |
| `onRetry` | `(info) => void` | — | Hook called when a query is retried. |

To disable database:
```typescript
const app = await createServer({ database: false });
```

---

## Usage Examples

### 1. Production Server Startup with Database Pool

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "order-service",
  database: {
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    slowQueryMs: 200, // Warn if queries take longer than 200ms
    healthCheckCritical: true, // Database is vital: 503 if unreachable
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  },
  configure: (server) => {
    server.get("/orders", async (request, reply) => {
      // Execute queries via server.db or server.database
      const result = await server.db.query(
        "SELECT id, total_amount, created_at FROM orders WHERE customer_id = $1 LIMIT 50",
        [request.query.customerId]
      );

      return reply.ok({ data: result.rows });
    });
  },
});
```

### 2. Transaction Management Pattern

```typescript
server.post("/orders", async (request, reply) => {
  const client = await (server.db as any).connect();

  try {
    await client.query("BEGIN");
    const orderRes = await client.query(
      "INSERT INTO orders (customer_id, total) VALUES ($1, $2) RETURNING id",
      [request.body.customerId, request.body.total]
    );
    const orderId = orderRes.rows[0].id;

    await client.query(
      "INSERT INTO order_items (order_id, item_id) VALUES ($1, $2)",
      [orderId, request.body.itemId]
    );

    await client.query("COMMIT");
    return reply.created({ data: { orderId } });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});
```

---

## Common Use Cases & Best Practices

1. **Enable `healthCheckCritical: true` in Primary APIs**: For services where the database is a non-negotiable dependency, setting `healthCheckCritical: true` ensures Kubernetes won't route traffic to pods that cannot talk to Postgres.
2. **Never Log Parameters in Production**: Keep `logParameters: false` in production to prevent user passwords, credit card numbers, or PII from being written to centralized log aggregators.
3. **Tune Connection Pool to Available DB CPU**: Don't set `max: 100` across 10 autoscaled replica pods, as 1,000 connections will overwhelm PostgreSQL. 10-20 connections per pod is typically sufficient.

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@oneunit/database` is missing from `node_modules`, `@oneunit/server` logs a warning and proceeds without database decoration.
- **Automated Pool Teardown**: Connection pool resources are automatically freed when `server.close()` is invoked via Fastify's `onClose` hook.

---

## Related Features

- [Health Checks](health-checks.md)
- [Graceful Shutdown](graceful-shutdown.md)
- [Configuration and Environment](configuration-and-environment.md)
