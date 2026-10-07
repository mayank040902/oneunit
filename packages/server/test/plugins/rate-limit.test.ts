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

describe("Rate Limit Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("enforces rate limit with small limit", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      rateLimit: { max: 2, timeWindow: "1 minute" },
      configure: (app) => {
        app.get("/limited", async () => ({ ok: true }));
      },
    });

    await server.ready();

    // Request 1 - should be accepted
    const response1 = await server.inject({ method: "GET", url: "/limited" });
    expect(response1.statusCode).toBe(200);

    // Request 2 - should be accepted
    const response2 = await server.inject({ method: "GET", url: "/limited" });
    expect(response2.statusCode).toBe(200);

    // Request 3 - should be rate limited
    const response3 = await server.inject({ method: "GET", url: "/limited" });
    expect(response3.statusCode).toBe(429);

    await server.close();
  });

  it("rate limit is per route by default", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      rateLimit: { max: 1, timeWindow: "1 minute" },
      configure: (app) => {
        app.get("/route-a", async () => ({ route: "a" }));
        app.get("/route-b", async () => ({ route: "b" }));
      },
    });

    await server.ready();

    // First request to route-a
    await server.inject({ method: "GET", url: "/route-a" });
    
    // Second request to route-a should be limited
    const responseA = await server.inject({ method: "GET", url: "/route-a" });
    expect(responseA.statusCode).toBe(429);

    // First request to route-b should work
    const responseB = await server.inject({ method: "GET", url: "/route-b" });
    expect(responseB.statusCode).toBe(200);

    await server.close();
  });

  it("rate limit headers are present", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      rateLimit: { max: 5, timeWindow: "1 minute" },
      configure: (app) => {
        app.get("/headers", async () => ({ ok: true }));
      },
    });

    await server.ready();

    const response = await server.inject({ method: "GET", url: "/headers" });
    
    expect(response.headers["x-ratelimit-limit"]).toBeDefined();
    expect(response.headers["x-ratelimit-remaining"]).toBeDefined();
    
    await server.close();
  });

  it("can be disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      rateLimit: false,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts custom configuration", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      rateLimit: { 
        max: 100, 
        timeWindow: "1 minute",
        keyGenerator: (request) => request.ip,
      },
      configure: (app) => {
        app.get("/custom", async () => ({ ok: true }));
      },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("does not confuse with application-specific quotas", async () => {
    // This test verifies the architectural contract:
    // Rate limiting is infrastructure-level request rate limiting
    // NOT application-specific quotas (which should be implemented by the application)
    
    const server = await createBootstrapServer({
      ...baseOptions,
      rateLimit: { max: 10, timeWindow: "1 minute" },
      configure: (app) => {
        app.get("/api/resource", async () => ({ resource: "data" }));
      },
    });

    await server.ready();

    // Make requests up to limit
    for (let i = 0; i < 10; i++) {
      const response = await server.inject({ method: "GET", url: "/api/resource" });
      expect(response.statusCode).toBe(200);
    }

    // Next request should be rate limited (infrastructure protection)
    const response = await server.inject({ method: "GET", url: "/api/resource" });
    expect(response.statusCode).toBe(429);

    await server.close();
  });

  it("accepts boolean true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      rateLimit: true,
    });

    expect(server).toBeDefined();
    await server.close();
  });
});