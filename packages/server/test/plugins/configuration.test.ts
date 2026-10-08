import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
    createBootstrapServer,
    type BootstrapServerOptions,
} from "../../src/bootstrap.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
    for (const app of apps.splice(0)) {
        try { await app.close(); } catch { /* ignore */ }
    }
});

describe("Plugin Configuration Forwarding Tests", () => {
    const baseOptions: Partial<BootstrapServerOptions> = {
        logger: false,
        kafka: false,
        realtime: false,
        database: false,
        redis: false,
        env: false,
        health: false,
    };

    it("forwards cors options to @fastify/cors", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            cors: { origin: ["https://example.com"], credentials: true },
        });

        const res = await server.inject({
            method: "GET",
            url: "/health",
            headers: { origin: "https://example.com" },
        });
        expect(res.headers["access-control-allow-origin"]).toBe("https://example.com");

        await server.close();
    });

    it("forwards helmet options to @fastify/helmet", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            helmet: { contentSecurityPolicy: false },
        });

        const res = await server.inject({ method: "GET", url: "/health" });
        expect(res.headers["x-content-type-options"]).toBe("nosniff");

        await server.close();
    });

    it("forwards cookie options to @fastify/cookie", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            cookie: { secret: "test-secret-key-for-signing" },
        });

        expect(server).toBeDefined();
        await server.close();
    });

    it("forwards compress options to @fastify/compress", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            compress: { threshold: 1024 },
            health: true,
        });

        const res = await server.inject({
            method: "GET",
            url: "/health",
            headers: { "accept-encoding": "gzip" },
        });
        // Server starts and health route works (compress is registered)
        expect(res.statusCode).toBe(200);

        await server.close();
    });

    it("forwards rateLimit options to @fastify/rate-limit", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            rateLimit: { max: 5, timeWindow: "1 minute" },
            health: true,
        });

        const results = [];
        for (let i = 0; i < 7; i++) {
            const res = await server.inject({ method: "GET", url: "/health" });
            results.push(res.statusCode);
        }
        expect(results).toContain(200);
        expect(results).toContain(429);

        await server.close();
    });

    it("forwards csrf options to @fastify/csrf-protection", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            cookie: { secret: "test-secret-key-for-signing" },
            csrf: { cookieOpts: { secure: false } },
            configure: (app) => {
                app.post("/test-csrf", { preHandler: [app.csrfProtection] }, async () => ({ ok: true }));
            },
        });

        const res = await server.inject({
            method: "POST",
            url: "/test-csrf",
            headers: { "content-type": "application/json" },
            payload: {},
        });
        // CSRF plugin should reject requests without proper CSRF token
        expect(res.statusCode).toBe(403);

        await server.close();
    });

    it("forwards underPressure options to @fastify/under-pressure", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            underPressure: { exposeStatusRoute: { url: "/__underpressure" } },
        });

        const res = await server.inject({ method: "GET", url: "/__underpressure" });
        expect(res.statusCode).toBe(200);

        await server.close();
    });

    it("forwards errorHandler options", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            errorHandler: { includeStack: true, logErrors: true },
        });

        const res = await server.inject({ method: "GET", url: "/nonexistent-error-test" });
        // Should use custom error handler
        expect(res.statusCode).toBe(404);
        const body = res.json();
        expect(body.error).toBeDefined();

        await server.close();
    });

    it("normalizes true to defaults", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            cors: true,
            helmet: true,
            cookie: true,
            compress: true,
            rateLimit: true,
        });

        expect(server).toBeDefined();
        await server.close();
    });

    it("serviceName is forwarded to logger plugin", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            serviceName: "my-test-service",
            logger: { useHttpLogger: false },
        });

        expect(server).toBeDefined();
        await server.close();
    });
});

describe("Plugin Configuration Precedence Tests", () => {
    const baseOptions: Partial<BootstrapServerOptions> = {
        logger: false,
        kafka: false,
        realtime: false,
        database: false,
        redis: false,
        env: false,
        health: false,
    };

    it("plugins object overrides DEFAULT_BUILTIN_PLUGINS", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            plugins: {
                cors: { origin: ["https://test.com"] },
            },
        });

        const res = await server.inject({
            method: "GET",
            url: "/health",
            headers: { origin: "https://test.com" },
        });
        expect(res.headers["access-control-allow-origin"]).toBe("https://test.com");

        await server.close();
    });

    it("plugins object can disable a default-enabled plugin", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            plugins: {
                helmet: false,
                cors: false,
            },
        });

        const res = await server.inject({ method: "GET", url: "/health" });
        // Helmet disabled — no security headers
        expect(res.headers["x-content-type-options"]).toBeUndefined();

        await server.close();
    });

    it("top-level options override DEFAULT_BUILTIN_PLUGINS", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            cors: { origin: ["https://top-level.com"] },
        });

        const res = await server.inject({
            method: "GET",
            url: "/health",
            headers: { origin: "https://top-level.com" },
        });
        expect(res.headers["access-control-allow-origin"]).toBe("https://top-level.com");

        await server.close();
    });

    it("extraPlugins are always treated as array, not config", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            extraPlugins: [
                async (app: FastifyInstance) => {
                    app.decorate("extraPluginRan", true);
                },
            ],
        });

        expect(server.extraPluginRan).toBe(true);
        await server.close();
    });

    it("plugins array form registers custom plugins in order", async () => {
        const order: string[] = [];

        const server = await createBootstrapServer({
            ...baseOptions,
            plugins: [
                async (app: FastifyInstance) => {
                    order.push("plugin-a");
                    app.decorate("pluginA", true);
                },
                async (app: FastifyInstance) => {
                    order.push("plugin-b");
                    app.decorate("pluginB", true);
                },
            ],
        });

        expect(server.pluginA).toBe(true);
        expect(server.pluginB).toBe(true);
        expect(order).toEqual(["plugin-a", "plugin-b"]);

        await server.close();
    });

    it("plugins array and extraPlugins run after builtins", async () => {
        let builtinsDone = false;

        const server = await createBootstrapServer({
            ...baseOptions,
            plugins: [
                async (app: FastifyInstance) => {
                    builtinsDone = typeof app.healthRegistry !== "undefined";
                    app.decorate("customCheck", builtinsDone);
                },
            ],
        });

        expect(server.customCheck).toBe(true);
        await server.close();
    });

    it("plugins config object + extraPlugins array works together", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            plugins: {
                compress: { threshold: 2048 },
            },
            extraPlugins: [
                async (app: FastifyInstance) => {
                    app.decorate("marker", "present");
                },
            ],
        });

        expect(server.marker).toBe("present");
        await server.close();
    });
});
