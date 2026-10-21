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
    kafka: false as const,
    realtime: false as const,
    database: false as const,
    redis: false as const,
    env: false as const,
    health: false as const,
};

describe("Logger plugin", () => {
    it("keeps the caller's child bindings next to the service name", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            logger: {
                serviceName: "checkout",
                childBindings: { region: "eu-west-1", tenant: "acme" },
            },
        }));
        await app.ready();

        const bindings = (app.logger as unknown as { bindings(): Record<string, unknown> }).bindings();

        expect(bindings.service).toBe("checkout");
        expect(bindings.region).toBe("eu-west-1");
        expect(bindings.tenant).toBe("acme");
    });

    it("keeps the service name when no child bindings are given", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            logger: { serviceName: "billing" },
        }));
        await app.ready();

        const bindings = (app.logger as unknown as { bindings(): Record<string, unknown> }).bindings();

        expect(bindings.service).toBe("billing");
    });

    it("keeps the child bindings when no service name is given", async () => {
        const app = track(await createBootstrapServer({
            ...baseOptions,
            logger: { childBindings: { region: "us-east-1" } },
        }));
        await app.ready();

        const bindings = (app.logger as unknown as { bindings(): Record<string, unknown> }).bindings();

        expect(bindings.region).toBe("us-east-1");
    });
});
