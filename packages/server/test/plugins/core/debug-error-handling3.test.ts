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

  it("debug error handler function", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/unknown", async () => {
          throw "string error";
        });
      },
    });

    await server.ready();
    
    // Check the error handler function
    console.log("Error handler function:", server.errorHandler?.toString().slice(0, 200));
    
    const response = await server.inject({ method: "GET", url: "/unknown" });
    
    console.log("Status:", response.statusCode);
    console.log("Headers:", response.headers);
    console.log("Body:", response.body);
    
    expect(response.statusCode).toBe(500);

    await server.close();
  });
});