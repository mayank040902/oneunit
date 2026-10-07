import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createBootstrapServer, type BootstrapServerOptions } from "./src/bootstrap.js";

describe("Debug Configure", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
    zod: false, // Disable zod to test JSON Schema validation
  };

  it("debug configure schema", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (server) => {
        server.get("/users", {
          schema: {
            querystring: {
              type: "object",
              properties: {
                limit: { type: "integer" },
              },
            },
          },
          handler: async () => ({ users: [] }),
        });
      },
    });

    await server.ready();

    console.log("Server routes:", server.printRoutes());

    const response = await server.inject({ method: "GET", url: "/users?limit=10" });
    
    console.log("Status:", response.statusCode);
    console.log("Body:", response.body);
    console.log("Headers:", response.headers);

    expect(response.statusCode).toBe(200);

    await server.close();
  });
});