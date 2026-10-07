import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBootstrapServer,
  startBootstrapServer,
  type BootstrapServerOptions,
  type PluginEntry,
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

describe("Application Plugin Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("registers application plugin routes", async () => {
    const testPlugin = async (app: FastifyInstance) => {
      app.get("/test", async () => ({ message: "ok" }));
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [testPlugin],
    });

    const response = await server.inject({ method: "GET", url: "/test" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: "ok" });

    await server.close();
  });

  it("registers application plugin with options", async () => {
    const testPlugin = async (app: FastifyInstance, options: { prefix: string }) => {
      app.get(options.prefix, async () => ({ value: options.prefix }));
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [{ plugin: testPlugin, options: { prefix: "/custom" } }],
    });

    const response = await server.inject({ method: "GET", url: "/custom" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ value: "/custom" });

    await server.close();
  });

  it("application plugin executes after builtin plugins", async () => {
    let pluginExecuted = false;
    let builtinAvailable = false;

    const testPlugin = async (app: FastifyInstance) => {
      // Check if builtin plugins are available
      builtinAvailable = typeof app.healthRegistry !== "undefined";
      pluginExecuted = true;
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [testPlugin],
    });

    await server.ready();
    expect(builtinAvailable).toBe(true);
    expect(pluginExecuted).toBe(true);

    await server.close();
  });

  it("application plugin can decorate Fastify", async () => {
    const testPlugin = async (app: FastifyInstance) => {
      app.decorate("customDecorator", { value: "decorated" });
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [testPlugin],
    });

    expect(server.customDecorator).toEqual({ value: "decorated" });
    await server.close();
  });

  it("application plugin can register hooks", async () => {
    const testPlugin = async (app: FastifyInstance) => {
      app.addHook("onRequest", async (request) => {
        request.headers["x-custom-hook"] = "test";
      });
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [testPlugin],
      configure: (app) => {
        app.get("/hook-test", async (request) => ({
          hooked: request.headers["x-custom-hook"] === "test",
        }));
      },
    });

    const response = await server.inject({ method: "GET", url: "/hook-test" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ hooked: true });

    await server.close();
  });

  it("application plugin can register application-specific behavior", async () => {
    const testPlugin = async (app: FastifyInstance) => {
      app.get("/users/:id", async (request) => {
        return { id: request.params.id, name: "Test User" };
      });
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [testPlugin],
    });

    const response = await server.inject({ method: "GET", url: "/users/123" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "123", name: "Test User" });

    await server.close();
  });

  it("multiple application plugins work together", async () => {
    const pluginA = async (app: FastifyInstance) => {
      app.get("/plugin-a", async () => ({ plugin: "a" }));
    };

    const pluginB = async (app: FastifyInstance) => {
      app.get("/plugin-b", async () => ({ plugin: "b" }));
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [pluginA, pluginB],
    });

    const responseA = await server.inject({ method: "GET", url: "/plugin-a" });
    expect(responseA.statusCode).toBe(200);
    expect(responseA.json()).toEqual({ plugin: "a" });

    const responseB = await server.inject({ method: "GET", url: "/plugin-b" });
    expect(responseB.statusCode).toBe(200);
    expect(responseB.json()).toEqual({ plugin: "b" });

    await server.close();
  });

  it("application plugins work with startBootstrapServer", async () => {
    const testPlugin = async (app: FastifyInstance) => {
      app.get("/started", async () => ({ started: true }));
    };

    const { app, close } = await startBootstrapServer({
      ...baseOptions,
      plugins: [testPlugin],
      port: 0,
    });

    const response = await app.inject({ method: "GET", url: "/started" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ started: true });

    await close();
  });

  it("application plugins receive request context", async () => {
    let requestContextAvailable = false;

    const testPlugin = async (app: FastifyInstance) => {
      app.get("/context-test", async (request) => {
        requestContextAvailable = "requestContext" in request;
        return { ok: true };
      });
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [testPlugin],
    });

    await server.ready();
    await server.inject({ method: "GET", url: "/context-test" });
    expect(requestContextAvailable).toBe(true);

    await server.close();
  });
});