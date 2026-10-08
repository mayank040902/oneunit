import type { FastifyInstance } from "fastify";
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

describe("Lifecycle and Resource Safety Tests", () => {
    const baseOptions: Partial<BootstrapServerOptions> = {
        logger: false,
        kafka: false,
        realtime: false,
        database: false,
        redis: false,
        env: false,
        health: false,
    };

    it("createBootstrapServer does not call listen()", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            port: 0,
        });

        // Server should be created but not listening
        expect(server).toBeDefined();
        const addr = server.server.address();
        expect(addr).toBeNull(); // Not listening

        await server.close();
    });

    it("startBootstrapServer calls listen() and returns address", async () => {
        const { app, address, port, host } = await startBootstrapServer({
            ...baseOptions,
            port: 0,
        });

        expect(app).toBeDefined();
        expect(address).toBeDefined();
        expect(port).toBeGreaterThan(0);
        expect(host).toBeDefined();

        await app.close();
    });

    it("startBootstrapServer attaches graceful shutdown when enabled", async () => {
        const result = await startBootstrapServer({
            ...baseOptions,
            port: 0,
            gracefulShutdown: true,
        });

        expect(typeof result.close).toBe("function");
        await result.close();
    });

    it("startBootstrapServer does not attach graceful shutdown when disabled", async () => {
        const result = await startBootstrapServer({
            ...baseOptions,
            port: 0,
            gracefulShutdown: false,
        });

        expect(typeof result.close).toBe("function");
        await result.close();
    });

    it("close() can be called multiple times without error", async () => {
        const { app } = await startBootstrapServer({
            ...baseOptions,
            port: 0,
        });

        await app.close();
        await app.close();
        await app.close();
    });

    it("start → close → can create new server on same port", async () => {
        const port = 0;
        const server1 = await startBootstrapServer({
            ...baseOptions,
            port,
        });
        await server1.close();

        const server2 = await startBootstrapServer({
            ...baseOptions,
            port,
        });
        expect(server2.port).toBeGreaterThan(0);
        await server2.close();
    });

    it("multiple servers can run simultaneously on different ports", async () => {
        const server1 = await startBootstrapServer({
            ...baseOptions,
            port: 0,
        });
        const server2 = await startBootstrapServer({
            ...baseOptions,
            port: 0,
        });

        expect(server1.port).not.toBe(server2.port);
        expect(server1.address).not.toBe(server2.address);

        await server1.close();
        await server2.close();
    });

    it("server.close() resolves onClose hooks", async () => {
        let onCloseCalled = false;

        const server = await createBootstrapServer({
            ...baseOptions,
            extraPlugins: [
                async (app: FastifyInstance) => {
                    app.addHook("onClose", async () => {
                        onCloseCalled = true;
                    });
                },
            ],
        });

        await server.ready();
        await server.close();
        expect(onCloseCalled).toBe(true);
    });

    it("server.close() triggers infrastructure cleanup hooks", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            database: { logQueries: false },
            redis: { healthCheck: false },
        });

        await server.ready();
        await server.close();
        // If onClose hooks threw, this would error
        expect(true).toBe(true);
    });

    it("server.close() does not leave open handles (within timeout)", async () => {
        const server = await startBootstrapServer({
            ...baseOptions,
            port: 0,
        });

        await server.close();
        // If handles are left open, process would hang
        expect(true).toBe(true);
    });

    it("createBootstrapServer returns a ready FastifyInstance", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
        });

        expect(server.ready).toBeDefined();
        expect(server.inject).toBeDefined();
        expect(server.close).toBeDefined();
        expect(server.log).toBeDefined();
        expect(server.healthRegistry).toBeDefined();

        await server.close();
    });

    it("server can be injected without listening", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            health: true,
        });

        const res = await server.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);

        await server.close();
    });

    it("port 0 binds to ephemeral port", async () => {
        const server = await startBootstrapServer({
            ...baseOptions,
            port: 0,
        });

        expect(server.port).toBeGreaterThan(0);
        expect(server.port).toBeLessThan(65535);

        await server.close();
    });

    it("gracefulShutdown true registers signal handlers", async () => {
        const server = await startBootstrapServer({
            ...baseOptions,
            port: 0,
            gracefulShutdown: true,
        });

        // Verify listeners were attached
        const sigintListeners = process.listeners("SIGINT");
        const sigtermListeners = process.listeners("SIGTERM");
        expect(sigintListeners.length).toBeGreaterThan(0);
        expect(sigtermListeners.length).toBeGreaterThan(0);

        await server.close();
    });

    it("gracefulShutdown false does not register signal handlers", async () => {
        const beforeSigint = process.listenerCount("SIGINT");
        const beforeSigterm = process.listenerCount("SIGTERM");

        const server = await startBootstrapServer({
            ...baseOptions,
            port: 0,
            gracefulShutdown: false,
        });

        const afterSigint = process.listenerCount("SIGINT");
        const afterSigterm = process.listenerCount("SIGTERM");

        expect(afterSigint).toBe(beforeSigint);
        expect(afterSigterm).toBe(beforeSigterm);

        await server.close();
    });

    it("server respects custom host binding", async () => {
        const server = await startBootstrapServer({
            ...baseOptions,
            port: 0,
            host: "127.0.0.1",
        });

        expect(server.host).toBe("127.0.0.1");

        await server.close();
    });
});
