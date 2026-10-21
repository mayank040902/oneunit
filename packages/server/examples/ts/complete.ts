import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { startServer, type BootstrapServerOptions } from "@oneunit/server";

declare module "fastify" {
  interface FastifyInstance {
    exampleService?: { greeting(name: string): string };
  }
}

async function examplePlugin(server: FastifyInstance): Promise<void> {
  server.decorate("exampleService", {
    greeting: (name: string) => `hello, ${name}`,
  });
  server.get("/plugin", async () => ({
    message: server.exampleService?.greeting("world") ?? "no plugin",
  }));
}

const options: BootstrapServerOptions = {
  serviceName: "complete-example",
  host: "127.0.0.1",
  port: 0,
  logger: false,
  env: false,
  gracefulShutdown: false,
  shutdownTimeout: 2000,
  health: { path: "/health", includeDetails: true },
  cors: { origin: ["http://localhost:5173"], credentials: true },
  helmet: { contentSecurityPolicy: false },
  rateLimit: { max: 10, timeWindow: "1 minute" },
  responseManagement: {
    defaultSuccessMessage: "Success",
    defaultErrorMessage: "Request failed",
    includeRequestId: true,
  },
  plugins: [examplePlugin],
  hooks: {
    onRequest: [
      async (request: FastifyRequest) => {
        request.log?.info?.({ method: request.method, url: request.url }, "incoming request");
      },
    ],
    preHandler: [
      async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header("X-Example", "complete");
      },
    ],
  },
  configure: async (app: FastifyInstance) => {
    app.get("/", async () => ({ status: "ok" }));

    app.get("/health-demo", async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.ok({ data: { service: "complete-example" } });
    });

    app.post(
      "/echo",
      {
        schema: {
          body: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
      async (request: FastifyRequest<{ Body: { name: string } }>) => {
        return { echoed: request.body.name };
      },
    );

    app.get("/not-found-demo", async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.notFound({ message: "Resource does not exist" });
    });

    app.get("/created-demo", async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.created({ data: { id: 1 } });
    });
  },
};

async function main(): Promise<void> {
  const { app, address, port, host, close } = await startServer(options);
  await app.ready();

  console.log(`complete example listening at ${address} (host=${host}, port=${port})`);

  const root = await app.inject({ method: "GET", url: "/" });
  console.log("GET / ->", root.statusCode, root.json());

  const health = await app.inject({ method: "GET", url: "/health" });
  console.log("GET /health ->", health.statusCode, health.json());

  const plugin = await app.inject({ method: "GET", url: "/plugin" });
  console.log("GET /plugin ->", plugin.statusCode, plugin.json());

  const created = await app.inject({ method: "GET", url: "/created-demo" });
  console.log("GET /created-demo ->", created.statusCode, created.json());

  const missing = await app.inject({ method: "GET", url: "/not-found-demo" });
  console.log("GET /not-found-demo ->", missing.statusCode, missing.json());

  await close();
  console.log("complete example finished");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
