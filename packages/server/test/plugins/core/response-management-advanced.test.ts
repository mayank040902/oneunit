import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
    createBootstrapServer,
    type BootstrapServerOptions,
} from "../../../src/bootstrap.js";

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

const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
};

type RouteRegistrar = (app: FastifyInstance) => void;

async function bootstrap(
    routes: RouteRegistrar,
    options: Partial<BootstrapServerOptions> = {},
): Promise<FastifyInstance> {
    const server = track(
        await createBootstrapServer({
            ...baseOptions,
            ...options,
            configure: (app) => {
                routes(app);
            },
        }),
    );
    await server.ready();
    return server;
}

describe("Response Management — advanced", () => {
    it("uses the same envelope members for a success and a failure", async () => {
        const server = await bootstrap((app) => {
            app.get("/ok", async (_req, reply) => reply.ok({ data: { id: 1 } }));
            app.get("/bad", async (_req, reply) => reply.badRequest());
        });

        const success = (await server.inject({ method: "GET", url: "/ok" })).json();
        const failure = (await server.inject({ method: "GET", url: "/bad" })).json();

        for (const member of ["success", "code", "msg", "metadata"]) {
            expect(success, member).toHaveProperty(member);
            expect(failure, member).toHaveProperty(member);
        }
        expect(success.success).toBe(true);
        expect(failure.success).toBe(false);
    });

    it("passes the data payload through untouched", async () => {
        const payload = {
            id: 1,
            nested: { tags: ["a", "b"], count: 2 },
            flag: false,
            empty: null,
        };

        const server = await bootstrap((app) => {
            app.get("/echo", async (_req, reply) => reply.success({ data: payload }));
        });

        const response = await server.inject({ method: "GET", url: "/echo" });

        expect(response.json().data).toEqual(payload);
    });

    it("produces the same envelope through respond() and the named helpers", async () => {
        const server = await bootstrap((app) => {
            app.get("/helper", async (_req, reply) => reply.ok());
            app.get("/respond", async (_req, reply) => reply.respond({ status: 200 }));
        });

        const helper = (await server.inject({ method: "GET", url: "/helper" })).json();
        const respond = (await server.inject({ method: "GET", url: "/respond" })).json();

        expect(Object.keys(respond).sort()).toEqual(Object.keys(helper).sort());
        expect(respond.success).toBe(true);
        expect(respond.code).toBe("200");
        expect(respond.msg).toBe("Success");
    });

    it("keeps the request id of the request that produced the envelope", async () => {
        const server = await bootstrap((app) => {
            app.get("/ok", async (_req, reply) => reply.ok());
        });

        const first = (await server.inject({ method: "GET", url: "/ok" })).json();
        const second = (await server.inject({ method: "GET", url: "/ok" })).json();

        expect(first.metadata.requestId).toBeTypeOf("string");
        expect(second.metadata.requestId).toBeTypeOf("string");
        expect(first.metadata.requestId).not.toBe(second.metadata.requestId);
    });

    it("does not wrap the health route", async () => {
        const server = await bootstrap(
            (app) => {
                app.get("/ok", async (_req, reply) => reply.ok());
            },
            { health: true },
        );

        const response = await server.inject({ method: "GET", url: "/health" });

        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBeTypeOf("string");
        expect(response.json().success).toBeUndefined();
    });

    it("leaves an unmatched route to the error handler", async () => {
        const server = await bootstrap((app) => {
            app.get("/ok", async (_req, reply) => reply.ok());
        });

        const response = await server.inject({ method: "GET", url: "/nope" });

        expect(response.statusCode).toBe(404);
        expect(response.json().error).toBeDefined();
    });

    it("leaves a schema validation failure to the error handler", async () => {
        const server = await bootstrap((app) => {
            app.post(
                "/users",
                { schema: { body: z.object({ email: z.string().email() }) } },
                async (_req, reply) => reply.created(),
            );
        });

        const response = await server.inject({
            method: "POST",
            url: "/users",
            payload: { email: "not-an-email" },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error).toBeDefined();
    });
});
