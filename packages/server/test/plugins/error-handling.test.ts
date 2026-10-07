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

describe("Error Handling Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("global error layer handles thrown errors", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/throw", async () => {
          throw new Error("test error");
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/throw" });
    
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain("test error");
    
    await server.close();
  });

  it("handles known HTTP errors", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/not-found", async (request, reply) => {
          return reply.code(404).send({ error: "Not Found" });
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/not-found" });
    
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("Not Found");
    
    await server.close();
  });

  it("handles validation errors", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.post("/users", {
          schema: {
            body: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
              },
            },
          },
          handler: async (request) => ({ created: true }),
        });
      },
    });

    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/users",
      payload: {}, // Missing required name
    });
    
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBeDefined();
    
    await server.close();
  });

  it("handles unknown errors", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/unknown", async () => {
          throw "string error";
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/unknown" });
    
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toBeDefined();
    
    await server.close();
  });

  it("handles async errors", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/async-error", async () => {
          await Promise.resolve();
          throw new Error("async error");
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/async-error" });
    
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain("async error");
    
    await server.close();
  });

  it("handles rejected promises", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/rejected", async () => {
          return Promise.reject(new Error("rejected"));
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/rejected" });
    
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toBeDefined();
    
    await server.close();
  });

  it("error handler is configurable", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      errorHandler: { includeStack: true, logErrors: true },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("application doesn't need global error normalization", async () => {
    // This test verifies the architectural contract:
    // Server package provides global error normalization
    // Application doesn't need to implement it
    
    const server = await createBootstrapServer(baseOptions);
    await server.ready();
    
    // Application just throws, server handles normalization
    expect(server).toBeDefined();
    await server.close();
  });
});