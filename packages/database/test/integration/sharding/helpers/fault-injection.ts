// ---------------------------------------------------------------------------
// Stage 3 — Fault-injection helpers for real PostgreSQL integration tests.
//
// Controls the PostgreSQL instances provisioned for the sharding integration
// suite (managed via pg_ctl, data directories under
// /tmp/kilo/sharding-integration). These helpers are for TEST use only and
// must never target production resources.
// ---------------------------------------------------------------------------

import { execSync } from "child_process";
import { Pool } from "pg";

export interface PgInstance {
    id: string;
    dataDir: string;
    port: number;
    host: string;
    user: string;
    database: string;
}

export const PG_INSTANCES: PgInstance[] = [
    { id: "shard-0", dataDir: "/tmp/kilo/sharding-integration/shard-0", port: 5440, host: "127.0.0.1", user: "postgres", database: "dtc_test" },
    { id: "shard-1", dataDir: "/tmp/kilo/sharding-integration/shard-1", port: 5441, host: "127.0.0.1", user: "postgres", database: "dtc_test" },
    { id: "shard-2", dataDir: "/tmp/kilo/sharding-integration/shard-2", port: 5442, host: "127.0.0.1", user: "postgres", database: "dtc_test" },
    { id: "coordination-db", dataDir: "/tmp/kilo/sharding-integration/coordination-db", port: 5443, host: "127.0.0.1", user: "postgres", database: "coordination" },
];

export function instanceById(id: string): PgInstance {
    const inst = PG_INSTANCES.find((x) => x.id === id);
    if (!inst) throw new Error(`Unknown PostgreSQL instance: ${id}`);
    return inst;
}

export function instanceUri(inst: PgInstance): string {
    return `postgresql://${inst.user}@${inst.host}:${inst.port}/${inst.database}`;
}

function pgIsReady(inst: PgInstance): boolean {
    try {
        execSync(`pg_isready -h ${inst.host} -p ${inst.port}`, { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

/** Remove a stale postmaster.pid if the server is not actually running. */
function clearStaleLock(inst: PgInstance): void {
    if (!pgIsReady(inst)) {
        try { execSync(`rm -f "${inst.dataDir}/postmaster.pid"`, { stdio: "pipe" }); } catch { /* ignore */ }
    }
}

/** Stop a PostgreSQL instance (fast shutdown). Safe to call if already stopped. */
export function stopPostgres(id: string, timeoutSec = 30): void {
    const inst = instanceById(id);
    if (!pgIsReady(inst)) return; // already down
    try {
        execSync(`pg_ctl -D "${inst.dataDir}" stop -m fast -t ${timeoutSec}`, { stdio: "pipe" });
    } catch {
        // Instance may already be stopping; treat as success.
    }
    // Wait until it is actually down.
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline && pgIsReady(inst)) {
        // eslint-disable-next-line no-empty
    }
}

/** Start a PostgreSQL instance. Throws if it cannot start. */
export function startPostgres(id: string, timeoutSec = 30): void {
    const inst = instanceById(id);
    if (pgIsReady(inst)) return; // already up
    clearStaleLock(inst);
    const start = () => {
        execSync(`pg_ctl -D "${inst.dataDir}" start -t ${timeoutSec}`, { stdio: "pipe" });
    };
    try {
        start();
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // If a stale shared memory block is held by a dead backend, remove it
        // and retry once (common after an unclean instance kill).
        const match = msg.match(/shared memory block \(key \d+, ID (\d+)\)/);
        if (match) {
            try { execSync(`ipcrm -m ${match[1]}`, { stdio: "pipe" }); } catch { /* ignore */ }
            clearStaleLock(inst);
            start();
        } else {
            throw error;
        }
    }
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline && !pgIsReady(inst)) {
        // eslint-disable-next-line no-empty
    }
    if (!pgIsReady(inst)) throw new Error(`PostgreSQL instance "${id}" failed to start`);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until the instance accepts connections. */
export async function waitForReady(id: string, timeoutMs = 30000): Promise<void> {
    const inst = instanceById(id);
    const pool = new Pool({ ...inst, max: 1, connect_timeout: 3, statement_timeout: 5000 });
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
        try {
            await pool.query("SELECT 1");
            await pool.end();
            return;
        } catch (error) {
            lastError = error;
            await sleep(200);
        }
    }
    try { await pool.end().catch(() => {}); } catch { /* ignore */ }
    throw new Error(`PostgreSQL instance "${id}" did not become ready within ${timeoutMs}ms: ${lastError}`);
}

/** Assert the instance is currently accepting connections. */
export async function assertReady(id: string): Promise<void> {
    await waitForReady(id, 5000);
}

/** Ensure every instance is up (call after tests that stop/start instances). */
export async function ensureAllUp(): Promise<void> {
    for (const inst of PG_INSTANCES) {
        if (!pgIsReady(inst)) {
            startPostgres(inst.id);
        }
    }
}
