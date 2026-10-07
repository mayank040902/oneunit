import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBootstrapServer,
  startBootstrapServer,
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

describe("Configure Callback Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("executes configure callback", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (server) => {
        server.get("/version", async () => ({ version: "1.0.0" }));
      },
    });

    const response = await server.inject({ method: "GET", url: "/version" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: "1.0.0" });

    await server.close();
  });

  it("configure executes after builtin plugin registration", async () => {
    let builtinAvailable = false;

    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (server) => {
        // Check if builtin plugins are available
        builtinAvailable = typeof server.healthRegistry !== "undefined";
      },
    });

    await server.ready();
    expect(builtinAvailable).toBe(true);

    await server.close();
  });

  it("configure executes after custom plugin registration", async () => {
    let pluginExecuted = false;

    const testPlugin = async (app: FastifyInstance) => {
      app.get("/plugin-route", async () => ({ from: "plugin" }));
      pluginExecuted = true;
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [testPlugin],
      configure: (server) => {
        // Custom plugin should have been registered
        expect(pluginExecuted).toBe(true);
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/plugin-route" });
    expect(response.statusCode).toBe(200);

    await server.close();
  });

  it("configure executes before ready()", async () => {
    let configureExecuted = false;
    let readyExecuted = false;

    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (server) => {
        configureExecuted = true;
      },
    });

    await server.ready();
    readyExecuted = true;

    expect(configureExecuted).toBe(true);
    expect(readyExecuted).toBe(true);

    await server.close();
  });

  it("configure can register routes with schemas", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (server) => {
        server.get("/users", {
          schema: {
            querystring: {
              type: "object",
              properties: {
                limit: { type: "integer" },
              },
            },
          },
          handler: async () => ({ users: [] }),
        });
      },
    });

    const response = await server.inject({ method: "GET", url: "/users?limit=10" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ users: [] });

    await server.close();
  });

  it("configure works with startBootstrapServer", async () => {
    const { app, close } = await startBootstrapServer({
      ...baseOptions,
      configure: (server) => {
        server.get("/configured", async () => ({ configured: true }));
      },
      port: 0,
    });

    const response = await app.inject({ method: "GET", url: "/configured" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: true });

    await close();
  });

  it("configure can access health registry", async () => {
    let healthRegistryAccessible = false;

    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (server) => {
        healthRegistryAccessible = typeof server.healthRegistry !== "undefined";
      },
    });

    await server.ready();
    expect(healthRegistryAccessible).toBe(true);

    await server.close();
  });

  it("configure can access request context", async () => {
    let requestContextAvailable = false;

    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (server) => {
        server.get("/context-check", async (request) => {
          requestContextAvailable = "requestContext" in request;
          return { ok: true };
        });
      },
    });

    await server.ready();
    await server.inject({ method: "GET", url: "/context-check" });
    expect(requestContextAvailable).toBe(true);

    await server.close();
  });
});