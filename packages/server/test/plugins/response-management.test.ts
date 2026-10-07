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

describe("Response Management Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("centralizes successful responses", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/success", async () => ({ data: "ok" }));
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/success" });
    
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toBe("ok");
    
    await server.close();
  });

  it("centralizes error responses", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/error", async () => {
          throw new Error("test error");
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/error" });
    
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toBeDefined();
    
    await server.close();
  });

  it("does not impose application-specific response schemas", async () => {
    // This test verifies the architectural contract:
    // Response management is centralized but doesn't enforce specific schemas
    // Application can return any JSON-serializable data
    
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/custom-response", async () => ({
          custom: "format",
          nested: { data: [1, 2, 3] },
        }));
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/custom-response" });
    
    expect(response.statusCode).toBe(200);
    expect(response.json().custom).toBe("format");
    expect(response.json().nested.data).toEqual([1, 2, 3]);
    
    await server.close();
  });

  it("handles different status codes", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/created", async (request, reply) => {
          return reply.code(201).send({ created: true });
        });
        app.get("/no-content", async (request, reply) => {
          return reply.code(204).send();
        });
      },
    });

    await server.ready();
    
    const created = await server.inject({ method: "GET", url: "/created" });
    expect(created.statusCode).toBe(201);
    
    const noContent = await server.inject({ method: "GET", url: "/no-content" });
    expect(noContent.statusCode).toBe(204);
    
    await server.close();
  });

  it("handles array responses", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/array", async () => [1, 2, 3]);
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/array" });
    
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([1, 2, 3]);
    
    await server.close();
  });

  it("handles string responses", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/string", async () => "plain text");
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/string" });
    
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("plain text");
    
    await server.close();
  });

  it("can be disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      responseManagement: false,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts custom configuration", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      responseManagement: true,
    });

    expect(server).toBeDefined();
    await server.close();
  });
});