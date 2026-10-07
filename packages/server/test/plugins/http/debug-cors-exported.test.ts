import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { corsPlugin } from "./src/plugins/index.js";
import fastify from "fastify";

describe("Debug corsPlugin directly", () => {
  it("register cors via exported plugin", async () => {
    const server = fastify({ logger: false });

    await server.register(corsPlugin, { origin: true, credentials: true });

    server.get("/test", async () => ({ ok: true }));

    await server.ready();

    console.log("Server routes:", server.printRoutes());

    // Request with origin
    const response1 = await server.inject({ 
      method: "GET", 
      url: "/test",
      headers: { origin: "http://localhost:3000" }
    });
    console.log("Response 1:", response1.statusCode, response1.headers);

    await server.close();
  });
});