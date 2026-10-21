import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import errorHandlerPlugin from "../../../src/plugins/core/errors.js";

const apps: Fastify[] = [];

afterEach(async () => {
    vi.resetModules();
    vi.doUnmock("@oneunit/errors/fastify");
    for (const app of apps.splice(0)) {
        try {
            await app.close();
        } catch {
            // ignore close errors
        }
    }
});

describe("Error handler plugin", () => {
    it("keeps working when the errors package is installed", async () => {
        const app = Fastify();
        apps.push(app);

        await app.register(errorHandlerPlugin);

        app.get("/boom", async () => {
            throw new Error("boom");
        });
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/boom" });
        expect(response.statusCode).toBe(500);
        expect(response.json().error).toBeDefined();
    });

    it("does not hide a failure that happens while the handler is registered", async () => {
        vi.doMock("@oneunit/errors/fastify", () => ({
            default: async () => {
                throw new Error("registration failed");
            },
        }));

        const app = Fastify();
        apps.push(app);

        await expect(app.register(errorHandlerPlugin)).rejects.toThrow("registration failed");
    });

    it("falls back to the Fastify handler when the package is missing", async () => {
        vi.doMock("@oneunit/errors/fastify", () => {
            const error = new Error("Cannot find package '@oneunit/errors/fastify'");
            (error as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
            throw error;
        });

        const app = Fastify();
        apps.push(app);

        await app.register(errorHandlerPlugin);
        app.get("/boom", async () => {
            throw new Error("boom");
        });
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/boom" });
        expect(response.statusCode).toBe(500);
        // Fastify's own shape, not the errors package one.
        expect(response.json().message).toBe("boom");
    });
});
