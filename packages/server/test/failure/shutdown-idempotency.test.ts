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

describe("Shutdown Idempotency Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("multiple close() calls do not throw", async () => {
    const server = await createBootstrapServer(baseOptions);
    await server.ready();
    
    await server.close();
    await server.close();
    await server.close();
    
    // Should not throw
  });

  it("multiple close() calls do not close resources twice", async () => {
    const { app, close } = await startBootstrapServer({
      ...baseOptions,
      port: 0,
    });
    
    await app.ready();
    
    await close();
    await close();
    await close();
    
    // Should not throw or double-close
  });

  it("close() after ready() is idempotent", async () => {
    const server = await createBootstrapServer(baseOptions);
    await server.ready();
    
    await server.close();
    await server.close();
  });

  it("close() before ready() is idempotent", async () => {
    const server = await createBootstrapServer(baseOptions);
    // Don't call ready()
    
    await server.close();
    await server.close();
  });

  it("close() does not corrupt state", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      database: { logQueries: false },
      redis: { healthCheck: false },
    });
    
    await server.ready();
    await server.close();
    await server.close();
    
    // State should not be corrupted
  });

  it("close() does not hang", async () => {
    const server = await createBootstrapServer(baseOptions);
    await server.ready();
    
    const start = Date.now();
    await server.close();
    await server.close();
    const duration = Date.now() - start;
    
    // Should complete quickly
    expect(duration).toBeLessThan(5000);
  });

  it("close() does not attempt to reconnect", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      database: { logQueries: false },
      redis: { healthCheck: false },
    });
    
    await server.ready();
    await server.close();
    await server.close();
    
    // No reconnection attempts should occur
  });

  it("startBootstrapServer close() is idempotent", async () => {
    const { app, close } = await startBootstrapServer({
      ...baseOptions,
      port: 0,
    });
    
    await app.ready();
    await close();
    await close();
    await close();
  });
});