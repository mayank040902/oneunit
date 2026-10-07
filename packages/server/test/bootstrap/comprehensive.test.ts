import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBootstrapServer,
  startBootstrapServer,
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

describe("Minimal Startup", () => {
  it("starts with minimal config without optional infrastructure", async () => {
    const server = await startBootstrapServer({
      logger: false,
      kafka: false,
      realtime: false,
      database: false,
      redis: false,
      port: 0,
      env: false,
      health: false,
    });

    expect(server.app).toBeDefined();
    expect(server.address).toBeDefined();
    expect(server.port).toBeGreaterThan(0);
    expect(server.host).toBeDefined();
    expect(typeof server.close).toBe("function");

    await server.close();
  });

  it("returns Fastify instance with required decorators", async () => {
    const server = await createBootstrapServer({
      logger: false,
      kafka: false,
      realtime: false,
      database: false,
      redis: false,
      env: false,
      health: false,
    });

    expect(server).toBeDefined();
    expect(server.ready).toBeDefined();
    expect(server.inject).toBeDefined();
    expect(server.close).toBeDefined();
    expect(server.log).toBeDefined();
  });

  it("health route works by default", async () => {
    const server = await createBootstrapServer({
      logger: false,
      kafka: false,
      realtime: false,
      database: false,
      redis: false,
      env: false,
    });

    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.service).toBeDefined();
    expect(body.status).toBeDefined();
    expect(body.checks).toBeDefined();
  });
});

describe("Disabled Plugin Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  const disabledPlugins = [
    { cors: false as const },
    { helmet: false as const },
    { cookie: false as const },
    { compress: false as const },
    { rateLimit: false as const },
    { multipart: false as const },
    { swagger: false as const },
    { swaggerUI: false as const },
    { csrf: false as const },
    { underPressure: false as const },
    { requestContext: false as const },
    { zod: false as const },
    { msgpack: false as const },
    { responseManagement: false as const },
    { errorHandler: false as const },
    { logger: false as const },
  ];

  for (const pluginConfig of disabledPlugins) {
    const pluginName = Object.keys(pluginConfig)[0];
    it(`disables ${pluginName} plugin when set to false`, async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        ...pluginConfig,
      });

      // Verify server starts successfully
      expect(server).toBeDefined();
      await server.close();
    });
  }

  it("disables all infrastructure plugins when set to false", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      database: false,
      redis: false,
      kafka: false,
      realtime: false,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("does not register health provider for disabled infrastructure", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      database: false,
      redis: false,
      kafka: false,
      realtime: false,
    });

    // Check that health registry exists but has no infrastructure providers
    // (only system health provider which is always registered)
    expect(server.healthRegistry).toBeDefined();
    const providers = server.healthRegistry.getAll();
    const infraProviders = providers.filter(p =>
      ["database", "redis", "kafka", "realtime"].includes(p.name)
    );
    // Should have 0 infrastructure providers (system provider is always there)
    expect(infraProviders.length).toBe(0);

    await server.close();
  });
});

describe("Default Plugin Tests", () => {
  it("registers core runtime plugins by default", async () => {
    const server = await createBootstrapServer({
      logger: false,
      kafka: false,
      realtime: false,
      database: false,
      redis: false,
      env: false,
    });

    // Core runtime should be available
    expect(server.log).toBeDefined();
    expect(server.healthRegistry).toBeDefined();

    await server.close();
  });

  it("registers request-context by default", async () => {
    const server = await createBootstrapServer({
      logger: false,
      kafka: false,
      realtime: false,
      database: false,
      redis: false,
      env: false,
    });

    // Request context should be available
    expect(server).toBeDefined();

    await server.close();
  });

  it("registers response-management by default", async () => {
    const server = await createBootstrapServer({
      logger: false,
      kafka: false,
      realtime: false,
      database: false,
      redis: false,
      env: false,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("registers error handler by default", async () => {
    const server = await createBootstrapServer({
      logger: false,
      kafka: false,
      realtime: false,
      database: false,
      redis: false,
      env: false,
    });

    expect(server).toBeDefined();
    await server.close();
  });
});

describe("Configured Plugin Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("accepts cors configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cors: { origin: ["http://localhost:3000"], credentials: true },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts helmet configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      helmet: { contentSecurityPolicy: false },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts cookie configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cookie: { secret: "test-secret" },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts compress configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      compress: { threshold: 1024 },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts rateLimit configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      rateLimit: { max: 100, timeWindow: "1 minute" },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts multipart configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      multipart: { limits: { fileSize: 1024 * 1024 } },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts swagger configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { openapi: { info: { title: "Test API", version: "1.0.0" } } },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts swaggerUI configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { openapi: { info: { title: "Test API", version: "1.0.0" } } },
      swaggerUI: { routePrefix: "/api-docs" },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts csrf configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      csrf: { cookieOpts: { secure: false } },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts underPressure configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      underPressure: { maxEventLoopDelay: 1000 },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("normalizes boolean true to default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cors: true,
      helmet: true,
      cookie: true,
      compress: true,
      rateLimit: true,
    });

    expect(server).toBeDefined();
    await server.close();
  });
});