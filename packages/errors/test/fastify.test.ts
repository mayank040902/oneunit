import { describe, it, expect, vi } from "vitest";
import fastify from "fastify";
import { createErrorHandler, createNotFoundHandler, registerErrorHandler, errorHandlerPlugin, formatValidationError } from "../src/fastify.js";
import { ValidationError, AuthenticationError, NotFoundError, RateLimitError, InternalError, AppError } from "../src/index.js";

describe("Fastify error handler", () => {
  it("handles AppError instances", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler());

    app.get("/test", async () => {
      throw new ValidationError("Invalid input", { email: ["required"] });
    });

    const response = await app.inject({ method: "GET", url: "/test" });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields).toEqual({ email: ["required"] });
  });

  it("handles AuthenticationError", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler());

    app.get("/protected", async () => {
      throw new AuthenticationError("Token expired");
    });

    const response = await app.inject({ method: "GET", url: "/protected" });
    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error.code).toBe("AUTHENTICATION_ERROR");
  });

  it("handles NotFoundError", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler());

    app.get("/not-found", async () => {
      throw new NotFoundError("User", 123);
    });

    const response = await app.inject({ method: "GET", url: "/not-found" });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("handles plain Error", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler());

    app.get("/error", async () => {
      throw new Error("Something broke");
    });

    const response = await app.inject({ method: "GET", url: "/error" });
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("handles unknown throw values", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler());

    app.get("/unknown", async () => {
      throw "string error";
    });

    const response = await app.inject({ method: "GET", url: "/unknown" });
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("keeps unmapped 4xx status codes instead of collapsing to 500", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler());

    app.get("/bad-json", async () => {
      throw Object.assign(new Error("Bad JSON"), { statusCode: 400 });
    });

    app.get("/teapot", async () => {
      throw Object.assign(new Error("I am a teapot"), { statusCode: 418 });
    });

    const badJson = await app.inject({ method: "GET", url: "/bad-json" });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().error.code).toBe("BAD_REQUEST");

    const teapot = await app.inject({ method: "GET", url: "/teapot" });
    expect(teapot.statusCode).toBe(418);
  });

  it("returns 400 for invalid JSON request bodies", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler());

    app.post("/echo", async () => ({ ok: true }));

    const response = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
  });

  it("keys missing properties by name instead of collapsing them into 'required'", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler());
    app.setNotFoundHandler(createNotFoundHandler());

    app.post(
      "/users",
      {
        schema: {
          body: {
            type: "object",
            required: ["email", "name"],
            properties: { email: { type: "string" }, name: { type: "string" } },
          },
        },
        ajv: { customOptions: { allErrors: true } },
      },
      async () => ({ ok: true })
    );

    const response = await app.inject({
      method: "POST",
      url: "/users",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(400);
    const fields = response.json().error.fields;
    // Ajv reports the first missing property only, but it must be keyed by the
    // property name rather than folded into a `required` bucket.
    expect(fields["/email"]).toBeDefined();
    expect(fields.required).toBeUndefined();
    expect(Object.keys(fields)).toEqual(["/email"]);
  });

  it("sends the canonical payload for unmatched routes", async () => {
    const app = fastify();
    await registerErrorHandler(app);

    const response = await app.inject({ method: "GET", url: "/does-not-exist" });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.details.method).toBe("GET");
    expect(body.error.details.path).toBe("/does-not-exist");
    expect(body.timestamp).toBeDefined();
    expect(body.path).toBe("/does-not-exist");
    expect(body.requestId).toBeDefined();
    expect(body.error.stack).toBeUndefined();
  });

  it("sends the canonical payload for unmatched routes through the plugin", async () => {
    const app = fastify();
    await app.register(errorHandlerPlugin);

    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("falls back to a canonical payload when the custom handler throws", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler({
      customHandler: async () => { throw new Error("handler exploded"); },
    }));

    app.get("/test", async () => {
      throw new ValidationError("test", {});
    });

    const response = await app.inject({ method: "GET", url: "/test" });
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Error handler failed");
    expect(body.error.stack).toBeUndefined();
  });

  it("does not double-send when the custom handler replies then throws", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler({
      customHandler: async (_error, _request, reply) => {
        reply.status(503).send({ handled: true });
        throw new Error("handler exploded after replying");
      },
    }));

    app.get("/test", async () => {
      throw new ValidationError("test", {});
    });

    const response = await app.inject({ method: "GET", url: "/test" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ handled: true });
  });

  it("uses the custom handler for unmatched routes", async () => {
    const customHandler = vi.fn(async (_error, _request, reply) => {
      reply.status(404).send({ custom: true });
    });
    const app = fastify();
    app.setNotFoundHandler(createNotFoundHandler({ customHandler }));

    const response = await app.inject({ method: "GET", url: "/missing" });
    expect(customHandler).toHaveBeenCalled();
    expect(response.json()).toEqual({ custom: true });
  });

  it("sets a Retry-After header for rate limits", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler({ logErrors: false }));

    app.get("/limited", async () => {
      throw new RateLimitError("Too many requests", 30);
    });

    const response = await app.inject({ method: "GET", url: "/limited" });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
  });

  it("rounds a fractional retryAfter up to a whole second", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler({ logErrors: false }));

    app.get("/limited", async () => {
      throw new RateLimitError("Too many requests", 1.2);
    });

    const response = await app.inject({ method: "GET", url: "/limited" });
    expect(response.headers["retry-after"]).toBe("2");
  });

  it("sets no Retry-After when the error carries no retryAfter", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler({ logErrors: false }));

    app.get("/limited", async () => {
      throw new RateLimitError("Too many requests");
    });

    const response = await app.inject({ method: "GET", url: "/limited" });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("redacts sensitive details when redactDetails is enabled", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler({ logErrors: false, redactDetails: true }));

    app.get("/login", async () => {
      throw new AppError("auth failed", "AUTH_FAILED", 401, {
        email: "user@example.com",
        password: "hunter2",
      });
    });

    const body = (await app.inject({ method: "GET", url: "/login" })).json();
    expect(body.error.details.password).toBe("[REDACTED]");
    expect(body.error.details.email).toBe("user@example.com");
  });

  it("leaves details untouched by default", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler({ logErrors: false }));

    app.get("/login", async () => {
      throw new AppError("auth failed", "AUTH_FAILED", 401, { password: "hunter2" });
    });

    const body = (await app.inject({ method: "GET", url: "/login" })).json();
    expect(body.error.details.password).toBe("hunter2");
  });

  it("logs 4xx at warn and 5xx at error when logOperationalAsWarn is set", async () => {
    const warn = vi.fn();
    const errorLog = vi.fn();
    const handler = createErrorHandler({ logOperationalAsWarn: true });

    const invoke = async (thrown: unknown) => {
      const reply = {
        sent: false,
        statusCode: 0,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        send(payload: unknown) {
          this.payload = payload;
          return this;
        },
      };
      const request = { url: "/x", method: "GET", id: "req-1", log: { warn, error: errorLog } };

      await handler(thrown as never, request as never, reply as never);
    };

    await invoke(new ValidationError("bad", {}));
    await invoke(new InternalError("boom"));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("logs everything at error level by default", async () => {
    const warn = vi.fn();
    const errorLog = vi.fn();
    const handler = createErrorHandler();

    const reply = {
      sent: false,
      statusCode: 0,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      send(payload: unknown) {
        this.payload = payload;
        return this;
      },
    };
    const request = { url: "/x", method: "GET", id: "req-1", log: { warn, error: errorLog } };

    await handler(new ValidationError("bad", {}) as never, request as never, reply as never);

    expect(warn).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("includes timestamp and request info", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler());

    app.get("/test", async () => {
      throw new ValidationError("test", {});
    });

    const response = await app.inject({ method: "GET", url: "/test" });
    const body = response.json();
    expect(body.timestamp).toBeDefined();
    expect(body.path).toBe("/test");
    expect(body.requestId).toBeDefined();
  });

  it("excludes stack by default", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler());

    app.get("/test", async () => {
      throw new ValidationError("test", {});
    });

    const response = await app.inject({ method: "GET", url: "/test" });
    const body = response.json();
    expect(body.error.stack).toBeUndefined();
  });

  it("includes stack when option enabled", async () => {
    const app = fastify();
    app.setErrorHandler(createErrorHandler({ includeStack: true }));

    app.get("/test", async () => {
      throw new ValidationError("test", {});
    });

    const response = await app.inject({ method: "GET", url: "/test" });
    const body = response.json();
    expect(body.error.stack).toBeDefined();
  });

  it("uses custom handler when provided", async () => {
    const customHandler = vi.fn().mockResolvedValue(undefined);
    const app = fastify();
    app.setErrorHandler(createErrorHandler({ customHandler }));

    app.get("/test", async () => {
      throw new ValidationError("test", {});
    });

    await app.inject({ method: "GET", url: "/test" });
    expect(customHandler).toHaveBeenCalled();
  });

  it("registerErrorHandler registers globally", async () => {
    const app = fastify();
    await registerErrorHandler(app);

    app.get("/test", async () => {
      throw new ValidationError("test", {});
    });

    const response = await app.inject({ method: "GET", url: "/test" });
    expect(response.statusCode).toBe(400);
  });

  it("errorHandlerPlugin works as Fastify plugin", async () => {
    const app = fastify();
    await app.register(errorHandlerPlugin, { includeStack: true });

    app.get("/test", async () => {
      throw new ValidationError("test", {});
    });

    const response = await app.inject({ method: "GET", url: "/test" });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.stack).toBeDefined();
  });
});

describe("formatValidationError", () => {
  it("produces the same canonical shape as the handler", () => {
    const error = new ValidationError("Invalid", { email: ["required"], name: ["too short"] });
    const mockRequest = { url: "/test", id: "req-123" } as any;

    const formatted = formatValidationError(error, mockRequest);

    expect(formatted.error).toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      statusCode: 400,
      message: "Invalid",
      fields: { email: ["required"], name: ["too short"] },
    });
    expect((formatted.error as Record<string, unknown>).stack).toBeUndefined();
    expect(formatted.timestamp).toBeDefined();
    expect(formatted.path).toBe("/test");
    expect(formatted.requestId).toBe("req-123");
  });

  it("honours the includeStack and redact options", () => {
    const error = new ValidationError("Invalid", {}, { token: "abc" });
    const mockRequest = { url: "/test", id: "req-1" } as any;

    const withStack = formatValidationError(error, mockRequest, { includeStack: true });
    expect((withStack.error as Record<string, unknown>).stack).toBeDefined();

    const redacted = formatValidationError(error, mockRequest, { redactDetails: true });
    const details = (redacted.error as { details: Record<string, unknown> }).details;
    expect(details.token).toBe("[REDACTED]");
  });
});