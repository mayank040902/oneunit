// ---------------------------------------------------------------------------
// Distributed Drain Test — Application Process B
//
// Attempts to drain shard-0 while Application A holds a long-running
// operation on it. Reports results via a result file.
//
// Usage: tsx drain-app-b.ts <result-file-path>
// ---------------------------------------------------------------------------

import { ShardManager } from "../../../../src/sharding/shard-manager.ts";

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
    drainStarted: boolean;
    drainCompleted: boolean;
    drainTimeout: boolean;
    activeOpsWhenDrainStarted: number | null;
    error: string | null;
} = {
    app: "B",
    drainStarted: false,
    drainCompleted: false,
    drainTimeout: false,
    activeOpsWhenDrainStarted: null,
    error: null,
};

async function main() {
    const manager = new ShardManager(shardConfigs, undefined, undefined, undefined, {
        instanceId: "app-b",
        coordinationMode: "local-only",
        abandonedOperationTimeoutMs: 10000,
    });

    try {
        // Wait a moment for Application A to acquire its operation
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Check active ops on shard-0 before drain
        result.activeOpsWhenDrainStarted = manager.getActiveOps("shard-0");

        // Attempt to remove/drain shard-0 (this should wait or timeout)
        const drainStart = Date.now();
        try {
            await manager.removeShard("shard-0");
            result.drainStarted = true;
            result.drainCompleted = true;
        } catch (error) {
            result.drainStarted = true;
            result.drainCompleted = false;
            const drainDuration = Date.now() - drainStart;
            result.error = error instanceof Error ? error.message : String(error);
            // If it timed out waiting for active ops, that's expected behavior
            if (result.error.includes("still in flight")) {
                result.drainTimeout = true;
            }
        }
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
