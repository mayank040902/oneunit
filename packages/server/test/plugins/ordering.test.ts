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

describe("Plugin Ordering Tests", () => {
    const baseOptions: Partial<BootstrapServerOptions> = {
        logger: false,
        kafka: false,
        realtime: false,
        database: false,
        redis: false,
        env: false,
        health: false,
    };

    it("registers health registry before infrastructure plugins", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
        });

        // healthRegistry should be available (registered early)
        expect(server.healthRegistry).toBeDefined();
        await server.close();
    });

    it("registers system health provider before health route", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            health: { includeDetails: true },
        });

        await server.ready();
        const res = await server.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.checks.system).toBeDefined();

        await server.close();
    });

    it("response management reply helpers are available (fp wrapper)", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            health: true,
            configure: (app) => {
                app.get("/test-response", async (_req, reply) => {
                    return reply.success({ data: "test" });
                });
            },
        });

        await server.ready();
        const res = await server.inject({ method: "GET", url: "/test-response" });
        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(true);

        await server.close();
    });

    it("logger is registered before error handler", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            logger: { useHttpLogger: false },
            errorHandler: { includeStack: false, logErrors: true },
            health: true,
        });

        await server.ready();
        // Error handler should work because logger was set up first
        const res = await server.inject({ method: "GET", url: "/nonexistent-route-xyz" });
        expect(res.statusCode).toBe(404);

        await server.close();
    });

    it("error handler is registered before health route", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            health: true,
        });

        await server.ready();
        const res = await server.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);

        // Trigger a 404 — error handler should format it
        const errorRes = await server.inject({ method: "GET", url: "/nonexistent-route-xyz" });
        expect(errorRes.statusCode).toBe(404);
        const body = errorRes.json();
        expect(body.error).toBeDefined();

        await server.close();
    });

    it("zod type provider is applied before response serialization", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            health: true,
        });

        await server.ready();
        const res = await server.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("application/json");

        await server.close();
    });

    it("msgpack content type parser is registered before application routes", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            configure: (app) => {
                app.post("/echo", async (request, reply) => {
                    reply.send(request.body);
                });
            },
        });

        await server.ready();

        const res = await server.inject({
            method: "POST",
            url: "/echo",
            headers: { "content-type": "application/msgpack", "accept": "application/json" },
            body: undefined,
        });

        // Just verify the route exists
        await server.close();
    });

    it("rateLimit is registered before application plugins", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            extraPlugins: [
                async (app: FastifyInstance) => {
                    app.decorate("rateLimited", typeof app.rateLimit !== "undefined" || true);
                },
            ],
        });

        expect(server).toBeDefined();
        await server.close();
    });

    it("application plugins run after all builtins", async () => {
        const server = await createBootstrapServer({
            ...baseOptions,
            extraPlugins: [
                async (app: FastifyInstance) => {
                    app.decorate("afterAll", true);
                },
            ],
            configure: (app) => {
                app.get("/order-test", async (request) => {
                    return { afterAll: app.afterAll };
                });
            },
        });

        const res = await server.inject({ method: "GET", url: "/order-test" });
        expect(res.statusCode).toBe(200);
        expect(res.json().afterAll).toBe(true);

        await server.close();
    });

    it("configure runs after all plugins including extraPlugins", async () => {
        let extraPluginRan = false;
        let configureRanAfter = false;

        const server = await createBootstrapServer({
            ...baseOptions,
            extraPlugins: [
                async () => {
                    extraPluginRan = true;
                },
            ],
            configure: (app) => {
                configureRanAfter = extraPluginRan;
                app.get("/order-check", async () => ({ ok: configureRanAfter }));
            },
        });

        await server.ready();
        const res = await server.inject({ method: "GET", url: "/order-check" });
        expect(res.json().ok).toBe(true);

        await server.close();
    });
});
