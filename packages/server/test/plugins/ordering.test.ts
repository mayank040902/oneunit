import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBootstrapServer,
  type BootstrapServerOptions,
} from "../../src/bootstrap.js";

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

describe("Plugin Ordering", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("health registry exists before infrastructure plugins register providers", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      database: { logQueries: false },
      redis: { healthCheck: false },
    });

    expect(server.healthRegistry).toBeDefined();
    const providers = server.healthRegistry.getAll();
    const dbProvider = providers.find(p => p.name === "database");
    const redisProvider = providers.find(p => p.name === "redis");

    expect(dbProvider).toBeDefined();
    expect(redisProvider).toBeDefined();

    await server.close();
  });

  it("request-context is available before application plugins", async () => {
    let requestContextAvailable = false;

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [
        async (app) => {
          app.get("/test-context", async (request) => {
            // @fastify/request-context adds requestContext as an object with get/set methods
            requestContextAvailable = "requestContext" in request && typeof request.requestContext === "object";
            return { ok: true };
          });
        },
      ],
    });

    await server.ready();
    await server.inject({ method: "GET", url: "/test-context" });
    expect(requestContextAvailable).toBe(true);

    await server.close();
  });

  it("swagger is registered before application routes are finalized", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { openapi: { info: { title: "Test", version: "1.0" } } },
      plugins: [
        async (app) => {
          app.get("/test", async () => ({ ok: true }));
        },
      ],
    });

    await server.ready();
    const spec = server.swagger();
    expect(spec).toBeDefined();
    expect(spec.paths["/test"]).toBeDefined();

    await server.close();
  });

  it("error handler is registered before application plugins", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [
        async (app) => {
          app.get("/error", async () => {
            throw new Error("test error");
          });
        },
      ],
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/error" });
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toBeDefined();

    await server.close();
  });
});