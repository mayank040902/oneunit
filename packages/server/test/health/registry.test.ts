import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createBootstrapServer } from "../../src/bootstrap.js";
import { getHealthRegistry } from "../../src/health/index.js";

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

describe("Health registry", () => {
    it("runs the checks in parallel", async () => {
        const app = track(await createBootstrapServer(baseOptions));
        await app.ready();

        const registry = getHealthRegistry(app);
        for (const name of ["a", "b", "c", "d"]) {
            registry.register({
                name,
                check: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    return { status: "healthy" };
                },
                critical: false,
            });
        }

        const startedAt = Date.now();
        const results = await registry.checkAll();
        const duration = Date.now() - startedAt;

        // Four providers of 100 ms each: in parallel this is one round.
        expect(duration).toBeLessThan(300);
        expect(Object.keys(results)).toEqual(["a", "b", "c", "d"]);
    });

    it("reports a failing provider as unhealthy", async () => {
        const app = track(await createBootstrapServer(baseOptions));
        await app.ready();

        const registry = getHealthRegistry(app);
        registry.register({
            name: "broken",
            check: async () => {
                throw new Error("dependency down");
            },
            critical: true,
        });

        const results = await registry.checkAll();

        expect(results.broken.status).toBe("unhealthy");
        expect(results.broken.message).toBe("dependency down");
    });

    it("keeps the result of a provider that succeeds", async () => {
        const app = track(await createBootstrapServer(baseOptions));
        await app.ready();

        const registry = getHealthRegistry(app);
        registry.register({
            name: "healthy",
            check: async () => ({ status: "healthy", details: { latency: 1 } }),
            critical: false,
        });

        const results = await registry.checkAll();

        expect(results.healthy.status).toBe("healthy");
        expect(results.healthy.details).toEqual({ latency: 1 });
        expect(typeof results.healthy.latency).toBe("number");
    });
});
