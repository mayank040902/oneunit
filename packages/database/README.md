<p align="center">
  <strong>@oneunit/database</strong>
  <br/>
  A batteries-included PostgreSQL client for Node.js
</p>

<p align="center">
  <a href="https://www.npmjs.com/@oneunit/database"><img src="https://img.shields.io/npm/v/@oneunit/database?color=0969da&label=npm" alt="npm version"></a>
  <a href="https://github.com/mayank040902/oneunit/blob/main/packages/database/LICENSE"><img src="https://img.shields.io/npm/l/@oneunit/database?color=22863a" alt="license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-417e38" alt="node version">
  <img src="https://img.shields.io/badge/types-included-3178c6" alt="types included">
</p>

<p align="center">
  Connection pooling · Parameterized queries · Transactions &amp; savepoints · Streaming &amp; cursors<br/>
  Query builder · Models · Schema helpers · Migrations · Health checks · Metrics
</p>

---

Built on [`pg`](https://node-postgres.com), with optional [`pg-cursor`](https://github.com/brianc/node-pg-cursor) and [`pg-query-stream`](https://github.com/brianc/node-pg-query-stream) for streaming workloads. Ships as a standalone ESM package — no sibling-package runtime dependencies.

> **Monorepo** — [github.com/mayank040902/oneunit](https://github.com/mayank040902/oneunit)

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Queries](#queries)
  - [Prepared Statements](#prepared-statements)
  - [Manual Checkout](#manual-checkout)
  - [Timeouts & Retries](#timeouts--retries)
- [Transactions](#transactions)
- [SQL Fragments & Query Builder](#sql-fragments--query-builder)
- [Models](#models)
- [Batch Inserts](#batch-inserts)
- [Streaming & Cursors](#streaming--cursors)
- [Schema Helpers](#schema-helpers)
- [Migrations](#migrations)
- [Health Checks & Shutdown](#health-checks--shutdown)
- [Sharding](#sharding)
- [Replication](#replication)
- [Error Handling](#error-handling)
- [Logging & Metrics](#logging--metrics)
- [TypeScript](#typescript)
- [Sub-path Exports](#sub-path-exports)
- [Examples](#examples)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)

---

## Installation

```bash
npm install @oneunit/database
```

For streaming support, add the optional peer dependencies:

```bash
npm install pg-cursor pg-query-stream
```

---

## Quick Start

```javascript
import { createDatabase } from "@oneunit/database";

const db = createDatabase();

// Simple query
const { rows } = await db.query(
    "SELECT * FROM users WHERE status = $1",
    ["active"],
);

// Transaction with savepoints
await db.transaction(async (client) => {
    await client.query(
        "INSERT INTO users (email) VALUES ($1)",
        ["ada@example.com"],
    );
});

// Graceful shutdown
await db.shutdown();
```

Connection settings are read from the environment by default, or pass them explicitly:

```javascript
const db = createDatabase({
    connectionString: "postgresql://user:pass@localhost:5432/app",
    max: 10,
    application_name: "billing-api",
});
```

---

## Configuration

All environment access is centralized in `loadDatabaseConfig()`. Explicit options always take precedence over environment values.

| Variable | Alias | Default | Description |
| :--- | :--- | :--- | :--- |
| `DATABASE_URL` | | — | PostgreSQL connection string |
| `DATABASE_HOST` | `PGHOST` | — | Hostname |
| `DATABASE_PORT` | `PGPORT` | — | Port |
| `DATABASE_NAME` | `PGDATABASE` | — | Database name |
| `DATABASE_USER` | `PGUSER` | — | User |
| `DATABASE_PASSWORD` | `PGPASSWORD` | — | Password |
| `DATABASE_POOL_MAX` | `DB_MAX_CONN`, `DB_POOL_SIZE` | `20` | Maximum pool size |
| `DATABASE_POOL_MIN` | `DB_MIN_CONN` | `0` | Minimum pool size |
| `DATABASE_CONNECTION_TIMEOUT` | `DB_CONN_TIMEOUT` | `5000` | Connect timeout (ms) |
| `DATABASE_IDLE_TIMEOUT` | `DB_IDLE_TIMEOUT` | `30000` | Idle client timeout (ms) |
| `DATABASE_QUERY_TIMEOUT` | `DB_QUERY_TIMEOUT` | — | Default query timeout (ms) |
| `DATABASE_STATEMENT_TIMEOUT` | `DB_STATEMENT_TIMEOUT` | — | PostgreSQL `statement_timeout` (ms) |
| `DATABASE_SSL` | `DB_SSL` | `false` | Enable TLS |
| `DATABASE_SSL_CA` | `DB_SSL_CA` | — | Path to CA certificate |
| `DATABASE_APP_NAME` | `DB_APP_NAME` | `Unknown App` | `application_name` sent to Postgres |

> **Tip** — Copy [`.env.example`](.env.example) and fill in values for local development.

```javascript
import { loadDatabaseConfig, createDatabase } from "@oneunit/database";

const config = loadDatabaseConfig({ max: 8 });
const db = createDatabase(config);
```

Credentials are **never** written to logs.

---

## Idle Transaction Timeout

PostgreSQL can terminate sessions that remain idle inside an open transaction. Enable this via the `idleTransactionTimeout` option on `createDatabase()` or `loadDatabaseConfig()`:

```javascript
import { createDatabase } from "@oneunit/database";

const db = createDatabase({
    connectionString: "postgresql://user:pass@localhost:5432/app",
    idleTransactionTimeout: {
        enabled: true,
        timeout: 60_000, // milliseconds
    },
});
```

To disable:

```javascript
const db = createDatabase({
    idleTransactionTimeout: {
        enabled: false,
    },
});
```

| Property | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | Yes | Whether `idle_in_transaction_session_timeout` is applied to new connections |
| `timeout` | `number` | Yes when `enabled: true` | Idle-in-transaction timeout in milliseconds (1 to 2,147,483,647) |

**Behavior:**

- The timeout is applied as a PostgreSQL startup parameter (`-c idle_in_transaction_session_timeout=<ms>`) on every newly created physical connection
- It only terminates sessions that are idle inside an open transaction — it is **not** a general query execution timeout
- When PostgreSQL terminates the session, uncommitted changes are rolled back
- Configuration changes only take effect for new physical connections; existing sessions are unaffected
- This feature does **not** provide transaction resumption or automatic retries

**Important:** Disabling this package feature does not override or remove server-level, database-level, role-level, or session-level timeouts configured independently in PostgreSQL.

**Invalid values** (negative, zero when enabled, `NaN`, `Infinity`, or exceeding 2,147,483,647 ms) throw a `TypeError` or `RangeError` at configuration time.

---

## Queries

Every query is parameterized — use `$1, $2, ...` placeholders. Clients are acquired and released automatically.

```javascript
const result = await db.query(
    "SELECT id, email FROM users WHERE id = $1",
    [userId],
);

// Returns the first row, or null
const user = await db.queryOne(
    "SELECT * FROM users WHERE email = $1",
    ["ada@example.com"],
);
```

### Prepared Statements

```javascript
const findUser = db.prepare(
    "find_user",
    "SELECT * FROM users WHERE id = $1",
);

const { rows } = await findUser.execute([userId]);
```

### Manual Checkout

```javascript
const client = await db.getClient();
try {
    await client.query("SELECT 1");
} finally {
    db.releaseClient(client);
}
```

### Timeouts & Retries

Retries are **off by default**. Enable them only for idempotent statements. Only transient PostgreSQL errors (serialization failures, deadlocks, connection loss) are retried.

```javascript
await db.query("SELECT pg_advisory_lock($1)", [42], {
    timeout: 2_000,
    retry: { retries: 3, baseDelay: 50 },
});
```

---

## Transactions

Transactions always `BEGIN` / `COMMIT` / `ROLLBACK` and always release the client.

```javascript
const created = await db.transaction(async (client) => {
    const { rows } = await client.query(
        "INSERT INTO users (email) VALUES ($1) RETURNING *",
        ["ada@example.com"],
    );

    // Nested savepoint
    await db.savepoint(client, "profile", async (tx) => {
        await tx.query(
            "INSERT INTO profiles (user_id) VALUES ($1)",
            [rows[0].id],
        );
    });

    return rows[0];
});
```

**Options:**

```javascript
await db.transaction(work, {
    isolation: "SERIALIZABLE",
    readOnly: false,
    timeout: 5_000,
    retry: { retries: 2 },
});
```

Supported isolation levels: `READ UNCOMMITTED` · `READ COMMITTED` · `REPEATABLE READ` · `SERIALIZABLE`

---

## SQL Fragments & Query Builder

### Tagged Template

```javascript
import { createDatabase, sql } from "@oneunit/database";

const db = createDatabase();
const statuses = ["active", "pending"];

const fragment = sql`
    SELECT * FROM users
    WHERE status IN (${sql.join(statuses)})
    AND created_at > ${since}
`;

await db.query(fragment.text, fragment.values);
```

### Fluent Query Builder

```javascript
const { rows } = await db.from("users")
    .select(["id", "email"])
    .where({ status: "active" })
    .orderBy("created_at", "desc")
    .limit(20);
```

> Identifiers are quoted. Values are never interpolated into SQL text.

---

## Models

Lightweight CRUD helpers for common table operations:

```javascript
const users = db.model("users");

await users.insert({ email: "ada@example.com" });
await users.findOne({ email: "ada@example.com" });
await users.updateById(id, { status: "active" });
await users.deleteById(id);
await users.count({ status: "active" });
```

Pass `{ client }` to run inside an existing transaction.

---

## Batch Inserts

```javascript
await db.batch.insertMany("events", rows, {
    chunkSize: 500,
    onConflict: { columns: ["id"], do: "nothing" },
    returning: ["id"],
});
```

Rows are parameterized and chunked so the statement stays under PostgreSQL's 65 535 parameter limit.

---

## Streaming & Cursors

Use streams or cursors for large result sets instead of loading everything into memory.

```javascript
// Node.js readable stream
const stream = await db.stream(
    "SELECT * FROM audit_logs WHERE created_at < $1",
    [cutoff],
);
stream.on("data", (row) => processRow(row));
stream.on("error", console.error);

// Async iterator (cursor-based)
const cursor = await db.cursor("SELECT * FROM analytics_events");
for await (const row of cursor) {
    processRow(row);
}
```

> The pooled client is released automatically on `end`, `error`, `close`, or iterator completion.

Requires optional peer dependencies: `pg-query-stream` (streams), `pg-cursor` (cursors).

---

## Schema Helpers

```javascript
import { createDatabase, id, timestamp } from "@oneunit/database";

const db = createDatabase();

await db.schema.create.table("users", {
    ...id(),
    email: "VARCHAR(255) NOT NULL",
    status: "VARCHAR(50) DEFAULT 'active'",
    ...timestamp("created_at", "updated_at"),
});

await db.schema.create.index("idx_users_email", "users", ["email"]);
await db.schema.constrain.unique("users", "uq_users_email", ["email"]);
await db.schema.alter.addColumns("users", { bio: "TEXT" });
await db.schema.drop.table("users", { cascade: true });
```

---

## Migrations

```javascript
await db.migrate.run({
    migrations: [
        {
            id: "001_users",
            up: "CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid())",
            down: "DROP TABLE users",
        },
    ],
});

await db.migrate.status({ directory: "./migrations" });
await db.migrate.rollback({ directory: "./migrations", steps: 1 });
```

SQL files and ESM/CJS modules in a directory are loaded in filename order. Each migration runs inside its own transaction under an advisory lock.

---

## Health Checks & Shutdown

```javascript
// Detailed health info for readiness probes
const health = await db.check();
// { status: "up", latency: { value: 2, unit: "ms" }, pool: { total, idle, waiting } }

// Simple boolean health check
const ready = await db.health();
if (!ready.healthy) {
    throw new Error(ready.error);
}

// Graceful shutdown (idempotent, safe to call concurrently)
process.on("SIGTERM", async () => {
    await db.shutdown();
    process.exit(0);
});
```

---

## Sharding

Sharding routes queries to different PostgreSQL databases (shards) based on a shard key. Each shard is an independent database with its own connection pool.

### Configuration

```javascript
import { createDatabase } from "@oneunit/database";

const db = createDatabase({
    sharding: {
        enabled: true,
        strategy: "hash", // or "consistent-hash", "rendezvous", "range", "directory", "tenant", "composite", "geographic", "weighted"
        shards: [
            {
                id: "shard-0",
                connection: {
                    connectionString: "postgresql://localhost:5432/shard0",
                },
            },
            {
                id: "shard-1",
                connection: {
                    connectionString: "postgresql://localhost:5432/shard1",
                },
            },
        ],
        defaultShardId: "shard-0",
    },
});
```

To disable sharding (preserves existing single-database behavior):

```javascript
const db = createDatabase({
    sharding: {
        enabled: false,
        strategy: "hash",
        shards: [],
    },
});
```

| Property | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | Yes | Whether sharding is active |
| `strategy` | `ShardStrategyName` | No | Routing strategy (default: `"hash"`) |
| `shards` | `ShardConfig[]` | Yes when enabled | List of shard configurations |
| `shards[].id` | `string` | Yes | Unique stable shard identifier |
| `shards[].connection` | `PoolConfig` | Yes | pg connection config for the shard |
| `defaultShardId` | `string` | No | Fallback shard for directory/tenant default policy |

### Routing Strategies

Nine strategies are available. Choose based on your data access pattern:

| Strategy | Name | Best For | Key Characteristic |
| :--- | :--- | :--- | :--- |
| Hash | `hash` | General purpose | Deterministic modulo; remaps most keys when shard count changes |
| Consistent Hash | `consistent-hash` | Cache-like workloads | Ring with virtual nodes; minimal remapping on membership change |
| Rendezvous | `rendezvous` | General purpose | Highest random weight; deterministic ranking per key |
| Range | `range` | Ordered keys (IDs, dates) | Explicit numeric/string ranges; no silent fallback |
| Directory | `directory` | Known key→shard mapping | Exact lookup; configurable unknown-key policy |
| Tenant | `tenant` | Multi-tenant SaaS | Tenant ID → shard mapping; optional default shard |
| Composite | `composite` | Multi-component keys | {tenantId, userId} → collision-resistant serialization |
| Geographic | `geographic` | Data residency | Region → eligible shards; deterministic selection |
| Weighted | `weighted` | Uneven capacity | Weighted random-walk; higher weight = more keys |

#### Hash Routing

Uses FNV-1a 32-bit hash of the shard key, modulo shard count. Identical keys always resolve to the same shard.

**Limitations:** Adding or removing shards remaps most keys. This is not consistent hashing — plan for data migration when changing shard membership.

```javascript
const db = createDatabase({
    sharding: {
        enabled: true,
        strategy: "hash",
        shards: [...],
    },
});
```

#### Consistent Hash Routing

Uses a hash ring with configurable virtual nodes. Adding or removing a shard remaps only a fraction of keys (approximately `1 / (N+1)` where N is the new shard count).

```javascript
const db = createDatabase({
    sharding: {
        enabled: true,
        strategy: "consistent-hash",
        shards: [...],
        virtualNodes: 100, // default: 100
    },
});
```

#### Rendezvous Hash Routing

Ranks eligible shards deterministically for each key using a hash of `key:shardId`. The highest-ranked shard is selected. Supports an optional `hashSeed` to vary routing.

```javascript
const db = createDatabase({
    sharding: {
        enabled: true,
        strategy: "rendezvous",
        shards: [...],
        hashSeed: "my-app-seed",
    },
});
```

#### Range Routing

Routes ordered numeric keys to explicitly configured shard ranges. Boundaries can be inclusive or exclusive. Keys outside all ranges throw `ShardNotFoundError` — no silent fallback.

```javascript
const db = createDatabase({
    sharding: {
        enabled: true,
        strategy: "range",
        shards: [...],
        ranges: [
            { shardId: "shard-0", start: 0, end: 99 },
            { shardId: "shard-1", start: 100, end: 199, startInclusive: true, endInclusive: false },
        ],
    },
});
```

#### Directory Routing

Uses an explicit key-to-shard mapping. Unknown keys throw `ShardNotFoundError` unless `unknownKeyPolicy: "default"` is set with a `defaultShardId`.

```javascript
const db = createDatabase({
    sharding: {
        enabled: true,
        strategy: "directory",
        shards: [...],
        directory: {
            "user-1": "shard-0",
            "user-2": "shard-1",
        },
        unknownKeyPolicy: "throw", // or "default"
    },
});
```

Legacy `routing.directory` format is also supported for backward compatibility.

#### Tenant Routing

Routes using an explicit tenant identifier. Large tenants can be assigned to dedicated shards. Unknown tenants throw `ShardNotFoundError` unless `defaultTenantShardId` is configured.

```javascript
const db = createDatabase({
    sharding: {
        enabled: true,
        strategy: "tenant",
        shards: [...],
        tenants: {
            "tenant-acme": "shard-0",
            "tenant-globex": "shard-1",
            "tenant-mega": "shard-2", // dedicated shard for large tenant
        },
        defaultTenantShardId: "shard-0",
    },
});
```

#### Composite-Key Routing

Routes based on multiple key components (e.g., `tenantId` and `userId`). Uses length-prefixed serialization to prevent collisions from naive concatenation.

```javascript
const db = createDatabase({
    sharding: {
        enabled: true,
        strategy: "composite",
        shards: [...],
        hashStrategy: "hash", // or "consistent-hash", "rendezvous", "weighted"
    },
});

// Route using composite key
const shard = db.sharding.getShardForKey("ignored", {
    compositeKey: { tenantId: "acme", userId: "42" },
});
```

#### Geographic Routing

Routes using a configured region. Maps regions to eligible shards and deterministically selects from them. Unknown regions throw `ShardNotFoundError` unless a `defaultRegion` is configured with `unknownRegionPolicy: "default"`.

```javascript
const db = createDatabase({
    sharding: {
        enabled: true,
        strategy: "geographic",
        shards: [...],
        regions: {
            "us-east": ["shard-0", "shard-1"],
            "eu-west": ["shard-2", "shard-3"],
        },
        defaultRegion: "us-east",
        unknownRegionPolicy: "default",
    },
});
```

#### Weighted Routing

Supports shards with different configured capacities. Uses weighted highest-random-weight: `score = hash^(1/weight)`. Higher weight shards receive more keys on average.

```javascript
const db = createDatabase({
    sharding: {
        enabled: true,
        strategy: "weighted",
        shards: [
            { id: "shard-0", connection: {...}, weight: 1 },
            { id: "shard-1", connection: {...}, weight: 3 }, // 3x capacity
        ],
    },
});
```

**Weights are static** — they do not measure load or balance query latency automatically.

### Query Execution

Route queries to the correct shard using `db.query()` with a `shardKey` option:

```javascript
const result = await db.query(
    "SELECT * FROM users WHERE id = $1",
    [userId],
    { shardKey: userId },
);
```

When sharding is disabled, `shardKey` is ignored and the query runs against the
single pool. When sharding is enabled and `shardKey` is provided, the query is
routed to the correct shard based on the configured strategy.

When sharding is enabled but no `shardKey` is provided, the query runs against
the primary pool (the default shard or first shard). Callers that need explicit
shard routing must supply `shardKey`.

Parameterized SQL is preserved — values are never interpolated into SQL text.

```javascript
// With sharding enabled
const result = await db.query(
    "INSERT INTO orders (user_id, total) VALUES ($1, $2)",
    [userId, 99.99],
    { shardKey: userId },
);

// Without sharding (shardKey is ignored)
const result = await db.query("SELECT 1");
```

### Transactions

Transactions stay on their original shard for their entire lifetime. Pass
`shardKey` in the transaction options:

```javascript
await db.transaction(
    async (client) => {
        await client.query("INSERT INTO orders (user_id) VALUES ($1)", [userId]);
        // All operations happen on the same shard
    },
    { shardKey: userId },
);
```

When sharding is disabled, `shardKey` is ignored and the transaction runs
against the single pool.

Cross-shard transactions are **not supported** — PostgreSQL transactions cannot
atomically commit across independent database servers.

### Deprecated: db.sharding.query() / db.sharding.transaction()

The `db.sharding.query(shardKey, ...)` and `db.sharding.transaction(shardKey, ...)`
methods remain available as deprecated compatibility wrappers. New code should
use `db.query(..., { shardKey })` and `db.transaction(..., { shardKey })` instead.

```javascript
// Deprecated — use db.query() with shardKey instead
const result = await db.sharding.query(
    userId,
    "SELECT * FROM users WHERE id = $1",
    [userId],
);
```

### Direct Shard Access

For advanced use cases, you can inspect shards or get a direct shard handle:

```javascript
db.sharding.enabled;           // true | false
db.sharding.strategy;          // "hash" | "consistent-hash" | ... | undefined
db.sharding.shards;            // [{ id, connected, pool }, ...]
db.sharding.getShard("shard-0"); // { id, connected, pool } | undefined
db.sharding.getShardForKey("user-42"); // { id, connected, pool }

import { getRegisteredStrategyNames } from "@oneunit/database";
getRegisteredStrategyNames(); // ["hash", "consistent-hash", ...]
```

Direct shard pool access (`shard.pool`) bypasses the router. Use it only when
you need to execute raw pool operations outside the normal query/transaction
flow. Bypassing the router invalidates routing guarantees — ensure all related
operations stay on the same shard manually.

### Health & Observability

Each shard's pool can be health-checked independently. Health checks run
`SELECT 1` against the shard's pool and report latency, pool statistics, and
any error. Results never throw — down shards are reported in the result rather
than as exceptions.

```javascript
// Health of all shards — aggregate result
const health = await db.sharding.health();
console.log(health.healthy);           // true | false
console.log(health.downShards);        // ["shard-1"] — shards that are down
console.log(health.upShards);          // ["shard-0", "shard-2"]
console.log(health.checkedAt);         // ISO timestamp

for (const shard of health.shards) {
    console.log(shard.shardId, shard.status, shard.latency.value, "ms");
    console.log(shard.pool);           // { total, idle, waiting }
    if (shard.error) {
        console.log(shard.error, shard.code);
    }
}

// Health of a single shard
const shardHealth = await db.sharding.shardHealth("shard-0");
console.log(shardHealth?.status);      // "up" | "down" | undefined
console.log(shardHealth?.latency.value);

// Shard info includes failure tracking
const shard = db.sharding.getShard("shard-0");
console.log(shard?.consecutiveFailures); // 0 = healthy, >0 = recent failures
console.log(shard?.lastError);           // last error message, if any
console.log(shard?.lastCheckedAt);       // ISO timestamp of last check
```

**Health result fields:**

| Field | Type | Description |
| :--- | :--- | :--- |
| `healthy` | `boolean` | `true` when all shards are up |
| `checkedAt` | `string` | ISO timestamp of the health check |
| `shards` | `ShardHealthCheckResult[]` | Per-shard results |
| `upShards` | `string[]` | IDs of healthy shards |
| `downShards` | `string[]` | IDs of unhealthy shards |

**Per-shard health check result:**

| Field | Type | Description |
| :--- | :--- | :--- |
| `shardId` | `string` | Shard identifier |
| `status` | `"up" \| "down"` | Health status |
| `latency` | `{ value, unit }` | Query latency in ms |
| `pool` | `{ total, idle, waiting }` | Connection pool statistics |
| `error` | `string \| undefined` | Error message, if down |
| `code` | `string \| undefined` | PostgreSQL error code, if down |
| `checkedAt` | `string` | ISO timestamp of the check |

**Shard info includes failure tracking:**

| Field | Type | Description |
| :--- | :--- | :--- |
| `consecutiveFailures` | `number` | Number of consecutive health check failures (0 = healthy) |
| `lastError` | `string \| undefined` | Last error message, if any |
| `lastCheckedAt` | `string \| undefined` | ISO timestamp of the last health check |

Failures are tracked automatically — when a health check fails, `consecutiveFailures`
increments and `lastError` is recorded. When a check succeeds, `consecutiveFailures`
resets to 0 and `lastError` is cleared.

### Errors

| Error | Code | When |
| :--- | :--- | :--- |
| `ShardingDisabledError` | `SHARDING_DISABLED` | Sharding APIs called when disabled |
| `ShardNotFoundError` | `SHARD_NOT_FOUND` | Shard ID or key mapping not found |
| `ShardConfigError` | `SHARD_CONFIG_ERROR` | Invalid sharding configuration |
| `ShardRoutingError` | (none) | Query/transaction cannot be routed to a shard |
| `CrossShardTransactionError` | `CROSS_SHARD_TRANSACTION` | Cross-shard transaction attempted |
### Data Placement Responsibilities

Sharding is a data-placement strategy. Consumers are responsible for:

- Choosing a stable shard key (e.g., `user_id`, `tenant_id`)
- Colocating related records on the same shard
- Applying schema migrations to all shards
- Handling cross-shard uniqueness and foreign keys
- Understanding that PostgreSQL transactions and foreign keys do not span shards

Adding a shard does **not** automatically redistribute existing data. Routing changes and physical data migration are separate concerns.

### Custom Strategies

The strategy interface is extensible. Implement `ShardStrategy` and register it:

```typescript
import { ShardStrategy, ShardRoutingContext } from "@oneunit/database";

class MyStrategy implements ShardStrategy {
    readonly name = "custom" as const;
    readonly version = 1;
    validate(config, shardIds) { /* ... */ }
    resolveShard(key, context) { /* ... */ }
}
```

Note: Custom strategies are used directly — there is no global registry for user-defined strategies. Pass your strategy instance to the router or handle routing in your application layer.

### CA Certificate (TLS) Support

Shards can use TLS with certificate verification by specifying `ssl.ca` in the shard's connection config:

```javascript
const db = createDatabase({
    sharding: {
        enabled: true,
        strategy: "hash",
        shards: [
            {
                id: "shard-0",
                connection: {
                    connectionString: "postgresql://user@db0.example.com:5432/db0",
                    ssl: {
                        ca: "-----BEGIN CERTIFICATE-----...-----END CERTIFICATE-----",
                        rejectUnauthorized: true,
                    },
                },
            },
        ],
    },
});
```

The CA certificate contents are **never** logged — only the presence of SSL is recorded in diagnostic output.

### Resharding (Adding/Removing Shards)

Shards can be added or removed at runtime. Each change bumps the `routingVersion`, and optional hooks run before/after the change:

```javascript
const db = createDatabase({
    sharding: {
        enabled: true,
        strategy: "hash",
        shards: [{ id: "shard-0", connection: { connectionString: "..." } }],
    },
});

// Add a new shard
await db.sharding.addShard({
    id: "shard-1",
    connection: { connectionString: "postgresql://user@db1:5432/db1" },
});

// Remove a shard
await db.sharding.removeShard("shard-0");

// Check the current routing version
console.log(db.sharding.routingVersion); // increments on each change
```

Resharding hooks allow you to coordinate data migration:

```javascript
await db.sharding.addShard(
    { id: "shard-2", connection: { connectionString: "..." } },
    {
        onBeforeReshard: (oldVersion, newVersion, added, removed) => {
            // Pause writes, start data migration
        },
        onAfterReshard: (oldVersion, newVersion, added, removed) => {
            // Resume writes, verify migration complete
        },
    },
);
```

**Important:** Changing shard membership changes routing but does **not** automatically move existing data. You must coordinate data migration separately.

### Migration Coordination

Run schema migrations across all shards and track their status:

```javascript
// Run a migration on all shards
const result = await db.sharding.migrate.runMigrationOnAllShards(
    "001_add_users_table",
    "CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)",
);

console.log(result.allApplied);    // true if all shards succeeded
console.log(result.anyFailed);     // true if any shard failed
console.log(result.shards);        // { "shard-0": "applied", "shard-1": "applied" }

// Check migration status
const status = db.sharding.migrate.getMigrationStatus("001_add_users_table");
console.log(status.shards);        // Per-shard status

// Get all migrations for a shard
const records = db.sharding.migrate.getShardMigrationStatus("shard-0");

// Get overall migration statistics
const stats = db.sharding.migrate.getMigrationStats();
console.log(stats.fullyApplied);   // Migrations applied to all shards
console.log(stats.failedMigrations); // Migrations that failed on any shard
```

Migration results are tracked in-memory. For production, consider persisting migration state to a dedicated table on each shard.

### Online Resharding (Data Migration)

`@oneunit/database` includes a durable, crash-recoverable online resharding
subsystem that redistributes existing records when shard membership or routing
configuration changes. Adding or removing a shard changes routing but does **not**
automatically move data — you must explicitly plan and execute a migration.

The resharding lifecycle is:

`planned → copying → catching_up → validating → ready_for_cutover → cutting_over → completed → finalized`

with operator-visible states `paused`, `failed`, `cancelled`, `rollback_required`.

Key guarantees:

- **Durable state**: migration lifecycle, per-unit checkpoints, change-log offsets,
  and published routing versions are persisted on a coordination database
  (versioned schema, idempotent init). Cross-shard transactions are not atomic;
  the coordination authority is the single source of truth.
- **Bounded, resumable copy**: keyset-paginated batches (never offset pagination),
  configurable batch size/concurrency/throttle/retries. Checkpoints advance only
  after the destination write commits, so crashes are safe to resume.
- **Idempotent destination writes**: adapters use upsert (ON CONFLICT) semantics;
  repeated delivery does not duplicate logical records.
- **Change capture**: a transactional outlog (`resharding_changes`) records source
  mutations atomically with the source mutation, with stable sequence ordering so
  stale updates cannot win during `catching_up`.
- **Coordinated cutover**: verifies the copy is complete, drains the change log to
  a consistency boundary, fences writes for moved keys, then publishes the new
  routing version atomically. Writes are briefly paused during the drain/fence
  window.
- **Crash recovery**: `plan()`, `start()`, `getStatus()`, `pause()`, `resume()`,
  `cancel()`, `validate()`, `cutover()`, `finalize()` are all durable and idempotent.
  A restart during cutover inspects durable state to roll forward or require
  operator intervention — never guesses from process-local memory.

Usage:

```javascript
const db = createDatabase({
    sharding: {
        enabled: true,
        strategy: "hash",
        shards: [
            { id: "src", connection: { connectionString: "..." } },
            { id: "dst", connection: { connectionString: "..." } },
        ],
    },
});

const rsharding = db.resharding;
await rsharding.init();
await rsharding.initShard("src", srcPool);
await rsharding.initShard("dst", dstPool);

const plan = await rsharding.plan(descriptor, targetTopology);
await rsharding.start();
await rsharding.copyUnits(descriptor);          // bounded, resumable batches
const { passed } = await rsharding.validate();  // never cut over after failure
await rsharding.cutover();                      // coordinated, recoverable
await rsharding.finalize();
```

The application supplies a `MigrationDescriptor` describing each table's primary
key, shard key, batch reader, idempotent upsert, delete propagation, and
optional validation — the package does not guess schemas from SQL.

Supported planning strategies: `hash`, `consistent-hash`, `rendezvous`, `range`,
`directory`, `tenant`, `composite`, `geographic`, `weighted`. Strategies whose
configuration does not expose enough information to compute a safe migration are
rejected with a typed `UnsupportedStrategyError` rather than producing an
incorrect plan.

#### Supported strategies and explicit limitations

| Strategy | Supported planning | Notes / limitations |
|----------|-------------------|---------------------|
| `hash` | Yes | Whole-shard units; membership change remaps most keys; row counts unknown until copy discovers them. |
| `consistent-hash` | Yes | Bucket (virtual-node range) units; only keys near ring boundaries remap in principle, but the package cannot enumerate keys — units are bucket-level and the adapter discovers real keys. |
| `rendezvous` | Yes | Whole-shard units for added/removed shards; key-level winners are discovered at copy time via the adapter. |
| `range` | Yes | Exact range-boundary deltas; boundaries and ordering preserved. |
| `directory` | Yes | Exact per-key deltas from the directory map; directory metadata migrated consistently. |
| `tenant` | Yes | Whole-tenant units only; tenant data is never split or relocated without respecting configured tenant ownership. |
| `composite` | Yes | Whole-shard units; exact composite-key mapping delegated to the application adapter (`destinationShardForRow`). |
| `geographic` | Yes | Per-region units; respects eligible shard lists per region. |
| `weighted` | Yes | Whole-shard units for membership/weight changes. |

Limitations:

- **No cross-shard distributed transactions.** A migration touches multiple shards but each shard's work is committed independently; partial failure across shards is reconciled through the coordination authority, not an atomic transaction.
- **No zero-downtime claim.** Writes are briefly paused during the cutover drain/fence window.
- **Writes bypassing package-managed APIs** (e.g. raw `psql`, other applications writing directly to PostgreSQL) are NOT captured by the transactional outlog and are excluded from the consistency guarantee unless covered by database-level CDC.
- **The package does not infer schemas or shard keys.** Every participating table must be described through a `MigrationTableAdapter`.
- **Consistent hashing does not automatically move data.** A changed ring is accompanied by bucket-level units; the application must ensure the adapter maps keys to the correct destination.

See `examples/resharding.js` for a runnable end-to-end example.

#### Failure recovery and operator procedures

All migration state is durable. After a process crash or restart:

1. Reconstruct the `ReshardingManager` against the same coordination database and call `getStatus()` to recover the last known state.
2. `planned` / `copying` / `catching_up`: resume with `resume()` (reclaims the worker lock) or `start()`; checkpoints and change-log offsets preserve progress.
3. `paused`: resume with `resume()` to continue at the last safe boundary.
4. `failed` / `rollback_required`: inspect the sanitized `errorCode`/`errorMessage` in the status, then either `cancel()` or retry by re-planning (`planned`) after resolving the cause.
5. `cutting_over`: inspect `cutoverCommitted` in the coordination routing-versions table. If the new routing version is `is_current = TRUE`, cutover committed — continue to `finalize()`. If not, cutover did not commit — the migration is in `rollback_required`; resolve the cause and retry cutover or cancel.
6. `cancelled` / `finalized` / `completed`: terminal states; no source data is deleted by cancellation.

Never interpret `failed`, `cancelled`, or `rollback_required` as `completed`. Never remove a shard while data remains assigned to it unless a completed, finalized migration permits it.

---

## Replication

Replication routes queries between one PostgreSQL primary and zero or more read replicas that the operator has already provisioned (e.g. via physical streaming replication). This package configures **client connections** to those replicas — it does not create, promote, or fail over replicas.

### Configuration

```javascript
import { createDatabase } from "@oneunit/database";

const db = createDatabase({
    connectionString: "postgresql://localhost:5432/app",
    replication: {
        enabled: true,
        mode: "replica-preferred", // "primary" | "replica-preferred" | "replica-only"
        primary: {
            id: "primary",
            connection: {
                connectionString: "postgresql://localhost:5432/app",
            },
        },
        replicas: [
            {
                id: "replica-0",
                connection: {
                    connectionString: "postgresql://localhost:5433/app",
                    max: 5,
                },
            },
        ],
        // Exclude a replica from read routing when its known lag exceeds this.
        lagThresholdMs: 1000,
        healthCheck: {
            enabled: true,
            intervalMs: 30_000,
            timeoutMs: 5_000,
        },
    },
});
```

| Property | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | Yes | Whether replication is active |
| `mode` | `"primary" \| "replica-preferred" \| "replica-only"` | Yes | Read preference / routing mode |
| `primary` | `ReplicationEndpointConfig` | No | Primary endpoint (defaults to the main connection with id `"primary"`) |
| `primary[].id` | `string` | Yes | Unique stable endpoint identifier |
| `primary[].connection` | `PoolConfig` | Yes | pg connection config for the primary (also its pool settings) |
| `replicas` | `ReplicationEndpointConfig[]` | Yes | List of read replica endpoint configurations |
| `replicas[].id` | `string` | Yes | Unique stable endpoint identifier (must not collide with `primary.id`) |
| `replicas[].connection` | `PoolConfig` | Yes | pg connection config for the replica (also its pool settings) |
| `lagThresholdMs` | `number` | No | Exclude replicas whose known lag (ms) exceeds this |
| `healthCheck` | `object` | No | `{ enabled, intervalMs, timeoutMs, lagQuery? }` |

When sharding is enabled, use `ShardConfig.replication` instead (each shard's `connection` is its primary). Configurations with no `replication` setting preserve existing single-pool behavior.

### Routing intent

Routing is driven entirely by an explicit `readPreference` on `db.query()` — **never** by parsing SQL:

```javascript
// Write (or any operation needing the primary): always the primary
await db.query("INSERT INTO users (email) VALUES ($1)", ["ada@example.com"]);

// Strong read-after-write: force the primary
await db.query("SELECT * FROM users WHERE id = $1", [id], {
    readPreference: "primary",
});

// Read that may be slightly stale: prefer a replica, fall back to primary
await db.query("SELECT * FROM analytics WHERE ...", [], {
    readPreference: "replica-preferred",
});

// Read that must come from a replica; error if none is eligible
await db.query("SELECT * FROM analytics WHERE ...", [], {
    readPreference: "replica-only",
});
```

Default `readPreference` is `"primary"`, so existing code reads from the primary and there are no accidental stale reads or writes to replicas.

### Consistency & lag

- All writes go to the primary. Transactions remain pinned to one primary connection for their entire lifetime.
- Read replicas may lag the primary. `lagThresholdMs` excludes replicas whose measured lag exceeds the threshold.
- Unknown lag (not yet measured) is distinct from zero lag and is reported as `lagUnknown: true` in health results.
- A successful health check does **not** imply a replica is consistent — health only confirms connectivity.
- This package does not implement distributed consensus, automatic primary promotion, or any zero-data-loss guarantee.

### Health & observability

```javascript
const health = await db.replication.health();
// { healthy, primary: {...}, replicas: [{ endpointId, role, status, latencyMs, lagMs, lagUnknown, consecutiveFailures, error }], ... }
```

Per-endpoint health reports role, status, latency, known replication lag, consecutive failures, and sanitized error details. A failed replica may be excluded from read routing; a failed primary never redirects writes to a replica or another shard.

### Public API

`db.replication` exposes `enabled`, `mode`, `primaryEndpointId`, `replicaEndpointIds`, `health()`, `endpointHealth(id)`, `primaryPool`, `readEndpoint(preference)`, and `shutdown()`. When replication is disabled, `enabled` is `false` and all operations target the primary.

---

## Error Handling

Driver errors are wrapped as `DatabaseError` with the original preserved on `.cause`.

```javascript
import {
    DatabaseError,
    TimeoutError,
    isUniqueViolation,
    isTransientError,
} from "@oneunit/database";

try {
    await db.query("INSERT INTO users (email) VALUES ($1)", [email]);
} catch (error) {
    if (isUniqueViolation(error)) {
        return { conflict: true };
    }
    throw error;
}
```

**Available error helpers:**

| Helper | Catches |
| :--- | :--- |
| `isUniqueViolation` | Duplicate key (`23505`) |
| `isForeignKeyViolation` | FK constraint (`23503`) |
| `isNotNullViolation` | NOT NULL constraint (`23502`) |
| `isCheckViolation` | CHECK constraint (`23514`) |
| `isConstraintViolation` | Any constraint violation |
| `isSerializationFailure` | Serializable isolation conflict |
| `isDeadlock` | Deadlock detected |
| `isConnectionError` | Connection lost / refused |
| `isTransientError` | Any of the above retriable errors |

---

## Logging & Metrics

Pass any logger with `info` / `warn` / `error` / `debug` methods. Parameter values are **not** logged unless `logParameters: true`.

```javascript
const db = createDatabase({
    logger: console,
    instrumentation: {
        logQueries: true,
        slowQueryMs: 200,
        onQuery({ durationMs, rowCount }) {
            metrics.timing("db.query", durationMs, { rowCount });
        },
    },
});

// Snapshot current metrics
db.metrics.snapshot();
```

---

## TypeScript

The package ships with full TypeScript declarations. ESM-only (`"type": "module"`).

```ts
import { createDatabase } from "@oneunit/database";

interface User {
    id: string;
    email: string;
}

const db = createDatabase();
const user = await db.queryOne<User>(
    "SELECT id, email FROM users WHERE id = $1",
    [id],
);
```

---

## Sub-path Exports

For tree-shaking or targeted imports, the package exposes granular entry points:

```javascript
import { createClient }       from "@oneunit/database/client";
import { createModelFactory } from "@oneunit/database/model";
import { createQueryBuilder }  from "@oneunit/database/query";
import { createSchemaManager } from "@oneunit/database/schema";
import { id, timestamp }       from "@oneunit/database/column";
import { encode, decode }      from "@oneunit/database/json-serialization";
```

---

## Examples

Runnable examples live in the [`examples/`](examples) directory:

| File | Description |
| :--- | :--- |
| [`basic.js`](examples/basic.js) | Connect, query, shut down |
| [`transactions.js`](examples/transactions.js) | Transaction + savepoint |
| [`streaming.js`](examples/streaming.js) | Cursor iteration |
| [`models.js`](examples/models.js) | Model CRUD |
| [`migrations.js`](examples/migrations.js) | In-memory migrations |

```bash
DATABASE_URL=postgresql://localhost:5432/app node examples/basic.js
```

---

## Testing

```bash
npm test
```

Tests use [vitest](https://vitest.dev/). All tests mock `pg.Pool` and `PoolClient` — no live PostgreSQL instance required.

Tests are organized under `test/` to mirror `src/`:

| Directory | Covers |
| :--- | :--- |
| `test/client/` | client, transactions, retry, batch, check, health, shutdown, stream, cursor |
| `test/query/` | SQL fragments & QueryBuilder |
| `test/schema/` | DDL helpers, migration runner |
| `test/model/` | Model CRUD abstraction |
| `test/json-serialization/` | encode/decode utilities |
| `test/errors/` | error normalization & classifiers |
| `test/config/` | env-based config loading |
| `test/database.test.js` | `createDatabase()` composition surface |
| `test/edge-cases.test.js` | edge, extreme, behaviour & real-world scenarios |
| `test/sharding/` | sharding config, routing, pool lifecycle |

```bash
npm test                    # run all tests
npm run test:watch          # watch mode
npx vitest run test/client  # run one directory
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and the PR workflow.

---

## License

[MIT](LICENSE) © 2026 mayank
