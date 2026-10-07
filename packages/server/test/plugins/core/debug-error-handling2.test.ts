import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createBootstrapServer, type BootstrapServerOptions } from "./src/bootstrap.js";

describe("Debug Error Handling Plugin Registration", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("debug error handler plugin registration", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/unknown", async () => {
          throw "string error";
        });
      },
    });

    await server.ready();
    
    // Check if error handler is set
    console.log("Error handler:", server.errorHandler ? "set" : "not set");
    console.log("Not found handler:", server.notFoundHandler ? "set" : "not set");
    
    const response = await server.inject({ method: "GET", url: "/unknown" });
    
    console.log("Status:", response.statusCode);
    console.log("Headers:", response.headers);
    console.log("Body:", response.body);
    
    expect(response.statusCode).toBe(500);

    await server.close();
  });
});