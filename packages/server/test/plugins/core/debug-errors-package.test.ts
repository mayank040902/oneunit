import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { errorHandlerPlugin } from "@oneunit/errors/fastify";
import fastify from "fastify";

describe("Debug @oneunit/errors error handler", () => {
  it("debug string error handling", async () => {
    const server = fastify({ logger: false });
    
    await server.register(errorHandlerPlugin, {});
    
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