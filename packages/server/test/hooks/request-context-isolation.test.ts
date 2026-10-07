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

describe("Request Context Isolation Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("each request receives unique request context", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/context", async (request) => {
          const ctx = request.requestContext;
          ctx.set("requestId", Math.random().toString(36).substring(7));
          return { requestId: ctx.get("requestId") };
        });
      },
    });

    await server.ready();

    const response1 = await server.inject({ method: "GET", url: "/context" });
    const response2 = await server.inject({ method: "GET", url: "/context" });

    const body1 = response1.json();
    const body2 = response2.json();

    expect(body1.requestId).toBeDefined();
    expect(body2.requestId).toBeDefined();
    expect(body1.requestId).not.toEqual(body2.requestId);

    await server.close();
  });

  it("request A cannot see request B context", async () => {
    let contextA: string | undefined;
    let contextB: string | undefined;

    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/set-a", async (request) => {
          const ctx = request.requestContext;
          ctx.set("requestId", "A");
          // Simulate async work
          await new Promise((resolve) => setTimeout(resolve, 10));
          contextA = ctx.get("requestId");
          return { ok: true };
        });

        app.get("/set-b", async (request) => {
          const ctx = request.requestContext;
          ctx.set("requestId", "B");
          // Simulate async work
          await new Promise((resolve) => setTimeout(resolve, 10));
          contextB = ctx.get("requestId");
          return { ok: true };
        });
      },
    });

    await server.ready();

    // Make concurrent requests
    await Promise.all([
      server.inject({ method: "GET", url: "/set-a" }),
      server.inject({ method: "GET", url: "/set-b" }),
    ]);

    expect(contextA).toBe("A");
    expect(contextB).toBe("B");

    await server.close();
  });

  it("context leakage detection across concurrent requests", async () => {
    const results: Array<{ id: string; contextValue: string }> = [];

    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/leak-test/:id", async (request) => {
          const ctx = request.requestContext;
          const id = request.params.id;
          ctx.set("testValue", id);
          
          // Simulate async operations
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 50));
          
          const value = ctx.get("testValue");
          results.push({ id, contextValue: value as string });
          
          return { id, contextValue: value };
        });
      },
    });

    await server.ready();

    // Fire multiple concurrent requests
    const promises = [
      server.inject({ method: "GET", url: "/leak-test/1" }),
      server.inject({ method: "GET", url: "/leak-test/2" }),
      server.inject({ method: "GET", url: "/leak-test/3" }),
      server.inject({ method: "GET", url: "/leak-test/4" }),
      server.inject({ method: "GET", url: "/leak-test/5" }),
    ];

    await Promise.all(promises);

    // Verify no leakage - each request should have its own value
    for (const result of results) {
      expect(result.contextValue).toBe(result.id);
    }

    await server.close();
  });

  it("stores requestId without leaking", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/request-id", async (request) => {
          const ctx = request.requestContext;
          ctx.set("requestId", "test-request-id");
          return { requestId: ctx.get("requestId") };
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/request-id" });
    expect(response.json().requestId).toBe("test-request-id");
    await server.close();
  });

  it("stores userId without leaking", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/user-id", async (request) => {
          const ctx = request.requestContext;
          ctx.set("userId", "user-123");
          return { userId: ctx.get("userId") };
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/user-id" });
    expect(response.json().userId).toBe("user-123");
    await server.close();
  });

  it("stores sessionId without leaking", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/session-id", async (request) => {
          const ctx = request.requestContext;
          ctx.set("sessionId", "session-abc");
          return { sessionId: ctx.get("sessionId") };
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/session-id" });
    expect(response.json().sessionId).toBe("session-abc");
    await server.close();
  });

  it("stores traceId without leaking", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/trace-id", async (request) => {
          const ctx = request.requestContext;
          ctx.set("traceId", "trace-xyz");
          return { traceId: ctx.get("traceId") };
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/trace-id" });
    expect(response.json().traceId).toBe("trace-xyz");
    await server.close();
  });

  it("stores locale without leaking", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/locale", async (request) => {
          const ctx = request.requestContext;
          ctx.set("locale", "en-US");
          return { locale: ctx.get("locale") };
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/locale" });
    expect(response.json().locale).toBe("en-US");
    await server.close();
  });

  it("context persists across async boundaries", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      configure: (app) => {
        app.get("/async-context", async (request) => {
          const ctx = request.requestContext;
          ctx.set("value", "initial");
          
          await Promise.resolve();
          expect(ctx.get("value")).toBe("initial");
          
          await new Promise((resolve) => setTimeout(resolve, 10));
          expect(ctx.get("value")).toBe("initial");
          
          ctx.set("value", "updated");
          await Promise.resolve();
          expect(ctx.get("value")).toBe("updated");
          
          return { value: ctx.get("value") };
        });
      },
    });

    await server.ready();
    const response = await server.inject({ method: "GET", url: "/async-context" });
    expect(response.json().value).toBe("updated");
    await server.close();
  });
});