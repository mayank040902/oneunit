import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createBootstrapServer,
  type BootstrapServerOptions,
} from "../../../src/bootstrap.js";
import { toValidationFields } from "../../../src/lib/validation.js";

describe("Response Management Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("centralizes successful responses", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/success", async () => ({ data: "ok" }));
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/success" });
    
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toBe("ok");
    
    await server.close();
  });

  it("centralizes error responses", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/error", async () => {
          throw new Error("test error");
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/error" });
    
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toBeDefined();
    
    await server.close();
  });

  it("does not impose application-specific response schemas", async () => {
    // This test verifies the architectural contract:
    // Response management is centralized but doesn't enforce specific schemas
    // Application can return any JSON-serializable data
    
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/custom-response", async () => ({
          custom: "format",
          nested: { data: [1, 2, 3] },
        }));
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/custom-response" });
    
    expect(response.statusCode).toBe(200);
    expect(response.json().custom).toBe("format");
    expect(response.json().nested.data).toEqual([1, 2, 3]);
    
    await server.close();
  });

  it("handles different status codes", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/created", async (request, reply) => {
          return reply.code(201).send({ created: true });
        });
        app.get("/no-content", async (request, reply) => {
          return reply.code(204).send();
        });
      },
    });

    await server.ready();
    
    const created = await server.inject({ method: "GET", url: "/created" });
    expect(created.statusCode).toBe(201);
    
    const noContent = await server.inject({ method: "GET", url: "/no-content" });
    expect(noContent.statusCode).toBe(204);
    
    await server.close();
  });

  it("handles array responses", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/array", async () => [1, 2, 3]);
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/array" });
    
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([1, 2, 3]);
    
    await server.close();
  });

  it("handles string responses", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/string", async () => "plain text");
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/string" });
    
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("plain text");
    
    await server.close();
  });

  it("can be disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      responseManagement: false,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts custom configuration", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      responseManagement: true,
    });

    expect(server).toBeDefined();
    await server.close();
  });
});

describe("Response Management Metadata Safety Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("redacts sensitive metadata keys by default", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/echo", async (_req, reply) =>
          reply.success({ data: { id: "1" }, message: "OK", code: "200", metadata: { password: "hunter2", email: "a@b.c" } }),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/echo" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.metadata.password).toBe("[REDACTED]");
    expect(body.metadata.email).toBe("a@b.c");

    await server.close();
  });

  it("redacts nested metadata", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/echo", async (_req, reply) =>
          reply.badRequest({
            message: "Invalid request",
            metadata: { submitted: { token: "abc", name: "Ada" } },
          }),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/echo" });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.metadata.submitted.token).toBe("[REDACTED]");
    expect(body.metadata.submitted.name).toBe("Ada");

    await server.close();
  });

  it("never rewrites the data payload", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.post("/token", async (_req, reply) =>
          reply.created({ data: { accessToken: "issued-token" } }),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "POST", url: "/token" });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.accessToken).toBe("issued-token");

    await server.close();
  });

  it("sanitises a hand-built envelope sent through reply.response", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/manual", async (_req, reply) =>
          reply.response(
            { success: true, code: "202", message: "Accepted", metadata: { secret: "s3cr3t" } },
            202,
          ),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/manual" });

    expect(response.statusCode).toBe(202);
    expect(response.json().metadata.secret).toBe("[REDACTED]");

    await server.close();
  });

  it("allows redaction to be disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      responseManagement: { redactMetadata: false },
      configure: (app) => {
        app.get("/echo", async (_req, reply) =>
          reply.success({ data: { id: "1" }, message: "OK", code: "200", metadata: { password: "hunter2" } }),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/echo" });

    expect(response.json().metadata.password).toBe("hunter2");

    await server.close();
  });

  it("allows a custom redaction key list", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      responseManagement: { redactMetadata: ["apiKey"] },
      configure: (app) => {
        app.get("/echo", async (_req, reply) =>
          reply.success({ data: { id: "1" }, message: "OK", code: "200", metadata: { apiKey: "abc", password: "hunter2" } }),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/echo" });

    const body = response.json();
    expect(body.metadata.apiKey).toBe("[REDACTED]");
    expect(body.metadata.password).toBe("hunter2");

    await server.close();
  });

  it("bounds metadata size", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      responseManagement: { metadataLimits: { maxStringLength: 10 } },
      configure: (app) => {
        app.get("/echo", async (_req, reply) =>
          reply.success({ data: { id: "1" }, message: "OK", code: "200", metadata: { note: "x".repeat(50) } }),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/echo" });

    expect(response.json().metadata.note).toBe(`${"x".repeat(10)}[TRUNCATED]`);

    await server.close();
  });

  it("honours custom default message and code", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      responseManagement: { defaultMessage: "All good", defaultCode: "OK" },
      configure: (app) => {
        app.get("/ok", async (_req, reply) => reply.success({ data: { id: "1" } }));
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/ok" });

    const body = response.json();
    expect(body.message).toBe("All good");
    expect(body.code).toBe("OK");

    await server.close();
  });
});

describe("Response Management Error Shape Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("maps a symbolic code to its HTTP status", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/missing", async (_req, reply) =>
          reply.failed({ message: "Resource not found", code: "NOT_FOUND" }),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("NOT_FOUND");

    await server.close();
  });

  it("keeps a numeric code as the HTTP status", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/missing", async (_req, reply) => reply.failed({ message: "Gone", code: "404" }));
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("404");

    await server.close();
  });

  it("allows an explicit status override", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/limited", async (_req, reply) =>
          reply.failed({ message: "Slow down", code: "RATE_LIMIT_EXCEEDED", statusCode: 429 }),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/limited" });

    expect(response.statusCode).toBe(429);

    await server.close();
  });

  it("returns a field-keyed validation error map", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.post("/register", async (_req, reply) =>
          reply.validationFailed({
            fields: { email: ["Invalid email address"], name: ["Too short"] },
            message: "Please check the highlighted fields",
          }),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "POST", url: "/register" });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toBe("Please check the highlighted fields");
    expect(body.data.fields).toEqual({
      email: ["Invalid email address"],
      name: ["Too short"],
    });

    await server.close();
  });

  it("carries a structured payload on a failure", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.post("/register", async (_req, reply) =>
          reply.conflict({ message: "Account exists", data: { field: "email" } }),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "POST", url: "/register" });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.data).toEqual({ field: "email" });

    await server.close();
  });

  it("turns Zod issues into a field-keyed validation error map", async () => {
    const schema = z.object({ email: z.string().email() });

    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.post("/register", async (request, reply) => {
          const result = schema.safeParse(request.body);
          if (!result.success) {
            return reply.validationFailed({
              fields: toValidationFields(result.error),
              message: "Please check the highlighted fields",
            });
          }
          return reply.created({ data: result.data });
        });
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
    expect(body.data.fields.email).toEqual(["Invalid email address"]);
    expect(body.data.fields.email[0]).toBeTypeOf("string");

    await server.close();
  });

  it("keeps validator internals out of the client payload", async () => {
    const schema = z.object({ email: z.string().email() });

    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.post("/register", async (request, reply) => {
          const result = schema.safeParse(request.body);
          if (!result.success) {
            return reply.validationFailed({ fields: toValidationFields(result.error) });
          }
          return reply.created({ data: result.data });
        });
      },
    });

    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/register",
      payload: { email: "not-an-email" },
    });

    const body = response.json();
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("invalid_format");
    expect(serialised).not.toContain("origin");
    expect(serialised).not.toContain("pattern");

    await server.close();
  });
});

describe("Response Management Named Options Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("takes the payload by name, not by position", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/ok", async (_req, reply) =>
          reply.success({ data: { id: "1" }, message: "Loaded", code: "200" }),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/ok" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toEqual({ id: "1" });
    expect(body.message).toBe("Loaded");
    expect(body.code).toBe("200");

    await server.close();
  });

  it("rejects the old positional payload form", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/ok", async (_req, reply) =>
          reply.success({ id: "1" } as never),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/ok" });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("options object");
    expect(response.body).toContain("data");

    await server.close();
  });

  it("rejects the old positional message form", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/bad", async (_req, reply) =>
          reply.badRequest("Invalid request" as never),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/bad" });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("options object");

    await server.close();
  });

  it("accepts an empty options object on a failure helper", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/missing", async (_req, reply) => reply.notFound());
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json().message).toBe("Resource not found");

    await server.close();
  });

  it("accepts an empty options object on a deletion helper", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.delete("/users/:id", async (_req, reply) => reply.deleted());
      },
    });

    await server.ready();
    const response = await server.inject({ method: "DELETE", url: "/users/1" });

    expect(response.statusCode).toBe(200);
    expect(response.json().message).toBe("Resource deleted successfully");

    await server.close();
  });

  it("keeps the payload and the context distinguishable", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/ok", async (_req, reply) =>
          reply.success({
            data: { password: "not-redacted" },
            metadata: { password: "redacted" },
          }),
        );
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/ok" });

    const body = response.json();
    expect(body.data.password).toBe("not-redacted");
    expect(body.metadata.password).toBe("[REDACTED]");

    await server.close();
  });
});