import type { FastifyRequest, FastifyReply } from "fastify";
import { startServer } from "@oneunit/server";

const { address, close } = await startServer({
  serviceName: "hooks-example",
  host: "127.0.0.1",
  port: 0,
  logger: false,
  gracefulShutdown: false,
  hooks: {
    onRequest: [
      async (request: FastifyRequest) => {
        request.log.debug({ method: request.method, url: request.url }, "incoming request");
      },
    ],
    preHandler: [
      async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("X-Example", "true");
      },
    ],
  },
  configure: async (app) => {
    app.get("/", async () => ({ status: "ok" }));
  },
});

await close();
console.log("hooks example completed");
