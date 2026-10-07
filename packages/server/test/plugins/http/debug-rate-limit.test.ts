import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createBootstrapServer, type BootstrapServerOptions } from "./src/bootstrap.js";

describe("Debug Rate Limit", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("debug rate limit registration", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      rateLimit: { max: 2, timeWindow: "1 minute" },
      configure: (app) => {
        app.get("/limited", async () => ({ ok: true }));
      },
    });

    await server.ready();

    console.log("Server routes:", server.printRoutes());

    // Request 1
    const response1 = await server.inject({ method: "GET", url: "/limited" });
    console.log("Response 1:", response1.statusCode, response1.headers);

    // Request 2
    const response2 = await server.inject({ method: "GET", url: "/limited" });
    console.log("Response 2:", response2.statusCode, response2.headers);

    // Request 3
    const response3 = await server.inject({ method: "GET", url: "/limited" });
    console.log("Response 3:", response3.statusCode, response3.headers);

    await server.close();
  });
});