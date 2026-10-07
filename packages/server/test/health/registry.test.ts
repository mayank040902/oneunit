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

describe("Health Registry Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
  };

  it("registers custom health provider", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        const registry = app.healthRegistry;
        registry.register(createHealthProvider("custom-provider", async () => ({
          status: "healthy",
        })));
      },
    });

    await server.ready();
    const providers = server.healthRegistry.getAll();
    const customProvider = providers.find(p => p.name === "custom-provider");
    
    expect(customProvider).toBeDefined();
    expect(customProvider?.name).toBe("custom-provider");
    
    await server.close();
  });

  it("all healthy → healthy", async () => {
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
    expect(body.status).toBe("healthy");
    
    await server.close();
  });

  it("healthy + degraded → degraded", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        const registry = app.healthRegistry;
        registry.register(createHealthProvider("provider-a", async () => ({
          status: "healthy",
        })));
        registry.register(createHealthProvider("provider-b", async () => ({
          status: "degraded",
        })));
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/health" });
    
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("degraded");
    
    await server.close();
  });

  it("healthy + unhealthy → unhealthy (non-critical)", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        const registry = app.healthRegistry;
        registry.register(createHealthProvider("provider-a", async () => ({
          status: "healthy",
        })));
        registry.register(createHealthProvider("provider-b", async () => ({
          status: "unhealthy",
        }), false)); // non-critical
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/health" });
    
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("unhealthy");
    
    await server.close();
  });

  it("critical unhealthy → 503", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        const registry = app.healthRegistry;
        registry.register(createHealthProvider("critical-provider", async () => ({
          status: "unhealthy",
        }), true)); // critical
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/health" });
    
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("unhealthy");
    
    await server.close();
  });

  it("provider failure does not crash server", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        const registry = app.healthRegistry;
        registry.register(createHealthProvider("failing-provider", async () => {
          throw new Error("Health check failed");
        }));
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/health" });
    
    // Should still respond, not crash
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.checks["failing-provider"]).toBeDefined();
    expect(body.checks["failing-provider"].status).toBe("unhealthy");
    
    await server.close();
  });

  it("unregister removes provider", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        const registry = app.healthRegistry;
        registry.register(createHealthProvider("temp-provider", async () => ({
          status: "healthy",
        })));
        
        expect(registry.getAll().find(p => p.name === "temp-provider")).toBeDefined();
        
        registry.unregister("temp-provider");
        expect(registry.getAll().find(p => p.name === "temp-provider")).toBeUndefined();
      },
    });

    await server.ready();
    await server.close();
  });

  it("getAll returns all registered providers", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        const registry = app.healthRegistry;
        registry.register(createHealthProvider("provider-1", async () => ({ status: "healthy" })));
        registry.register(createHealthProvider("provider-2", async () => ({ status: "healthy" })));
      },
    });

    await server.ready();
    const providers = server.healthRegistry.getAll();
    const names = providers.map(p => p.name).sort();
    
    expect(names).toContain("provider-1");
    expect(names).toContain("provider-2");
    expect(names).toContain("system"); // Always present
    
    await server.close();
  });

  it("checkAll returns results for all providers", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        const registry = app.healthRegistry;
        registry.register(createHealthProvider("provider-a", async () => ({
          status: "healthy",
        })));
        registry.register(createHealthProvider("provider-b", async () => ({
          status: "degraded",
        })));
      },
    });

    await server.ready();
    const results = await server.healthRegistry.checkAll();
    
    expect(results["provider-a"]).toBeDefined();
    expect(results["provider-a"].status).toBe("healthy");
    expect(results["provider-b"]).toBeDefined();
    expect(results["provider-b"].status).toBe("degraded");
    expect(results["system"]).toBeDefined();
    
    await server.close();
  });

  it("checkAll includes latency", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        const registry = app.healthRegistry;
        registry.register(createHealthProvider("timed-provider", async () => {
          await new Promise(r => setTimeout(r, 10));
          return { status: "healthy" };
        }));
      },
    });

    await server.ready();
    const results = await server.healthRegistry.checkAll();
    
    expect(results["timed-provider"].latency).toBeGreaterThan(0);
    
    await server.close();
  });
});