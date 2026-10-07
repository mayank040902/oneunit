import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createBootstrapServer, type BootstrapServerOptions } from "./src/bootstrap.js";

describe("Debug CORS Headers", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("debug cors headers", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      health: true,
      cors: { allowedHeaders: ["X-Custom-Header"] },
    });

    await server.ready();
    
    const response = await server.inject({
      method: "OPTIONS",
      url: "/health",
      headers: { 
        origin: "http://example.com",
        "access-control-request-headers": "X-Custom-Header",
      },
    });
    console.log("Status:", response.statusCode);
    console.log("Headers:", response.headers);
    console.log("access-control-allow-headers:", response.headers["access-control-allow-headers"]);
    
    await server.close();
  });
});