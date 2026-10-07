import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import fastify from "fastify";

describe("Debug Rate Limit Direct", () => {
  it("debug rate limit direct", async () => {
    const server = fastify({ logger: false });

    const mod = await import("@fastify/rate-limit");
    console.log("Rate limit module:", Object.keys(mod));

    await server.register(mod.default, { max: 2, timeWindow: "1 minute" });

    server.get("/limited", async () => ({ ok: true }));

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