/**
 * @oneunit/database — Online Resharding Example
 *
 * Demonstrates planning, copying, validating, cutting over, and finalizing a
 * migration that moves data from one shard to another.
 *
 * Prerequisites:
 *   - A live PostgreSQL instance (Unix socket at /run/postgresql or TCP localhost:5432).
 *   - Three databases: reshard_example_src, reshard_example_dst, reshard_example_coord.
 *
 *   createdb reshard_example_src
 *   createdb reshard_example_dst
 *   createdb reshard_example_coord
 *
 * Run:
 *   node examples/resharding.js
 */

import { createDatabase } from "../dist/index.js";
import { Pool } from "pg";

const URI = (name) => `postgresql://postgres@/${name}?host=/run/postgresql`;

async function main() {
    const srcPool = new Pool({ connectionString: URI("reshard_example_src"), max: 5 });
    const dstPool = new Pool({ connectionString: URI("reshard_example_dst"), max: 5 });
    let db = null;

    try {
        // Seed source data.
        await srcPool.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id BIGSERIAL PRIMARY KEY,
                owner TEXT NOT NULL,
                balance BIGINT NOT NULL DEFAULT 0,
                shard_key TEXT NOT NULL
            )
        `);
        await dstPool.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id BIGSERIAL PRIMARY KEY,
                owner TEXT NOT NULL,
                balance BIGINT NOT NULL DEFAULT 0,
                shard_key TEXT NOT NULL
            )
        `);
        await srcPool.query(`TRUNCATE accounts RESTART IDENTITY`);
        await dstPool.query(`TRUNCATE accounts RESTART IDENTITY`);
        await srcPool.query(
            `INSERT INTO accounts (owner, balance, shard_key)
             VALUES ('alice', 100, 'user-1'), ('bob', 200, 'user-2'), ('carol', 300, 'user-3')`,
        );

        // Create the database with sharding enabled. The primary pool doubles as
        // the coordination authority for the resharding control plane.
        db = createDatabase({
            sharding: {
                enabled: true,
                strategy: "hash",
                shards: [
                    { id: "src", connection: { connectionString: URI("reshard_example_src"), max: 5 } },
                    { id: "dst", connection: { connectionString: URI("reshard_example_dst"), max: 5 } },
                ],
            },
        });

        const rsharding = db.resharding;
        if (!rsharding) {
            throw new Error("Resharding API unavailable (sharding must be enabled)");
        }

        // Initialize the durable migration schema (idempotent, versioned).
        await rsharding.init();
        await rsharding.initShard("src", srcPool);
        await rsharding.initShard("dst", dstPool);

        // Application-defined schema adapter. The package cannot infer schemas
        // or shard-key semantics, so the application describes them explicitly.
        const descriptor = {
            migrationId: `example-migration-${Date.now()}`,
            tables: [
                {
                    table: "accounts",
                    primaryKeyColumns: ["id"],
                    shardKeyColumns: ["shard_key"],
                    stableKeyOrder: true,
                    description: "accounts table",
                    readBatch: async ({ client, unit, batchSize, cursor }) => {
                        const lastId = cursor?.lastValues?.[0] ?? 0;
                        const result = await client.query(
                            `SELECT id, owner, balance, shard_key FROM accounts
                             WHERE id > $1 ORDER BY id ASC LIMIT $2`,
                            [lastId, batchSize],
                        );
                        const rows = result.rows;
                        const nextCursor =
                            rows.length === 0
                                ? null
                                : {
                                      kind: "keyset",
                                      columns: ["id"],
                                      lastValues: [rows[rows.length - 1].id],
                                      batchNo: (cursor?.batchNo ?? 0) + 1,
                                      updatedAt: new Date().toISOString(),
                                  };
                        return { rows, nextCursor, done: rows.length < batchSize };
                    },
                    upsertRows: async ({ client, rows }) => {
                        for (const row of rows) {
                            await client.query(
                                `INSERT INTO accounts (id, owner, balance, shard_key)
                                 VALUES ($1,$2,$3,$4)
                                 ON CONFLICT (id) DO UPDATE SET
                                   owner = EXCLUDED.owner,
                                   balance = EXCLUDED.balance,
                                   shard_key = EXCLUDED.shard_key`,
                                [row.id, row.owner, row.balance, row.shard_key],
                            );
                        }
                        return { inserted: rows.length, updated: 0 };
                    },
                    countRows: async ({ client }) => {
                        const res = await client.query(`SELECT COUNT(*) AS c FROM accounts`);
                        return Number(res.rows[0].c);
                    },
                },
            ],
            order: ["accounts"],
            consistencyBoundary: "streamed",
        };

        // Target topology: only the destination shard owns the data after cutover.
        const targetTopology = {
            shards: [
                {
                    id: "dst",
                    version: 2,
                    connection: { host: undefined, port: undefined, database: undefined, user: undefined },
                    addedAt: new Date().toISOString(),
                },
            ],
            strategy: "hash",
            strategyConfig: {},
            routingVersion: 2,
            capturedAt: new Date().toISOString(),
        };

        // 1. Plan (durable, persisted before execution begins).
        const plan = await rsharding.plan(descriptor, targetTopology);
        console.log(`planned migration ${plan.migrationId}: ${plan.units.length} unit(s)`);

        // 2. Start bulk copy.
        await rsharding.start();
        console.log("status:", (await rsharding.getStatus()).status);

        // 3. Copy all units in bounded batches (resumable, checkpointed).
        await rsharding.copyUnits(descriptor);
        console.log("status:", (await rsharding.getStatus()).status);

        // 4. Validate before cutover (never cut over after failed validation).
        const { report, passed } = await rsharding.validate();
        console.log("validation passed:", passed, "units:", report.length);
        if (!passed) {
            throw new Error("validation failed; aborting before cutover");
        }

        // 5. Cutover (coordinated, recoverable; publishes new routing version).
        await rsharding.cutover();
        console.log("cutover complete; routing version:", await rsharding.refreshRoutingVersion());

        // 6. Finalize.
        await rsharding.finalize();
        console.log("status:", (await rsharding.getStatus()).status);

        // Verify data reached the destination.
        const dstCount = await dstPool.query(`SELECT COUNT(*) AS c FROM accounts`);
        console.log(`destination rows: ${dstCount.rows[0].c}`);

        console.log("Resharding example complete.");
    } finally {
        try {
            await db?.sharding?.shutdown();
        } catch {
            // ignore
        }
        await srcPool.end();
        await dstPool.end();
    }
}

main().catch((error) => {
    console.error("example failed:", error);
    process.exit(1);
});
