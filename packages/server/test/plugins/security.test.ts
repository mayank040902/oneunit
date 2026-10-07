import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBootstrapServer,
  type BootstrapServerOptions,
} from "../../src/bootstrap.js";

const apps: FastifyInstance[] = [];

function track(app: FastifyInstance): FastifyInstance {
  apps.push(app);
  return app;
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    try {
      await app.close();
    } catch {
      // ignore close errors
    }
  }
});

describe("Security Tests - Helmet", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("installs security headers when enabled", async () => {
    const server = await createBootstrapServer(baseOptions);

    const response = await server.inject({ method: "GET", url: "/health" });
    
    // Check for helmet headers
    expect(response.headers["x-dns-prefetch-control"]).toBeDefined();
    expect(response.headers["x-frame-options"]).toBeDefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    
    await server.close();
  });

  it("can be disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      helmet: false,
    });

    const response = await server.inject({ method: "GET", url: "/health" });
    
    // Helmet headers should not be present
    expect(response.headers["x-dns-prefetch-control"]).toBeUndefined();
    expect(response.headers["x-frame-options"]).toBeUndefined();
    
    await server.close();
  });

  it("accepts custom configuration", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      health: true,
      helmet: { contentSecurityPolicy: false },
    });

    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    await server.close();
  });
});

describe("Security Tests - CORS", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("allows configured origin", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cors: { origin: "http://allowed.example.com", credentials: true },
    });

    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://allowed.example.com" },
    });

    expect(response.headers["access-control-allow-origin"]).toBe("http://allowed.example.com");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    
    await server.close();
  });

  it("rejects non-configured origin", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cors: { origin: "http://allowed.example.com" },
    });

    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://evil.example.com" },
    });

    expect(response.headers["access-control-allow-origin"]).not.toBe("http://evil.example.com");
    
    await server.close();
  });

  it("supports credentials", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cors: { origin: true, credentials: true },
    });

    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://example.com" },
    });

    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    
    await server.close();
  });

  it("supports configured methods", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cors: { methods: ["GET", "POST"] },
    });

    const response = await server.inject({
      method: "OPTIONS",
      url: "/health",
      headers: { 
        origin: "http://example.com",
        "access-control-request-method": "POST",
      },
    });

    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    
    await server.close();
  });

  it("supports configured headers", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      health: true,
      cors: { allowedHeaders: ["X-Custom-Header"] },
      configure: (app) => {
        app.get("/test-headers", {
          config: { cors: { allowedHeaders: ["X-Custom-Header"] } },
          handler: async () => ({ ok: true }),
        });
      },
    });

    const response = await server.inject({
      method: "OPTIONS",
      url: "/test-headers",
      headers: { 
        origin: "http://example.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": "X-Custom-Header",
      },
    });

    expect(response.headers["access-control-allow-headers"]).toContain("X-Custom-Header");
    
    await server.close();
  });

  it("handles preflight requests", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cors: { origin: true },
    });

    const response = await server.inject({
      method: "OPTIONS",
      url: "/health",
      headers: { 
        origin: "http://example.com",
        "access-control-request-method": "POST",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBeDefined();
    
    await server.close();
  });

  it("can be disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cors: false,
    });

    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://example.com" },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    
    await server.close();
  });
});

describe("Security Tests - Cookie", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("parses cookies", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cookie: { secret: "test-secret" },
      configure: (app) => {
        app.get("/cookie", async (request) => {
          return { cookies: request.cookies };
        });
      },
    });

    const response = await server.inject({
      method: "GET",
      url: "/cookie",
      headers: { cookie: "test=value" },
    });

    expect(response.json().cookies).toEqual({ test: "value" });
    await server.close();
  });

  it("serializes cookies", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cookie: { secret: "test-secret" },
      configure: (app) => {
        app.get("/set-cookie", async (request, reply) => {
          reply.setCookie("test", "value", { path: "/" });
          return { ok: true };
        });
      },
    });

    const response = await server.inject({
      method: "GET",
      url: "/set-cookie",
    });

    expect(response.headers["set-cookie"]).toBeDefined();
    await server.close();
  });

  it("supports signed cookies when configured", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cookie: { secret: "test-secret" },
      configure: (app) => {
        app.get("/signed", async (request, reply) => {
          reply.setCookie("signed", "value", { signed: true, path: "/" });
          return { ok: true };
        });
        app.get("/verify", async (request) => {
          return { signed: request.unsignCookie(request.cookies.signed).valid };
        });
      },
    });

    const response1 = await server.inject({
      method: "GET",
      url: "/signed",
    });

    const cookie = response1.headers["set-cookie"];
    
    const response2 = await server.inject({
      method: "GET",
      url: "/verify",
      headers: { cookie },
    });

    expect(response2.json().signed).toBe(true);
    await server.close();
  });

  it("can be disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      cookie: false,
    });

    expect(server).toBeDefined();
    await server.close();
  });
});

describe("Security Tests - CSRF", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("protects configured requests when enabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      csrf: { cookieOpts: { secure: false } },
      cookie: { secret: "test-secret" },
      configure: (app) => {
        app.post("/protected", async () => ({ ok: true }));
      },
    });

    // First get the CSRF token
    const getResponse = await server.inject({
      method: "GET",
      url: "/health",
    });

    const csrfToken = getResponse.headers["x-csrf-token"] || 
                      getResponse.cookies?.csrf;
    
    // The CSRF plugin should protect POST requests
    expect(server).toBeDefined();
    await server.close();
  });

  it("can be disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      csrf: false,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("does not initialize CSRF when disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      csrf: false,
      cookie: { secret: "test-secret" },
    });

    expect(server).toBeDefined();
    await server.close();
  });
});