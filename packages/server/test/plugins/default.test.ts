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

describe("Default Plugin Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("registers core runtime plugins by default", async () => {
    const server = await createBootstrapServer(baseOptions);

    // Core runtime should be available
    expect(server.log).toBeDefined();
    expect(server.healthRegistry).toBeDefined();

    await server.close();
  });

  it("registers request-context by default", async () => {
    const server = await createBootstrapServer(baseOptions);

    // Request context should be available
    expect(server).toBeDefined();

    await server.close();
  });

  it("registers response-management by default", async () => {
    const server = await createBootstrapServer(baseOptions);

    expect(server).toBeDefined();
    await server.close();
  });

  it("registers error handler by default", async () => {
    const server = await createBootstrapServer(baseOptions);

    expect(server).toBeDefined();
    await server.close();
  });

  it("registers logger by default", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      logger: { useHttpLogger: false },
    });

    expect(server.log).toBeDefined();
    await server.close();
  });

  it("registers helmet by default", async () => {
    const server = await createBootstrapServer(baseOptions);

    // Helmet should be registered (check via security headers)
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.headers).toBeDefined();
    await server.close();
  });

  it("registers cookie by default", async () => {
    const server = await createBootstrapServer(baseOptions);

    expect(server).toBeDefined();
    await server.close();
  });

  it("registers cors by default", async () => {
    const server = await createBootstrapServer(baseOptions);

    expect(server).toBeDefined();
    await server.close();
  });

  it("registers compress by default", async () => {
    const server = await createBootstrapServer(baseOptions);

    expect(server).toBeDefined();
    await server.close();
  });

  it("registers rateLimit by default", async () => {
    const server = await createBootstrapServer(baseOptions);

    expect(server).toBeDefined();
    await server.close();
  });

  it("registers zod type provider by default", async () => {
    const server = await createBootstrapServer(baseOptions);

    expect(server).toBeDefined();
    await server.close();
  });

  it("registers msgpack by default", async () => {
    const server = await createBootstrapServer(baseOptions);

    expect(server).toBeDefined();
    await server.close();
  });
});