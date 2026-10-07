import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createBootstrapServer, type BootstrapServerOptions } from "./src/bootstrap.js";

describe("Debug Helmet Health Route", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("debug routes with helmet config", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      helmet: { contentSecurityPolicy: false },
    });

    await server.ready();
    console.log("Routes:", server.printRoutes());
    
    const response = await server.inject({ method: "GET", url: "/health" });
    console.log("Status:", response.statusCode);
    
    await server.close();
  });
});