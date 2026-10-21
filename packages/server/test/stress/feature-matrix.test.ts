import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
    createBootstrapServer,
    createServer,
    startBootstrapServer,
    startServer,
} from "../../src/bootstrap.js";

/**
 * Feature matrix.
 *
 * One row per capability the package documents. Every row asserts that the
 * feature is reachable through the public API and that it has the effect the
 * documentation promises — not merely that the server starts.
 */

const apps: FastifyInstance[] = [];

function track<T extends FastifyInstance>(app: T): T {
    apps.push(app);
    return app;
}

afterEach(async () => {
    for (const app of apps.splice(0)) {
        try {
            await app.close();
        } catch {
            // ignore close errors
        }
    }
});

const baseOptions = {
    logger: false as const,
    kafka: false as const,
    realtime: false as const,
    database: false as const,
    redis: false as const,
    env: false as const,
};

describe("Feature matrix — bootstrap surface", () => {
    it("exposes the four entry points", async () => {
        expect(typeof createBootstrapServer).toBe("function");
        expect(typeof startBootstrapServer).toBe("function");
        expect(createServer).toBe(createBootstrapServer);
        expect(startServer).toBe(startBootstrapServer);
    });

    it("creates a server without listening", async () => {
        const app = track(await createBootstrapServer({ ...baseOptions, health: false }));
        await app.ready();
        expect(app.server.listening).toBe(false);
    });

    it("listens and reports the bound address", async () => {
        const { app, address, port, host, close } = await startBootstrapServer({
            ...baseOptions,
            health: false,
            port: 0,
            host: "127.0.0.1",
        });
        apps.push(app);

        expect(app.server.listening).toBe(true);
        expect(port).toBeGreaterThan(0);
        expect(host).toBe("127.0.0.1");
        expect(address).toContain("127.0.0.1");

        await close();
        expect(app.server.listening).toBe(false);
    });

    it("runs configure() after the builtin plugins", async () => {
        const order: string[] = [];
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            configure: (server) => {
                // The response helpers are already there when configure runs.
                order.push("configure");
                server.get("/probe", async (_request, reply) => reply.ok());
            },
            extraPlugins: [
                {
                    plugin: async (server) => {
                        order.push("plugin");
                        server.get("/plugin-route", async () => ({ ok: true }));
                    },
                },
            ],
        }));
        await app.ready();

        expect(order).toEqual(["plugin", "configure"]);

        const probe = await app.inject({ method: "GET", url: "/probe" });
        expect(probe.json().success).toBe(true);
    });

    it("accepts a plugin list through the plugins option", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            plugins: [
                async (server) => {
                    server.get("/from-plugins", async () => ({ ok: true }));
                },
            ],
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/from-plugins" });
        expect(response.json().ok).toBe(true);
    });

    it("registers the request and server hooks", async () => {
        const events: string[] = [];
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            hooks: {
                onRequest: [
                    async () => { events.push("onRequest-1"); },
                    async () => { events.push("onRequest-2"); },
                ],
                preHandler: async () => { events.push("preHandler"); },
                onSend: async () => { events.push("onSend"); },
                onResponse: async () => { events.push("onResponse"); },
                onReady: async () => { events.push("onReady"); },
            },
            configure: (server) => {
                server.get("/hooked", async () => ({ ok: true }));
            },
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/hooked" });

        expect(response.statusCode).toBe(200);
        expect(events).toContain("onReady");
        expect(events).toContain("onRequest-1");
        expect(events).toContain("onRequest-2");
        expect(events).toContain("preHandler");
        expect(events).toContain("onSend");
        expect(events).toContain("onResponse");
    });

    it("passes the fastify options through", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            fastify: { bodyLimit: 1024 },
        }));
        await app.ready();

        expect(app.initialConfig.bodyLimit).toBe(1024);
    });
});

describe("Feature matrix — builtin plugins", () => {
    it("registers the framework plugins by default", async () => {
        const app = track(await createBootstrapServer({ ...baseOptions, health: false }));
        await app.ready();

        expect(app.hasReplyDecorator("ok")).toBe(true);
        expect(app.hasReplyDecorator("respond")).toBe(true);
        expect(app.hasReplyDecorator("notFound")).toBe(true);
        expect(app.msgpack).toBeDefined();
    });

    it("can disable every framework plugin", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            responseManagement: false,
            msgpack: false,
        }));
        await app.ready();

        expect(app.hasReplyDecorator("ok")).toBe(false);
        expect(app.hasReplyDecorator("msgpack")).toBe(false);
    });

    it("installs the CORS headers", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            cors: { origin: ["https://example.com"], credentials: true },
            configure: (server) => {
                server.get("/cors", async () => ({ ok: true }));
            },
        }));
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: "/cors",
            headers: { origin: "https://example.com" },
        });

        expect(response.headers["access-control-allow-origin"]).toBe("https://example.com");
        expect(response.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("keeps the default credentials when only the origin is set", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            cors: { origin: ["https://example.com"] },
            configure: (server) => {
                server.get("/cors", async () => ({ ok: true }));
            },
        }));
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: "/cors",
            headers: { origin: "https://example.com" },
        });

        expect(response.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("installs the security headers", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            configure: (server) => {
                server.get("/secure", async () => ({ ok: true }));
            },
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/secure" });

        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["x-powered-by"]).toBeUndefined();
    });

    it("parses the cookies", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            configure: (server) => {
                server.get("/cookie", async (request) => ({ value: request.cookies.session }));
            },
        }));
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: "/cookie",
            headers: { cookie: "session=abc" },
        });

        expect(response.json().value).toBe("abc");
    });

    it("compresses a large answer", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            compress: { threshold: 100 },
            configure: (server) => {
                server.get("/big", async () => ({ blob: "x".repeat(4096) }));
            },
        }));
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: "/big",
            headers: { "accept-encoding": "gzip" },
        });

        expect(response.headers["content-encoding"]).toBe("gzip");
    });

    it("validates a request with a zod schema", async () => {
        const { z } = await import("zod");
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            configure: (server) => {
                server.post("/users", { schema: { body: z.object({ email: z.string().email() }) } }, async () => ({ ok: true }));
            },
        }));
        await app.ready();

        const accepted = await app.inject({
            method: "POST",
            url: "/users",
            payload: { email: "a@b.co" },
        });
        expect(accepted.statusCode).toBe(200);

        const rejected = await app.inject({
            method: "POST",
            url: "/users",
            payload: { email: "nope" },
        });
        expect(rejected.statusCode).toBe(400);
    });

    it("exposes the request context", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            requestContext: true,
            configure: (server) => {
                server.get("/context", async (request) => {
                    const context = (request as unknown as {
                        requestContext: { set(key: string, value: string): void; get(key: string): string };
                    }).requestContext;
                    context.set("requestId", "abc");
                    return { hasContext: typeof context.get("requestId") === "string" };
                });
            },
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/context" });
        expect(response.json().hasContext).toBe(true);
    });

    it("answers a multipart upload", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            multipart: true,
            configure: (server) => {
                server.post("/upload", async (request) => {
                    const file = await (request as { file(): Promise<{ filename: string }> }).file();
                    return { filename: file?.filename };
                });
            },
        }));
        await app.ready();

        const boundary = "----auditboundary";
        const payload = [
            `--${boundary}`,
            'Content-Disposition: form-data; name="file"; filename="a.txt"',
            "Content-Type: text/plain",
            "",
            "hello",
            `--${boundary}--`,
            "",
        ].join("\r\n");

        const response = await app.inject({
            method: "POST",
            url: "/upload",
            headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
            payload,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().filename).toBe("a.txt");
    });

    it("builds the OpenAPI document when swagger is enabled", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            swagger: { openapi: { info: { title: "audit", version: "1.0.0" } } },
            configure: (server) => {
                server.get("/documented", async () => ({ ok: true }));
            },
        }));
        await app.ready();

        const spec = (app as unknown as { swagger(): { info: { title: string }; paths: Record<string, unknown> } }).swagger();
        expect(spec.info.title).toBe("audit");
        expect(spec.paths["/documented"]).toBeDefined();
    });

    it("serves the documentation route when swagger UI is enabled", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: false,
            swagger: true,
            swaggerUI: true,
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/documentation" });
        expect(response.statusCode).toBe(200);
    });
});

describe("Feature matrix — health", () => {
    it("serves the health route with the service name", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: true,
            serviceName: "audit-service",
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/health" });

        expect(response.statusCode).toBe(200);
        expect(response.json().service).toBe("audit-service");
        expect(response.json().status).toBeTypeOf("string");
    });

    it("serves the health route on a custom path", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: { path: "/status" },
        }));
        await app.ready();

        expect((await app.inject({ method: "GET", url: "/status" })).statusCode).toBe(200);
        expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(404);
    });

    it("removes the health route when it is disabled", async () => {
        const app = track(await createBootstrapServer({ ...baseOptions, health: false }));
        await app.ready();

        expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(404);
    });
});
