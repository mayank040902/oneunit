import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createBootstrapServer } from "../../src/bootstrap.js";

const apps: FastifyInstance[] = [];

const baseOptions = {
    logger: false as const,
    kafka: false as const,
    realtime: false as const,
    database: false as const,
    redis: false as const,
    env: false as const,
    health: false as const,
};

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

function request(port: number, path: string, agent: http.Agent): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path, agent }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.end();
    });
}

describe("Bounded close", () => {
    it("finishes when a keep-alive client still holds the connection", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            configure: (server) => {
                server.get("/ping", async (_request, reply) => reply.ok());
            },
        }));
        await app.listen({ host: "127.0.0.1", port: 0 });
        const port = (app.server.address() as AddressInfo).port;

        const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
        try {
            // The socket is established and then goes idle, which is the state
            // that used to keep the close open forever.
            expect(await request(port, "/ping", agent)).toBe(200);

            const startedAt = Date.now();
            await app.close();
            const duration = Date.now() - startedAt;

            expect(duration).toBeLessThan(5_000);
            expect(app.server.listening).toBe(false);
        } finally {
            agent.destroy();
        }
    });

    it("finishes when a request was still running at the shutdown", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            configure: (server) => {
                server.get("/slow", async (_request, reply) => {
                    await new Promise((resolve) => setTimeout(resolve, 150));
                    return reply.ok();
                });
            },
        }));
        await app.listen({ host: "127.0.0.1", port: 0 });
        const port = (app.server.address() as AddressInfo).port;

        const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
        try {
            const inFlight = request(port, "/slow", agent);
            await new Promise((resolve) => setTimeout(resolve, 30));

            const startedAt = Date.now();
            await app.close();
            const duration = Date.now() - startedAt;

            expect(duration).toBeLessThan(5_000);
            // The request that was already running is still answered.
            expect(await inFlight).toBe(200);
        } finally {
            agent.destroy();
        }
    });

    it("drops the connections when the drain deadline passes", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            shutdownTimeout: 150,
            configure: (server) => {
                server.get("/hang", async () => {
                    // Never answered: the client is still holding the request.
                    await new Promise(() => {});
                });
            },
        }));
        await app.listen({ host: "127.0.0.1", port: 0 });
        const port = (app.server.address() as AddressInfo).port;

        const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
        try {
            const hanging = request(port, "/hang", agent).catch((error: Error) => error.code ?? "error");
            await new Promise((resolve) => setTimeout(resolve, 50));

            const startedAt = Date.now();
            await app.close();
            const duration = Date.now() - startedAt;

            expect(duration).toBeLessThan(3_000);
            expect(duration).toBeGreaterThanOrEqual(100);
            expect(await hanging).toBe("ECONNRESET");
        } finally {
            agent.destroy();
        }
    });

    it("still supports the callback form of close()", async () => {
        const app = track(await createBootstrapServer(baseOptions));
        await app.ready();

        const closed = await new Promise<boolean>((resolve) => {
            const result = app.close(() => resolve(true));
            expect(result).toBeUndefined();
        });

        expect(closed).toBe(true);
    });
});
