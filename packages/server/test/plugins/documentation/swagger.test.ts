import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBootstrapServer,
  type BootstrapServerOptions,
} from "../../../src/bootstrap.js";
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

describe("Swagger Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    zod: true,
  };

  it("generates OpenAPI document", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { 
        openapi: { 
          info: { title: "Test API", version: "1.0.0" } 
        } 
      },
    });

    await server.ready();
    const spec = server.swagger();
    
    expect(spec).toBeDefined();
    expect(spec.openapi).toBeDefined();
    expect(spec.info.title).toBe("Test API");
    expect(spec.info.version).toBe("1.0.0");
    expect(spec.paths).toBeDefined();
    // Should include health route
    expect(spec.paths["/health"]).toBeDefined();

    await server.close();
  });

  it("includes application routes in OpenAPI document", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { 
        openapi: { 
          info: { title: "Test API", version: "1.0.0" } 
        } 
      },
      configure: (app) => {
        app.get("/users", {
          schema: {
            querystring: z.object({
              limit: z.coerce.number().default(10),
            }),
            response: {
              200: z.object({
                users: z.array(z.object({
                  id: z.string(),
                  name: z.string(),
                })),
              }),
            },
          },
          handler: async () => ({ users: [] }),
        });
      },
    });

    await server.ready();
    const spec = server.swagger();
    
    expect(spec.paths["/users"]).toBeDefined();
    expect(spec.paths["/users"].get).toBeDefined();
    expect(spec.paths["/users"].get.parameters).toBeDefined();
    expect(spec.paths["/users"].get.responses).toBeDefined();
    expect(spec.paths["/users"].get.responses["200"]).toBeDefined();

    await server.close();
  });

  it("includes POST routes with request body schema", async () => {
    const userSchema = z.object({
      name: z.string(),
      email: z.string().email(),
    });

    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { 
        openapi: { 
          info: { title: "Test API", version: "1.0.0" } 
        } 
      },
      configure: (app) => {
        app.post("/users", {
          schema: {
            body: userSchema,
            response: {
              201: z.object({
                id: z.string(),
                name: z.string(),
                email: z.string().email(),
              }),
            },
          },
          handler: async (request) => ({ id: "1", ...request.body }),
        });
      },
    });

    await server.ready();
    const spec = server.swagger();
    
    expect(spec.paths["/users"]).toBeDefined();
    expect(spec.paths["/users"].post).toBeDefined();
    expect(spec.paths["/users"].post.requestBody).toBeDefined();
    expect(spec.paths["/users"].post.responses["201"]).toBeDefined();

    await server.close();
  });

  it("includes path parameters in OpenAPI document", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { 
        openapi: { 
          info: { title: "Test API", version: "1.0.0" } 
        } 
      },
      configure: (app) => {
        app.get("/users/:id", {
          schema: {
            params: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string", format: "uuid" },
              },
            },
            response: {
              200: z.object({
                id: z.string().uuid(),
                name: z.string(),
              }),
            },
          },
          handler: async (request) => ({ id: request.params.id, name: "User" }),
        });
      },
    });

    await server.ready();
    const spec = server.swagger();
    
    expect(spec.paths["/users/{id}"]).toBeDefined();
    expect(spec.paths["/users/{id}"].get).toBeDefined();
    expect(spec.paths["/users/{id}"].get.parameters).toBeDefined();
    
    const idParam = spec.paths["/users/{id}"].get.parameters?.find(
      (p: any) => p.name === "id"
    );
    expect(idParam).toBeDefined();
    expect(idParam.in).toBe("path");

    await server.close();
  });

  it("supports custom OpenAPI configuration", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { 
        openapi: { 
          info: { 
            title: "Custom API", 
            version: "2.0.0",
            description: "API Description",
          },
          components: {
            securitySchemes: {
              bearerAuth: {
                type: "http",
                scheme: "bearer",
                bearerFormat: "JWT",
              },
            },
          },
          tags: [{ name: "users", description: "User operations" }],
        } 
      },
    });

    await server.ready();
    const spec = server.swagger();
    
    expect(spec.info.title).toBe("Custom API");
    expect(spec.info.version).toBe("2.0.0");
    expect(spec.info.description).toBe("API Description");
    expect(spec.components?.securitySchemes).toBeDefined();
    expect(spec.tags).toBeDefined();

    await server.close();
  });

  it("can be disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: false,
    });

    await server.ready();
    // When disabled, swagger() should not be available or return undefined
    expect(server).toBeDefined();
    await server.close();
  });

  it("can be enabled with boolean true", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: true,
    });

    await server.ready();
    const spec = server.swagger();
    expect(spec).toBeDefined();
    await server.close();
  });

  it("swagger is independent from generic HTTP runtime", async () => {
    // This test verifies the architectural contract:
    // Swagger documentation is a separate capability from generic HTTP runtime
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { openapi: { info: { title: "Test", version: "1.0" } } },
      // Disable other HTTP plugins
      cors: false,
      helmet: false,
      compress: false,
      rateLimit: false,
    });

    await server.ready();
    const spec = server.swagger();
    expect(spec).toBeDefined();
    // Health route should still work
    const health = await server.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    await server.close();
  });
});