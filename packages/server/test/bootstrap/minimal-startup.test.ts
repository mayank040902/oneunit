import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
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
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
  };

  it("starts with minimal config without optional infrastructure", async () => {
    const server = await startBootstrapServer({
      ...baseOptions,
      port: 0,
    });

    expect(server.app).toBeDefined();
    expect(server.address).toBeDefined();
    expect(server.port).toBeGreaterThan(0);
    expect(server.host).toBeDefined();
    expect(typeof server.close).toBe("function");

    await server.close();
  });

  it("returns Fastify instance with required decorators", async () => {
    const server = await createBootstrapServer(baseOptions);

    expect(server).toBeDefined();
    expect(server.ready).toBeDefined();
    expect(server.inject).toBeDefined();
    expect(server.close).toBeDefined();
    expect(server.log).toBeDefined();

    await server.close();
  });

  it("health route works by default", async () => {
    const server = await createBootstrapServer(baseOptions);
    await server.ready();

    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.service).toBeDefined();
    expect(body.status).toBeDefined();
    expect(body.checks).toBeDefined();

    await server.close();
  });

  it("can disable health route", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      health: false,
    });

    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(404);

    await server.close();
  });

  it("server reaches ready state", async () => {
    const server = await createBootstrapServer(baseOptions);
    await server.ready();
    expect(server.ready).toBeDefined();
    await server.close();
  });
});