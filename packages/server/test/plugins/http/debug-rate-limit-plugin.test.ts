import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { registerBuiltinPlugins, mergeBuiltinPlugins, registerHttpPlugins } from "./src/plugins/index.js";
import { registerHealthRegistry } from "./src/health/index.js";
import fastify from "fastify";

describe("Debug Rate Limit Plugin Registration", () => {
  it("register rate limit via plugin system", async () => {
    const server = fastify({ logger: false });

    registerHealthRegistry(server);

    const options = mergeBuiltinPlugins({
      rateLimit: { max: 2, timeWindow: "1 minute" },
      cors: false,
      helmet: false,
      cookie: false,
      compress: false,
      logger: false,
      zod: false,
      responseManagement: false,
      msgpack: false,
      requestContext: false,
      multipart: false,
      csrf: false,
      underPressure: false,
      database: false,
      kafka: false,
      redis: false,
      realtime: false,
      swagger: false,
      swaggerUI: false,
      health: false,
    });

    console.log("Options:", JSON.stringify(options, null, 2));

    // Only register HTTP plugins to isolate the issue
    await registerHttpPlugins(server, options);

    console.log("After registration");

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