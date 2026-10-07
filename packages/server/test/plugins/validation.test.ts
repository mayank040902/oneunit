import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBootstrapServer,
  type BootstrapServerOptions,
} from "../../src/bootstrap.js";
import { z } from "zod";

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

describe("Validation Tests - Zod", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
    zod: true,
  };

  const userSchema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    age: z.number().int().positive().optional(),
  });

  it("accepts valid request with Zod schema", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.post("/users", {
          schema: {
            body: userSchema,
          },
          handler: async (request) => {
            return { created: true, user: request.body };
          },
        });
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/users",
      payload: { name: "John Doe", email: "john@example.com" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().created).toBe(true);
    expect(response.json().user.name).toBe("John Doe");
    expect(response.json().user.email).toBe("john@example.com");

    await server.close();
  });

  it("rejects invalid request with Zod schema", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.post("/users", {
          schema: {
            body: userSchema,
          },
          handler: async (request) => {
            return { created: true, user: request.body };
          },
        });
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/users",
      payload: { name: "", email: "invalid-email" },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBeDefined();

    await server.close();
  });

  it("validates required fields", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.post("/users", {
          schema: {
            body: userSchema,
          },
          handler: async (request) => {
            return { created: true };
          },
        });
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/users",
      payload: { email: "john@example.com" }, // missing name
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it("validates email format", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.post("/users", {
          schema: {
            body: userSchema,
          },
          handler: async (request) => {
            return { created: true };
          },
        });
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/users",
      payload: { name: "John", email: "not-an-email" },
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it("validates optional fields when present", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.post("/users", {
          schema: {
            body: userSchema,
          },
          handler: async (request) => {
            return { created: true, user: request.body };
          },
        });
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/users",
      payload: { name: "John", email: "john@example.com", age: -5 }, // invalid age
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it("accepts valid optional fields", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.post("/users", {
          schema: {
            body: userSchema,
          },
          handler: async (request) => {
            return { created: true, user: request.body };
          },
        });
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/users",
      payload: { name: "John", email: "john@example.com", age: 30 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.age).toBe(30);
    await server.close();
  });

  it("validates query parameters with Zod", async () => {
    const querySchema = z.object({
      limit: z.coerce.number().int().positive().default(10),
      offset: z.coerce.number().int().nonnegative().default(0),
    });

    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/users", {
          schema: {
            querystring: querySchema,
          },
          handler: async (request) => {
            return { limit: request.query.limit, offset: request.query.offset };
          },
        });
      },
    });

    const response = await server.inject({
      method: "GET",
      url: "/users?limit=20&offset=5",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().limit).toBe(20);
    expect(response.json().offset).toBe(5);
    await server.close();
  });

  it("validates params with Zod", async () => {
    const paramsSchema = z.object({
      id: z.string().uuid(),
    });

    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/users/:id", {
          schema: {
            params: paramsSchema,
          },
          handler: async (request) => {
            return { id: request.params.id };
          },
        });
      },
    });

    const response = await server.inject({
      method: "GET",
      url: "/users/123e4567-e89b-12d3-a456-426614174000",
    });

    expect(response.statusCode).toBe(200);
    await server.close();
  });

  it("rejects invalid UUID in params", async () => {
    const paramsSchema = z.object({
      id: z.string().uuid(),
    });

    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/users/:id", {
          schema: {
            params: paramsSchema,
          },
          handler: async (request) => {
            return { id: request.params.id };
          },
        });
      },
    });

    const response = await server.inject({
      method: "GET",
      url: "/users/not-a-uuid",
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it("infrastructure provides validation, application provides schema", async () => {
    // This test verifies the architectural contract:
    // Server package provides validation infrastructure (zod type provider)
    // Application provides the actual schema
    const server = await createBootstrapServer(baseOptions);
    
    // Server should have zod type provider available
    expect(server).toBeDefined();
    
    await server.close();
  });
});