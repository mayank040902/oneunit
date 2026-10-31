// ---------------------------------------------------------------------------
// Distributed Drain Test — Application Process A
//
// Holds a long-running operation on shard-0 while Application B attempts to
// drain shard-0. Reports results via a result file for the parent test to
// read.
//
// Usage: tsx drain-app-a.ts <result-file-path>
// ---------------------------------------------------------------------------

import { ShardManager } from "../../../../src/sharding/shard-manager.ts";
import { Pool } from "pg";

const resultFile = process.argv[2];
const SHARD_PORT = 5440;
const COORD_PORT = 5441;

const shardConfigs = [
    {
        id: "shard-0",
        connection: {
            host: "127.0.0.1",
            port: SHARD_PORT,
            user: "postgres",
            database: "shard0",
        },
    },
    {
        id: "shard-1",
        connection: {
            host: "127.0.0.1",
            port: COORD_PORT,
            user: "postgres",
            database: "shard1",
        },
    },
];

const result: {
    app: string;
    acquired: boolean;
    released: boolean;
    error: string | null;
    activeOpsAtEnd: number | null;
} = {
    app: "A",
    acquired: false,
    released: false,
    error: null,
    activeOpsAtEnd: null,
};

async function main() {
    const manager = new ShardManager(shardConfigs, undefined, undefined, undefined, {
        instanceId: "app-a",
        coordinationMode: "local-only",
        abandonedOperationTimeoutMs: 10000,
    });

    try {
        // Acquire shard-0 for a long-running operation
        await manager.acquireShard("shard-0");
        result.acquired = true;
        result.activeOpsAtEnd = manager.getActiveOps("shard-0");

        // Hold the operation for 15 seconds to allow drain to be attempted
        await new Promise((resolve) => setTimeout(resolve, 15000));

        // Release
        await manager.releaseShard("shard-0");
        result.released = true;
        result.activeOpsAtEnd = manager.getActiveOps("shard-0");
    } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
    } finally {
        await manager.shutdown();
    }

    // Write result
    const fs = await import("node:fs");
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
}

main().catch((error) => {
    result.error = error instanceof Error ? error.message : String(error);
    const fs = async () => {
        const f = await import("node:fs");
        f.writeFileSync(resultFile, JSON.stringify(result, null, 2));
    };
    fs().then(() => process.exit(1));
});
