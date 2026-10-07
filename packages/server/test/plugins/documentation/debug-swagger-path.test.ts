import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createBootstrapServer, type BootstrapServerOptions } from "./src/bootstrap.js";
import { z } from "zod";

describe("Debug Swagger Path Params", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    zod: true,
  };

  it("debug path params", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      swagger: { 
        openapi: { 
          info: { title: "Test API", version: "1.0.0" } 
        } 
      },
      configure: (app) => {
        app.get("/users/:id", {
          schema: {
            params: z.object({
              id: z.string().uuid(),
            }),
            response: {
              200: z.object({
                id: z.string().uuid(),
                name: z.string(),
              }),
            },
          },
          handler: async (request) => ({ id: request.params.id, name: "User" }),
        });
      },
    });

    await server.ready();
    const spec = server.swagger();
    
    console.log("Paths:", JSON.stringify(spec.paths, null, 2));
    
    await server.close();
  });
});