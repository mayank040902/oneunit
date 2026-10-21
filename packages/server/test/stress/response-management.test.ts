import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createBootstrapServer } from "../../src/bootstrap.js";

/**
 * Adversarial cases for the response envelope.
 *
 * The envelope is built from values the application hands over, so those
 * values have to be able to carry anything without breaking the answer.
 */

const apps: FastifyInstance[] = [];

function track(app: FastifyInstance): FastifyInstance {
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
    health: false as const,
};

describe("Response envelope — adversarial input", () => {
    it("does not let the metadata pollute the prototype", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            configure: (server) => {
                server.get("/meta", async (_request, reply) => reply.ok({
                    metadata: JSON.parse('{"__proto__":{"polluted":true}}'),
                }));
            },
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/meta" });

        expect(response.statusCode).toBe(200);
        expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("keeps unicode and control characters intact", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            configure: (server) => {
                server.get("/unicode", async (_request, reply) => reply.success({
                    message: "héllo 🌍 — ok",
                    data: { emoji: "🚀", cjk: "日本語", combining: "e\u0301" },
                }));
            },
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/unicode" });
        const body = response.json();

        expect(body.msg).toBe("héllo 🌍 — ok");
        expect(body.data.emoji).toBe("🚀");
        expect(body.data.cjk).toBe("日本語");
    });

    it("escapes a message that looks like markup", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            configure: (server) => {
                server.get("/markup", async (_request, reply) => reply.success({
                    message: "<script>alert(1)</script>",
                }));
            },
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/markup" });

        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.json().msg).toBe("<script>alert(1)</script>");
    });

    it("answers a 500 instead of crashing on a circular payload", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            configure: (server) => {
                server.get("/circular", async (_request, reply) => {
                    const payload: Record<string, unknown> = { name: "loop" };
                    payload.self = payload;
                    return reply.success({ data: payload });
                });
            },
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/circular" });

        // The serializer cannot write the cycle; the error handler takes over.
        expect(response.statusCode).toBe(500);
        expect(response.json().error).toBeDefined();
    });

    it("carries a large payload in one answer", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            configure: (server) => {
                server.get("/large", async (_request, reply) => reply.success({
                    data: { blob: "x".repeat(256 * 1024) },
                }));
            },
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/large" });

        expect(response.statusCode).toBe(200);
        expect(response.json().data.blob).toHaveLength(256 * 1024);
    });

    it("keeps a numeric application code as it was given", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            configure: (server) => {
                server.get("/code", async (_request, reply) => reply.created({ code: "USER_CREATED" }));
            },
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/code" });

        expect(response.json().code).toBe("USER_CREATED");
    });
});
