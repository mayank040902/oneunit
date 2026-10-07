import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createBootstrapServer, type BootstrapServerOptions } from "./src/bootstrap.js";

describe("Debug Helmet Health Route - First Test Headers", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("debug headers with default helmet", async () => {
    const server = await createBootstrapServer(baseOptions);

    await server.ready();
    
    const response = await server.inject({ method: "GET", url: "/health" });
    console.log("Status:", response.statusCode);
    console.log("Headers:", response.headers);
    console.log("x-dns-prefetch-control:", response.headers["x-dns-prefetch-control"]);
    console.log("x-frame-options:", response.headers["x-frame-options"]);
    console.log("x-content-type-options:", response.headers["x-content-type-options"]);
    
    await server.close();
  });
});