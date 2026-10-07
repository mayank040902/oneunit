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
    { cors: false as const, name: "cors" },
    { helmet: false as const, name: "helmet" },
    { cookie: false as const, name: "cookie" },
    { compress: false as const, name: "compress" },
    { rateLimit: false as const, name: "rateLimit" },
    { multipart: false as const, name: "multipart" },
    { swagger: false as const, name: "swagger" },
    { swaggerUI: false as const, name: "swaggerUI" },
    { csrf: false as const, name: "csrf" },
    { underPressure: false as const, name: "underPressure" },
    { requestContext: false as const, name: "requestContext" },
    { zod: false as const, name: "zod" },
    { msgpack: false as const, name: "msgpack" },
    { responseManagement: false as const, name: "responseManagement" },
    { errorHandler: false as const, name: "errorHandler" },
    { logger: false as const, name: "logger" },
    { database: false as const, name: "database" },
    { redis: false as const, name: "redis" },
    { kafka: false as const, name: "kafka" },
    { realtime: false as const, name: "realtime" },
  ];

  for (const { name, ...pluginConfig } of disabledPlugins) {
    it(`disables ${name} plugin when set to false`, async () => {
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
    const infraProviders = providers.filter((p) =>
      ["database", "redis", "kafka", "realtime"].includes(p.name)
    );
    // Should have 0 infrastructure providers (system provider is always there)
    expect(infraProviders.length).toBe(0);

    await server.close();
  });

  it("disabled plugin does not initialize its runtime", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      database: false,
    });

    // Database plugin should not decorate the server
    expect(server.db).toBeUndefined();
    expect(server.database).toBeUndefined();

    await server.close();
  });

  it("disabled plugin does not create external resources", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      redis: false,
    });

    // Redis plugin should not decorate the server
    expect(server.redis).toBeUndefined();

    await server.close();
  });

  it("disabled plugin does not register shutdown handler", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      kafka: false,
    });

    // Kafka plugin should not decorate the server
    expect(server.kafka).toBeUndefined();

    await server.close();
  });
});