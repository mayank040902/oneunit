import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createBootstrapServer,
  type BootstrapServerOptions,
} from "../../../src/bootstrap.js";

const baseOptions: Partial<BootstrapServerOptions> = {
  logger: false,
  kafka: false,
  realtime: false,
  database: false,
  redis: false,
  env: false,
  health: false,
};

const schema = z.object({ email: z.string().email() });

describe("Error Envelope Tests", () => {
  it("keeps the errors package payload by default", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.post("/register", async (_req, reply) => reply.badRequest({ message: "Invalid request" }));
      },
    });

    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/register",
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("not valid JSON");

    await server.close();
  });

  it("answers framework errors in the response envelope", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      errorHandler: { errorEnvelope: true },
      configure: (app) => {
        app.post("/register", async (_req, reply) => reply.badRequest({ message: "Invalid request" }));
      },
    });

    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/register",
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("BAD_REQUEST");
    expect(body.message).toContain("not valid JSON");
    expect(body.metadata.requestId).toBeTypeOf("string");
    expect(body.metadata.path).toBe("/register");
    expect(body.metadata.timestamp).toBeTypeOf("string");

    await server.close();
  });

  it("gives a framework error the same shape as a handler error", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      errorHandler: { errorEnvelope: true },
      configure: (app) => {
        app.post("/register", async (_req, reply) => reply.badRequest({ message: "Invalid request" }));
      },
    });

    await server.ready();

    const fromHandler = await server.inject({ method: "GET", url: "/register" });
    const fromFramework = await server.inject({
      method: "POST",
      url: "/register",
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });

    for (const body of [fromHandler.json(), fromFramework.json()]) {
      expect(body.error).toBeUndefined();
      expect(body.success).toBe(false);
      expect(body.code).toBeTypeOf("string");
      expect(body.message).toBeTypeOf("string");
    }

    await server.close();
  });

  it("answers an unmatched route in the response envelope", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      errorHandler: { errorEnvelope: true },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("NOT_FOUND");

    await server.close();
  });

  it("carries a schema validation failure as a field map", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      errorHandler: { errorEnvelope: true },
      configure: (app) => {
        app.post("/register", { schema: { body: schema } }, async (_req, reply) =>
          reply.created({ data: { ok: true } }),
        );
      },
    });

    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/register",
      payload: { email: "not-an-email" },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.data.fields).toBeTypeOf("object");

    await server.close();
  });

  it("keeps a user supplied custom handler in charge", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      errorHandler: {
        errorEnvelope: true,
        customHandler: async (_error, _request, reply) => {
          await reply.status(418).send({ custom: true });
        },
      },
    });

    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/register",
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(418);
    expect(response.json()).toEqual({ custom: true });

    await server.close();
  });

  it("keeps the retry window on a rate limit", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      errorHandler: { errorEnvelope: true },
      configure: (app) => {
        app.get("/limited", async () => {
          const { RateLimitError } = await import("@oneunit/errors");
          throw new RateLimitError("Slow down", 30);
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/limited" });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.json().code).toBe("RATE_LIMIT_EXCEEDED");

    await server.close();
  });
});
