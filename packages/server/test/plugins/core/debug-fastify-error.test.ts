import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import fastify from "fastify";

describe("Debug Fastify string error", () => {
  it("debug string error handling", async () => {
    const server = fastify({ logger: false });
    
    server.setErrorHandler((error, request, reply) => {
      console.log("Error handler called:", error, typeof error);
      reply.status(500).send({ error: "Custom handler", message: error.message });
    });
    
    server.get("/unknown", async () => {
      throw "string error";
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/unknown" });
    
    console.log("Status:", response.statusCode);
    console.log("Headers:", response.headers);
    console.log("Body:", response.body);
    
    await server.close();
  });
});