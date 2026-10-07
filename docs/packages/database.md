# @oneunit/database

Standalone PostgreSQL client: pooling, parameterized queries, transactions, streaming, schema helpers, models, and migrations.

No sibling-package runtime dependencies.

Package README: `packages/database/README.md`

## Install

```bash
npm install @oneunit/database
```

## Quick start

```javascript
import { createDatabase } from "@oneunit/database";

const db = createDatabase();

const { rows } = await db.query(
  "SELECT * FROM users WHERE status = $1",
  ["active"],
);

await db.transaction(async (client) => {
  await client.query("INSERT INTO users (email) VALUES ($1)", ["ada@example.com"]);
});

await db.shutdown();
```

## Surface

| Area | API |
| :--- | :--- |
| Queries | `query`, `queryOne`, `prepare`, `getClient` |
| Transactions | `transaction`, `savepoint` |
| Models | `db.model(table)` — `find`, `findOne`, `findById`, `insert`, `update`, `delete` |
| Query builder | `db.from(table)` / `db.table(table)` |
| Schema | `db.schema.create.table`, `db.schema.drop.table` |
| Migrations | `db.migrate` |
| Lifecycle | `health` / `check`, `shutdown` |

Credentials are never written to logs. Prefer `$1` placeholders. Env vars are listed in `docs/environment.md`.
