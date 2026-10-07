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

  it("accepts cors as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cors: true,
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

  it("accepts helmet as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      helmet: true,
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

  it("accepts cookie as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cookie: true,
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

  it("accepts compress as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      compress: true,
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

  it("accepts rateLimit as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      rateLimit: true,
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

  it("accepts multipart as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      multipart: true,
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

  it("accepts swagger as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: true,
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

  it("accepts swaggerUI as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: true,
      swaggerUI: true,
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

  it("accepts csrf as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      csrf: true,
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

  it("accepts underPressure as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      underPressure: true,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts requestContext configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      requestContext: { key: "custom-key" },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts requestContext as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      requestContext: true,
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

  it("accepts database configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      database: { logQueries: false },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts database as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      database: true,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts redis configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      redis: { healthCheck: false },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts redis as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      redis: true,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts kafka configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      kafka: { autoConnectProducer: false },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts kafka as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      kafka: true,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts realtime configuration object", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      realtime: { websocketLibrary: "fastify" as const },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts realtime as true for default config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      realtime: true,
    });

    expect(server).toBeDefined();
    await server.close();
  });
});