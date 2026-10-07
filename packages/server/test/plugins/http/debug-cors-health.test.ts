import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createBootstrapServer, type BootstrapServerOptions } from "./src/bootstrap.js";

describe("Debug CORS Health Route", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("debug cors health route", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cors: { origin: "http://allowed.example.com", credentials: true },
    });

    await server.ready();
    
    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://allowed.example.com" },
    });
    console.log("Status:", response.statusCode);
    console.log("Headers:", response.headers);
    
    await server.close();
  });
});