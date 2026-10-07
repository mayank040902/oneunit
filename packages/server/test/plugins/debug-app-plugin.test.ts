import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createBootstrapServer, type BootstrapServerOptions } from "./src/bootstrap.js";

describe("Debug Application Plugin", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("debug plugin with options", async () => {
    let pluginCalled = false;
    let receivedOptions: any = null;
    
    const testPlugin = async (app: FastifyInstance, options: { prefix: string }) => {
      pluginCalled = true;
      receivedOptions = options;
      console.log("Plugin called with options:", options);
      app.get(options.prefix, async () => ({ value: options.prefix }));
    };

    const server = await createBootstrapServer({
      ...baseOptions,
      plugins: [{ plugin: testPlugin, options: { prefix: "/custom" } }],
    });

    await server.ready();
    console.log("Plugin called:", pluginCalled);
    console.log("Received options:", receivedOptions);
    console.log("Routes:", server.printRoutes());
    
    const response = await server.inject({ method: "GET", url: "/custom" });
    console.log("Status:", response.statusCode);
    console.log("Body:", response.body);
    
    await server.close();
  });
});