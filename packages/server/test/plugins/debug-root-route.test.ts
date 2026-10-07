import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createBootstrapServer, type BootstrapServerOptions } from "./src/bootstrap.js";

describe("Debug Root Route", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("debug root route", async () => {
    const server = await createBootstrapServer(baseOptions);

    await server.ready();
    
    const response = await server.inject({ method: "GET", url: "/" });
    console.log("Status:", response.statusCode);
    console.log("Body:", response.body);
    
    await server.close();
  });
});