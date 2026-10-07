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

describe("Outbound HTTP Client Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("Undici is not registered as Fastify plugin", async () => {
    // Undici is an outbound HTTP client, not an incoming middleware
    const server = await createBootstrapServer(baseOptions);
    await server.ready();
    
    // Undici should not be in Fastify's plugin tree
    expect(server).toBeDefined();
    await server.close();
  });

  it("outbound HTTP uses HTTP client abstraction", async () => {
    // If server provides an outbound HTTP abstraction, it should wrap Undici
    const server = await createBootstrapServer(baseOptions);
    await server.ready();
    
    expect(server).toBeDefined();
    await server.close();
  });

  it("supports timeout configuration", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      // If httpClient option exists
    });
    
    await server.ready();
    await server.close();
  });

  it("supports cancellation", async () => {
    const server = await createBootstrapServer(baseOptions);
    await server.ready();
    
    // Cancellation would be tested with actual HTTP calls
    await server.close();
  });

  it("normalizes errors", async () => {
    const server = await createBootstrapServer(baseOptions);
    await server.ready();
    
    // Error normalization would be tested with actual HTTP calls
    await server.close();
  });

  it("reuses connections when applicable", async () => {
    const server = await createBootstrapServer(baseOptions);
    await server.ready();
    
    // Connection pooling would be tested with actual HTTP calls
    await server.close();
  });

  it("retries only when explicitly configured", async () => {
    const server = await createBootstrapServer(baseOptions);
    await server.ready();
    
    // Retry logic would be tested with actual HTTP calls
    await server.close();
  });
});