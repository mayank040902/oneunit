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

Tests use Node's built-in test runner and do **not** require a live PostgreSQL instance.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and the PR workflow.

---

## License

[MIT](LICENSE) © 2026 mayank
