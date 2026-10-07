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

describe("Swagger UI Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("registers Swagger UI endpoint", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { openapi: { info: { title: "Test API", version: "1.0.0" } } },
      swaggerUI: { routePrefix: "/docs" },
    });

    await server.ready();

    const response = await server.inject({ method: "GET", url: "/docs" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Swagger UI");

    await server.close();
  });

  it("uses default route prefix when not specified", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { openapi: { info: { title: "Test API", version: "1.0.0" } } },
      swaggerUI: true,
    });

    await server.ready();

    const response = await server.inject({ method: "GET", url: "/documentation" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");

    await server.close();
  });

  it("supports configurable route prefixes", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { openapi: { info: { title: "Test API", version: "1.0.0" } } },
      swaggerUI: { routePrefix: "/api-docs" },
    });

    await server.ready();

    const response = await server.inject({ method: "GET", url: "/api-docs" });
    expect(response.statusCode).toBe(200);

    await server.close();
  });

  it("supports custom UI configuration", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { openapi: { info: { title: "Test API", version: "1.0.0" } } },
      swaggerUI: { 
        routePrefix: "/custom-docs",
        uiConfig: {
          docExpansion: "list",
          deepLinking: true,
          defaultModelsExpandDepth: 2,
        },
      },
    });

    await server.ready();

    const response = await server.inject({ method: "GET", url: "/custom-docs" });
    expect(response.statusCode).toBe(200);

    await server.close();
  });

  it("does not expose endpoint when disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { openapi: { info: { title: "Test API", version: "1.0.0" } } },
      swaggerUI: false,
    });

    await server.ready();

    const response = await server.inject({ method: "GET", url: "/documentation" });
    expect(response.statusCode).toBe(404);

    await server.close();
  });

  it("requires swagger to be enabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: false,
      swaggerUI: { routePrefix: "/docs" },
    });

    await server.ready();

    // Without swagger, swaggerUI should not be available
    const response = await server.inject({ method: "GET", url: "/docs" });
    expect(response.statusCode).toBe(404);

    await server.close();
  });

  it("can be enabled with boolean true", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: true,
      swaggerUI: true,
    });

    await server.ready();

    const response = await server.inject({ method: "GET", url: "/documentation" });
    expect(response.statusCode).toBe(200);

    await server.close();
  });
});