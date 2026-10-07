import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createBootstrapServer, type BootstrapServerOptions } from "./src/bootstrap.js";

describe("Debug Health Route Methods", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("debug health route methods", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      health: true,
    });

    await server.ready();
    console.log("Routes:", server.printRoutes());
    
    const responseGet = await server.inject({ method: "GET", url: "/health" });
    console.log("GET Status:", responseGet.statusCode);
    
    const responseOptions = await server.inject({ method: "OPTIONS", url: "/health" });
    console.log("OPTIONS Status:", responseOptions.statusCode);
    
    await server.close();
  });
});