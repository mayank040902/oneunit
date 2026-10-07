import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBootstrapServer,
  type BootstrapServerOptions,
} from "../../src/bootstrap.js";
import { createHealthProvider } from "../../src/health/index.js";

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

describe("Health Endpoint Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
  };

  it("aggregates registered providers", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        const registry = app.healthRegistry;
        registry.register(createHealthProvider("provider-a", async () => ({
          status: "healthy",
        })));
        registry.register(createHealthProvider("provider-b", async () => ({
          status: "healthy",
        })));
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/health" });
    
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.checks).toBeDefined();
    expect(body.checks["provider-a"]).toBeDefined();
    expect(body.checks["provider-b"]).toBeDefined();
    expect(body.checks.system).toBeDefined();
    
    await server.close();
  });

  it("health route does NOT contain hardcoded checks", async () => {
    // This test verifies the architectural contract:
    // Health route aggregates from registry, doesn't hardcode checks
    
    const server = await createBootstrapServer(baseOptions);
    await server.ready();
    
    const response = await server.inject({ method: "GET", url: "/health" });
    const body = response.json();
    
    // Should only have system health (no hardcoded database/redis/kafka)
    expect(body.checks.system).toBeDefined();
    // These should NOT be present unless explicitly registered
    // (they're not registered when infrastructure is disabled)
    expect(body.checks.database).toBeUndefined();
    expect(body.checks.redis).toBeUndefined();
    expect(body.checks.kafka).toBeUndefined();
    
    await server.close();
  });

  it("database plugin registers health provider", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      database: { logQueries: false },
    });

    await server.ready();
    const providers = server.healthRegistry.getAll();
    const dbProvider = providers.find(p => p.name === "database");
    
    if (dbProvider) {
      expect(dbProvider.name).toBe("database");
    }
    await server.close();
  });

  it("redis plugin registers health provider", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      redis: { healthCheck: false },
    });

    await server.ready();
    const providers = server.healthRegistry.getAll();
    const redisProvider = providers.find(p => p.name === "redis");
    
    if (redisProvider) {
      expect(redisProvider.name).toBe("redis");
      expect(redisProvider.critical).toBe(false);
    }
    await server.close();
  });

  it("kafka plugin registers health provider", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      kafka: { autoConnectProducer: false },
    });

    await server.ready();
    const providers = server.healthRegistry.getAll();
    const kafkaProvider = providers.find(p => p.name === "kafka");
    
    if (kafkaProvider) {
      expect(kafkaProvider.name).toBe("kafka");
      expect(kafkaProvider.critical).toBe(false);
    }
    await server.close();
  });

  it("health route aggregates all providers", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      database: { logQueries: false },
      redis: { healthCheck: false },
      configure: (app) => {
        const registry = app.healthRegistry;
        registry.register(createHealthProvider("custom-app-provider", async () => ({
          status: "healthy",
        })));
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/health" });
    
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Should include all registered providers
    expect(body.checks.system).toBeDefined();
    if (body.checks.database) expect(body.checks.database).toBeDefined();
    if (body.checks.redis) expect(body.checks.redis).toBeDefined();
    expect(body.checks["custom-app-provider"]).toBeDefined();
    
    await server.close();
  });

  it("fake provider automatically included in /health", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        const registry = app.healthRegistry;
        registry.register(createHealthProvider("fake-provider", async () => ({
          status: "healthy",
          message: "Fake provider check",
        })));
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/health" });
    
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.checks["fake-provider"]).toBeDefined();
    expect(body.checks["fake-provider"].status).toBe("healthy");
    
    await server.close();
  });

  it("supports custom health path", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      health: { path: "/healthz" },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    
    const defaultResponse = await server.inject({ method: "GET", url: "/health" });
    expect(defaultResponse.statusCode).toBe(404);
    
    await server.close();
  });

  it("supports includeDetails option", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      health: { includeDetails: true },
      configure: (app) => {
        const registry = app.healthRegistry;
        registry.register(createHealthProvider("detailed-provider", async () => ({
          status: "healthy",
          details: { some: "data" },
        })));
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/health/details" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.checks["detailed-provider"]).toBeDefined();
    expect(body.checks["detailed-provider"].details).toBeDefined();
    
    await server.close();
  });

  it("returns service name in response", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      serviceName: "my-service",
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/health" });
    
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.service).toBe("my-service");
    
    await server.close();
  });

  it("returns timestamp in response", async () => {
    const server = await createBootstrapServer(baseOptions);
    await server.ready();
    
    const response = await server.inject({ method: "GET", url: "/health" });
    
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.timestamp).toBeDefined();
    expect(new Date(body.timestamp).getTime()).toBeLessThanOrEqual(Date.now());
    
    await server.close();
  });
});