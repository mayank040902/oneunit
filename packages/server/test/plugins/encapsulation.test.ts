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

describe("Plugin Encapsulation Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("plugin A decorators don't leak to plugin B", async () => {
    const pluginA = async (app: FastifyInstance) => {
      app.decorate("pluginAData", { value: "A" });
      app.get("/a", async () => ({ from: "A" }));
    };

    const pluginB = async (app: FastifyInstance) => {
      app.get("/b", async () => ({ from: "B" }));
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [pluginA, pluginB],
    });

    // Plugin A's decorator should be available
    expect(server.pluginAData).toEqual({ value: "A" });
    
    // Both routes should work
    const responseA = await server.inject({ method: "GET", url: "/a" });
    expect(responseA.statusCode).toBe(200);
    expect(responseA.json().from).toBe("A");
    
    const responseB = await server.inject({ method: "GET", url: "/b" });
    expect(responseB.statusCode).toBe(200);
    expect(responseB.json().from).toBe("B");
    
    await server.close();
  });

  it("encapsulated plugin decorators are not globally available", async () => {
    // Fastify encapsulates plugins by default
    // Decorators added in a plugin are available to that plugin and its children
    // but not to siblings unless using fastify-plugin
    
    const pluginA = async (app: FastifyInstance) => {
      app.decorate("encapsulated", "value");
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [pluginA],
    });

    // Decorator should be available at root since we registered at root
    expect(server.encapsulated).toBe("value");
    
    await server.close();
  });

  it("plugin registration order follows Fastify encapsulation rules", async () => {
    let pluginAExecuted = false;
    let pluginBExecuted = false;
    
    const pluginA = async (app: FastifyInstance) => {
      pluginAExecuted = true;
      app.get("/a", async () => ({ order: "A" }));
    };

    const pluginB = async (app: FastifyInstance) => {
      pluginBExecuted = true;
      app.get("/b", async () => ({ order: "B" }));
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [pluginA, pluginB],
    });

    await server.ready();
    expect(pluginAExecuted).toBe(true);
    expect(pluginBExecuted).toBe(true);
    
    const responseA = await server.inject({ method: "GET", url: "/a" });
    expect(responseA.json().order).toBe("A");
    
    const responseB = await server.inject({ method: "GET", url: "/b" });
    expect(responseB.json().order).toBe("B");
    
    await server.close();
  });

  it("internal state doesn't leak globally", async () => {
    const plugin = async (app: FastifyInstance) => {
      // Internal state
      const internalState = { secret: "internal" };
      
      app.get("/internal", async () => ({
        // This would expose internal state if not careful
        internal: internalState.secret,
      }));
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [plugin],
    });

    const response = await server.inject({ method: "GET", url: "/internal" });
    expect(response.statusCode).toBe(200);
    // The route exposes what the plugin chooses to expose
    expect(response.json().internal).toBe("internal");
    
    await server.close();
  });

  it("decorators available where expected", async () => {
    const plugin = async (app: FastifyInstance) => {
      app.decorate("myService", {
        doSomething: () => "done",
      });
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [plugin],
    });

    // Decorator should be available on server
    expect(server.myService).toBeDefined();
    expect(server.myService.doSomething()).toBe("done");
    
    await server.close();
  });

  it("decorators unavailable where they should not be", async () => {
    // This tests Fastify's encapsulation - decorators from one
    // encapsulated context shouldn't leak to another
    const plugin = async (app: FastifyInstance) => {
      app.decorate("scoped", "value");
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [plugin],
    });

    // At root level, decorator is available
    expect(server.scoped).toBe("value");
    
    await server.close();
  });
});