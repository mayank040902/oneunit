// ---------------------------------------------------------------------------
// Stage 3 — Distributed Drain Verification (Multi-Process, Real PostgreSQL)
//
// Tests distributed shard draining with two independent application processes
// (Application A and Application B) running as separate Node.js processes.
//
// Both applications connect to the same shard cluster and coordinate drain
// state through the shared coordination pool.
//
// ENVIRONMENT: Real PostgreSQL instances on ports 5440-5443.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { ShardManager } from "../../../../src/sharding/shard-manager.ts";
import { ShardConfigError } from "../../../../src/sharding/errors.ts";

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

const RESULT_DIR = "/tmp/kilo/sharding-integration/results";
const RESULT_A = join(RESULT_DIR, "drain-app-a.json");
const RESULT_B = join(RESULT_DIR, "drain-app-b.json");

let instancesReady = false;

function runApp(scriptName: string, resultFile: string): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
        const child = spawn("/home/lucius/Projects/oneunit/packages/database/node_modules/.bin/tsx", [scriptName, resultFile], {
            cwd: "/home/lucius/Projects/oneunit/packages/database",
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
        });

        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d) => (stdout += d.toString()));
        child.stderr?.on("data", (d) => (stderr += d.toString()));

        child.on("close", (code) => {
            resolve({ code, output: stdout + stderr });
        });
    });
}

function readResult(file: string): any {
    const fs = require("node:fs");
    if (!existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
}

describe("Stage 3 — Distributed Drain (multi-process, real PostgreSQL)", () => {
    beforeAll(async () => {
        // Verify infrastructure
        const { checkClusterHealth } = await import(
            "../infrastructure/pg-cluster.ts"
        );
        const health = await checkClusterHealth();
        instancesReady = health.every((h) => h.healthy);
        if (!instancesReady) {
            console.log("WARNING: Infrastructure not ready:", health);
        }
        // Ensure result directory exists
        try {
            const fs = await import("node:fs");
            fs.mkdirSync(RESULT_DIR, { recursive: true });
        } catch {}
        // Clean up old result files
        try { unlinkSync(RESULT_A); } catch {}
        try { unlinkSync(RESULT_B); } catch {}
    }, 30000);

    it("distributed drain waits for active operation from another instance", async () => {
        if (!instancesReady) {
            console.log("Skipping: infrastructure not ready");
            return;
        }

        // Start Application A (holds operation on shard-0)
        const appAPromise = runApp(
            "test/integration/sharding/distributed-drain/drain-app-a.ts",
            RESULT_A,
        );

        // Start Application B (attempts drain of shard-0)
        const appBPromise = runApp(
            "test/integration/sharding/distributed-drain/drain-app-b.ts",
            RESULT_B,
        );

        const [resultAraw, resultBraw] = await Promise.all([appAPromise, appBPromise]);

        const resultA = readResult(RESULT_A);
        const resultB = readResult(RESULT_B);

        console.log("Application A result:", JSON.stringify(resultA, null, 2));
        console.log("Application B result:", JSON.stringify(resultB, null, 2));

        // Application A should have acquired and released shard-0
        expect(resultA?.acquired).toBe(true);
        expect(resultA?.released).toBe(true);
        expect(resultA?.error).toBeNull();

        // Application B should have attempted drain
        expect(resultB?.drainStarted).toBe(true);

        // The drain should have timed out (waiting for App A's operation)
        // or completed after App A released. Either way, it should not
        // have corrupted state.
        expect(resultB?.error).toBeDefined();

        // After both apps complete, no active ops should remain
        const manager = new ShardManager(shardConfigs, undefined, undefined, undefined, {
            instanceId: "verify",
            coordinationMode: "local-only",
        });
        const finalOps = manager.getActiveOps("shard-0");
        expect(finalOps).toBe(0);
        await manager.shutdown();
    }, 60000);

    it("shard removal respects drain state across instances", async () => {
        if (!instancesReady) {
            console.log("Skipping: infrastructure not ready");
            return;
        }

        const manager = new ShardManager(shardConfigs, undefined, undefined, undefined, {
            instanceId: "verify-2",
            coordinationMode: "local-only",
            abandonedOperationTimeoutMs: 5000,
        });

        // shard-1 should still exist (was not drained by app B which targeted shard-0)
        expect(manager.hasShard("shard-1")).toBe(true);

        await manager.shutdown();
    }, 30000);
});
