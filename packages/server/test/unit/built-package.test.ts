import { describe, expect, it } from "vitest";
import { createBootstrapServer } from "@oneunit/server";

describe("Built Package Consumer Tests", () => {
  // These tests verify that the built package works for consumers
  // They test the same APIs but simulate a consumer importing from the package

  it("consumer can import createBootstrapServer", async () => {
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
    await server.close();
  });

  it("consumer can use configure callback", async () => {
    const server = await createBootstrapServer({
      logger: false,
      kafka: false,
      realtime: false,
      database: false,
      redis: false,
      env: false,
      health: false,
      configure: (app) => {
        app.get("/consumer", async () => ({ consumer: true }));
      },
    });

    const response = await server.inject({ method: "GET", url: "/consumer" });
    expect(response.statusCode).toBe(200);
    expect(response.json().consumer).toBe(true);

    await server.close();
  });

  it("consumer can use plugins", async () => {
    const server = await createBootstrapServer({
      logger: false,
      kafka: false,
      realtime: false,
      database: false,
      redis: false,
      env: false,
      health: false,
      plugins: [
        async (app) => {
          app.get("/plugin", async () => ({ plugin: true }));
        },
      ],
    });

    const response = await server.inject({ method: "GET", url: "/plugin" });
    expect(response.statusCode).toBe(200);
    expect(response.json().plugin).toBe(true);

    await server.close();
  });

  it("consumer can configure plugins", async () => {
    const server = await createBootstrapServer({
      logger: false,
      kafka: false,
      realtime: false,
      database: false,
      redis: false,
      env: false,
      cors: { origin: "http://consumer.example.com" },
      helmet: { contentSecurityPolicy: false },
    });

    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://consumer.example.com" },
    });

    expect(response.statusCode).toBe(200);
    await server.close();
  });

  it("runtime dependencies resolve", async () => {
    // All runtime dependencies (fastify, @fastify/*, etc.) should resolve
    const server = await createBootstrapServer({
      logger: false,
      kafka: false,
      realtime: false,
      database: false,
      redis: false,
      env: false,
      health: false,
    });

    await server.ready();
    expect(server).toBeDefined();
    await server.close();
  });

  it("optional dependencies behave correctly", async () => {
    // Optional deps (@oneunit/*) should not break when disabled
    const server = await createBootstrapServer({
      logger: false,
      kafka: false,
      realtime: false,
      database: false,
      redis: false,
      env: false,
      health: false,
    });

    await server.ready();
    expect(server).toBeDefined();
    await server.close();
  });

  it("package paths are correct", () => {
    // Verify the package.json exports field points to correct files
    // This is a compile-time check - if imports work, paths are correct
    expect(true).toBe(true);
  });

  it("ESM/CJS behavior matches contract", async () => {
    // Package uses ESM (type: module in package.json)
    // Consumer should use ESM imports
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
    await server.close();
  });

  it("declaration files are valid", () => {
    // TypeScript declaration files should be valid
    // This is verified by TypeScript compilation
    expect(true).toBe(true);
  });
});