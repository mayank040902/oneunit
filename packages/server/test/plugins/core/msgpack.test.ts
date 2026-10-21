import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createBootstrapServer } from "../../../src/bootstrap.js";

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

describe("Msgpack plugin", () => {
    it("answers a msgpack request with a decodable document", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            configure: (server) => {
                server.get("/ping", async (_request, reply) => reply.ok({ data: { id: 1 } }));
            },
        }));
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: "/ping",
            headers: { accept: "application/msgpack" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("application/msgpack");
        expect(Number(response.headers["content-length"])).toBe(response.rawPayload.length);

        const decoded = app.msgpack.decode(response.rawPayload) as {
            success: boolean;
            data: { id: number };
        };
        expect(decoded).toMatchObject({ success: true, data: { id: 1 } });
    });

    it("keeps the JSON answer for a JSON request", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            configure: (server) => {
                server.get("/ping", async (_request, reply) => reply.ok({ data: { id: 1 } }));
            },
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/ping" });

        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.json()).toMatchObject({ success: true, data: { id: 1 } });
    });

    it("honours a multi-value Accept header", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            configure: (server) => {
                server.get("/ping", async (_request, reply) => reply.ok());
            },
        }));
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: "/ping",
            headers: { accept: "application/json, application/msgpack" },
        });

        expect(response.headers["content-type"]).toContain("application/msgpack");
        const decoded = app.msgpack.decode(response.rawPayload) as { success: boolean };
        expect(decoded.success).toBe(true);
    });

    it("does not fail a bodyless answer", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            configure: (server) => {
                server.get("/empty", async (_request, reply) => reply.noContent());
            },
        }));
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: "/empty",
            headers: { accept: "application/msgpack" },
        });

        expect(response.statusCode).toBe(204);
        expect(response.rawPayload.length).toBe(0);
    });
});
