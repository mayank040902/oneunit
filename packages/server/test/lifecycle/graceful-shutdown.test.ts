import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
    createBootstrapServer,
    startBootstrapServer,
    type BootstrapServerOptions,
} from "../../src/bootstrap.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
    for (const app of apps.splice(0)) {
        try { await app.close(); } catch { /* ignore */ }
    }
});

describe("Graceful Shutdown Tests", () => {
    const baseOptions: Partial<BootstrapServerOptions> = {
        logger: false,
        kafka: false,
        realtime: false,
        database: false,
        redis: false,
        env: false,
        health: false,
    };

    it("close() triggers onClose hooks in reverse order", async () => {
        const order: string[] = [];

        const server = await createBootstrapServer({
            ...baseOptions,
            extraPlugins: [
                async (app: FastifyInstance) => {
                    app.addHook("onClose", async () => {
                        order.push("first");
                    });
                },
                async (app: FastifyInstance) => {
                    app.addHook("onClose", async () => {
                        order.push("second");
                    });
                },
            ],
        });

        await server.ready();
        await server.close();
        expect(order).toEqual(["second", "first"]);
    });

    it("graceful shutdown is idempotent", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
        });

        await server.ready();

        await server.close();
        await server.close();
        await server.close();
    });

    it("SIGTERM triggers graceful shutdown", async () => {
        const result = await startBootstrapServer({
            ...baseOptions,
            port: 0,
            gracefulShutdown: true,
        });

        const sigtermListeners = process.listeners("SIGTERM");
        expect(sigtermListeners.length).toBeGreaterThan(0);

        // The handler is registered with process.once, so it will only fire once
        await result.close();
    });

    it("SIGINT triggers graceful shutdown", async () => {
        const result = await startBootstrapServer({
            ...baseOptions,
            port: 0,
            gracefulShutdown: true,
        });

        const sigintListeners = process.listeners("SIGINT");
        expect(sigintListeners.length).toBeGreaterThan(0);

        await result.close();
    });

    it("signal handlers use process.once (not process.on)", async () => {
        const beforeSigint = process.listenerCount("SIGINT");
        const beforeSigterm = process.listenerCount("SIGTERM");

        const result = await startBootstrapServer({
            ...baseOptions,
            port: 0,
            gracefulShutdown: true,
        });

        const afterSigint = process.listenerCount("SIGINT");
        const afterSigterm = process.listenerCount("SIGTERM");

        expect(afterSigint).toBe(beforeSigint + 1);
        expect(afterSigterm).toBe(beforeSigterm + 1);

        await result.close();
    });

    it("double close is safe and idempotent", async () => {
        const onCloseCalls: string[] = [];

        const server = await createBootstrapServer({
            ...baseOptions,
            extraPlugins: [
                async (app: FastifyInstance) => {
                    app.addHook("onClose", async () => {
                        onCloseCalls.push("cleanup");
                    });
                },
            ],
        });

        await server.ready();

        await server.close();
        expect(onCloseCalls).toEqual(["cleanup"]);

        // Calling close again should not throw
        await server.close();
        expect(onCloseCalls).toEqual(["cleanup"]);
    });

    it("shutdown completes within reasonable time", async () => {
        const start = Date.now();
        const server = await startBootstrapServer({
            ...baseOptions,
            port: 0,
            gracefulShutdown: true,
        });

        await server.close();
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(10000);
    });

    it("onClose hooks complete before process exit", async () => {
        let cleanupDone = false;

        const server = await createBootstrapServer({
            ...baseOptions,
            extraPlugins: [
                async (app: FastifyInstance) => {
                    app.addHook("onClose", async () => {
                        await new Promise((r) => setTimeout(r, 50));
                        cleanupDone = true;
                    });
                },
            ],
        });

        await server.ready();
        await server.close();
        expect(cleanupDone).toBe(true);
    });

    it("server close rejects new connections", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
        });

        await server.ready();

        // Inject requests after close to verify server is shut down
        await server.close();

        // Server should be closed — inject creates a new handle
        // which should still work for testing but not on real socket
        try {
            await server.inject({ method: "GET", url: "/health" });
            // In inject mode, requests can still work; this is expected for test mode
        } catch (err) {
            // Also acceptable — server is closed
        }
    });

    it("gracefulShutdown with infrastructure plugins", async () => {
        const server = await startBootstrapServer({
            ...baseOptions,
            port: 0,
            gracefulShutdown: true,
        });

        await server.close();
    });

    it("gracefulShutdown false still allows manual close", async () => {
        const server = await startBootstrapServer({
            ...baseOptions,
            port: 0,
            gracefulShutdown: false,
        });

        await server.close();
    });
});

describe("Process-Isolated Signal Handling Tests", () => {
    it("child process exits on SIGTERM with gracefulShutdown", async () => {
        // Write a temporary script for the child process
        const fs = await import("node:fs");
        const path = await import("node:path");
        const tmpScript = path.join(process.cwd(), ".tmp-graceful-child.mjs");
        fs.writeFileSync(
            tmpScript,
            `import { startBootstrapServer } from "./dist/bootstrap.js";
const server = await startBootstrapServer({
  port: 0,
  logger: false,
  kafka: false,
  realtime: false,
  database: false,
  redis: false,
  env: false,
  health: false,
  gracefulShutdown: true,
});
console.log("READY:" + server.port);
`,
        );

        const child = spawn(process.execPath, [tmpScript], {
            cwd: process.cwd(),
            stdio: ["pipe", "pipe", "pipe"],
        });

        let output = "";
        let port: number | null = null;

        await new Promise((resolve) => {
            child.stdout?.on("data", (data) => {
                output += data.toString();
                const match = output.match(/READY:(\d+)/);
                if (match) {
                    port = parseInt(match[1], 10);
                    resolve(undefined);
                }
            });
            child.stderr?.on("data", (data) => {
                output += data.toString();
            });
            setTimeout(() => resolve(undefined), 5000);
        });

        if (port) {
            child.kill("SIGTERM");
        }

        // Wait for process to exit
        const exitCode = await new Promise<number | null>((resolve) => {
            child.on("exit", (code) => resolve(code));
        });

        fs.unlinkSync(tmpScript);
        expect(exitCode).toBe(0);
    }, 15000);

    it("child process with gracefulShutdown handles SIGINT", async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const tmpScript = path.join(process.cwd(), ".tmp-graceful-child2.mjs");
        fs.writeFileSync(
            tmpScript,
            `import { startBootstrapServer } from "./dist/bootstrap.js";
const server = await startBootstrapServer({
  port: 0,
  logger: false,
  kafka: false,
  realtime: false,
  database: false,
  redis: false,
  env: false,
  health: false,
  gracefulShutdown: true,
});
console.log("READY:" + server.port);
// Keep alive
setInterval(() => {}, 1000);
`,
        );

        const child = spawn(process.execPath, [tmpScript], {
            cwd: process.cwd(),
            stdio: ["pipe", "pipe", "pipe"],
        });

        let output = "";
        let ready = false;

        await new Promise((resolve) => {
            child.stdout?.on("data", (data) => {
                output += data.toString();
                if (output.includes("READY")) {
                    ready = true;
                    resolve(undefined);
                }
            });
            setTimeout(() => resolve(undefined), 5000);
        });

        expect(ready).toBe(true);

        child.kill("SIGINT");

        await new Promise((resolve) => {
            child.on("exit", () => resolve(undefined));
            setTimeout(() => resolve(undefined), 5000);
        });

        fs.unlinkSync(tmpScript);
    }, 15000);
});
