import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { registerOptionalPlugin, OPTIONAL_PLUGINS, mergeBuiltinPlugins } from "./src/plugins/index.js";
import fastify from "fastify";

describe("Debug registerOptionalPlugin", () => {
  it("register rate limit via registerOptionalPlugin", async () => {
    const server = fastify({ logger: false });

    const options = mergeBuiltinPlugins({
      rateLimit: { max: 2, timeWindow: "1 minute" },
    });

    console.log("Options:", JSON.stringify(options, null, 2));

    const rateLimitSpec = OPTIONAL_PLUGINS.find((s) => s.key === "rateLimit");
    console.log("Rate limit spec:", rateLimitSpec);

    await registerOptionalPlugin(server, rateLimitSpec!, options.rateLimit);

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