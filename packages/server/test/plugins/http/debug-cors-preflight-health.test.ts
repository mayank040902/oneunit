import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createBootstrapServer, type BootstrapServerOptions } from "./src/bootstrap.js";

describe("Debug CORS Preflight with Health", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("debug cors preflight with health", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      health: true,
      cors: { origin: true },
    });

    await server.ready();
    console.log("Routes:", server.printRoutes());
    
    const response = await server.inject({
      method: "OPTIONS",
      url: "/health",
      headers: { 
        origin: "http://example.com",
        "access-control-request-method": "POST",
      },
    });
    console.log("Status:", response.statusCode);
    console.log("Headers:", response.headers);
    
    await server.close();
  });
});