import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createBootstrapServer } from "../../src/bootstrap.js";

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
};

describe("Health details", () => {
    it("keeps the identity and the network topology out of the health payload", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: { includeDetails: true },
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/health" });
        expect(response.statusCode).toBe(200);

        const system = response.json().checks.system as {
            status: string;
            details: Record<string, unknown>;
        };

        expect(system.status).toBeTypeOf("string");
        // The diagnostics stay available.
        expect(system.details.memory).toBeDefined();
        expect(system.details.cpu).toBeDefined();
        // The account and the addresses of the host do not.
        expect(system.details.user).toBeUndefined();
        expect(system.details.network).toBeUndefined();
    });

    it("keeps the identity out of the details route as well", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            health: { includeDetails: true },
        }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/health/details" });
        expect(response.statusCode).toBe(200);

        const system = response.json().checks.system as {
            details: Record<string, unknown>;
        };

        expect(system.details.user).toBeUndefined();
        expect(system.details.network).toBeUndefined();
    });

    it("does not expose the details at all by default", async () => {
        const app = track(await createBootstrapServer({ ...baseOptions, health: true }));
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/health" });
        expect(response.statusCode).toBe(200);

        const system = response.json().checks.system as Record<string, unknown>;
        expect(system.details).toBeUndefined();
        expect(Object.keys(system)).toEqual(["status"]);
    });
});
