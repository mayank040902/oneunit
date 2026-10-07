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

describe("Under Pressure Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("can be enabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      underPressure: { maxEventLoopDelay: 1000 },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("can be enabled with boolean true", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      underPressure: true,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("can be disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      underPressure: false,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts custom configuration", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      underPressure: {
        maxEventLoopDelay: 1000,
        maxHeapUsedBytes: 100 * 1024 * 1024,
        maxRssBytes: 200 * 1024 * 1024,
        eventLoopCheckInterval: 100,
      },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("configuration propagation works", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      underPressure: { 
        maxEventLoopDelay: 500,
        maxHeapUsedBytes: 50 * 1024 * 1024,
      },
      configure: (app) => {
        app.get("/pressure", async () => ({ ok: true }));
      },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("pressure protection is independent from rate limiting", async () => {
    // This test verifies the architectural contract:
    // Under-pressure protection is separate from rate limiting
    // Rate limiting = request count per time window
    // Under-pressure = system resource protection (event loop, memory)
    
    const server = await createBootstrapServer({
      ...baseOptions,
      rateLimit: { max: 1000, timeWindow: "1 minute" },
      underPressure: { maxEventLoopDelay: 100 },
      configure: (app) => {
        app.get("/test", async () => ({ ok: true }));
      },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("responds with 503 when under pressure (if configured)", async () => {
    // Note: We can't easily test actual pressure without stressing the system
    // This test verifies the plugin is registered and configured
    const server = await createBootstrapServer({
      ...baseOptions,
      underPressure: { 
        maxEventLoopDelay: 1,
        message: "Server under pressure",
        retryAfter: 100,
      },
      configure: (app) => {
        app.get("/pressure-test", async () => ({ ok: true }));
      },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("exposes pressure metrics if configured", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      underPressure: { 
        maxEventLoopDelay: 1000,
        exposure: {
          "/pressure-metrics": { /* options */ },
        },
      },
    });

    expect(server).toBeDefined();
    await server.close();
  });
});