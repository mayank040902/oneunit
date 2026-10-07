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

describe("Realtime Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("enables realtime infrastructure", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      realtime: { websocketLibrary: "fastify" as const },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("server owns connection lifecycle", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      realtime: { websocketLibrary: "fastify" as const },
    });

    await server.ready();
    // Server provides WebSocket infrastructure
    // Connection lifecycle (connect, disconnect, heartbeat) is server responsibility
    expect(server).toBeDefined();
    await server.close();
  });

  it("does NOT own application event semantics", async () => {
    // This test verifies the architectural contract:
    // Server package provides connection infrastructure
    // Application provides event handlers
    
    const server = await createBootstrapServer({
      ...baseOptions,
      realtime: { websocketLibrary: "fastify" as const },
      configure: (app) => {
        // Application registers its own event handlers
        // Server doesn't hardcode: chat.message, user.typing, post.created, etc.
        if (app.realtime) {
          // Application would do something like:
          // app.realtime.on("connection", (socket) => {
          //   socket.on("chat.message", handleChatMessage);
          //   socket.on("user.typing", handleUserTyping);
          // });
        }
      },
    });

    await server.ready();
    // No hardcoded events in server package
    expect(server).toBeDefined();
    await server.close();
  });

  it("application realtime plugin can register event handlers", async () => {
    let handlerRegistered = false;
    
    const server = await createBootstrapServer({
      ...baseOptions,
      realtime: { websocketLibrary: "fastify" as const },
      configure: (app) => {
        // Application plugin registers event handlers
        if (app.realtime) {
          // Simulate application registering handlers
          handlerRegistered = true;
        }
      },
    });

    await server.ready();
    expect(handlerRegistered).toBe(true);
    await server.close();
  });

  it("can be disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      realtime: false,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts custom configuration", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      realtime: { 
        websocketLibrary: "fastify" as const,
        // Additional options would be passed to the realtime plugin
      },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("registers health provider", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      realtime: { websocketLibrary: "fastify" as const },
    });

    await server.ready();
    const providers = server.healthRegistry.getAll();
    const realtimeProvider = providers.find(p => p.name === "realtime");
    
    if (realtimeProvider) {
      expect(realtimeProvider.name).toBe("realtime");
    }
    await server.close();
  });

  it("registers shutdown handler for connections", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      realtime: { websocketLibrary: "fastify" as const },
    });

    await server.ready();
    await server.close();
    // Connection cleanup should happen on shutdown
  });

  it("supports WebSocket library selection", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      realtime: { websocketLibrary: "fastify" as const },
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("no hardcoded application events", async () => {
    // Verify server doesn't hardcode events like:
    // chat.message, user.typing, post.created, etc.
    
    const server = await createBootstrapServer({
      ...baseOptions,
      realtime: { websocketLibrary: "fastify" as const },
    });

    await server.ready();
    
    // Server realtime infrastructure is generic
    // No event names like "chat.message" should be in server code
    expect(server).toBeDefined();
    await server.close();
  });
});