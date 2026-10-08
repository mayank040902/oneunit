import { startServer } from "@oneunit/server";
import type { FastifyRequest, FastifyReply } from "fastify";

const { address, close } = await startServer({
  serviceName: "api",
  logger: true,
  gracefulShutdown: true,
  port: 8080,
  hooks: {
    onRequest: [
      async (request: FastifyRequest, reply: FastifyReply) => {
        request.log.info({ method: request.method, url: request.url }, "incoming request");
      },
    ],
    preHandler: [
      async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header("X-Request-Id", request.id);
      },
    ],
    onSend: [
      async (request: FastifyRequest, reply: FastifyReply, payload) => {
        return payload;
      },
    ],
  },
  configure(app) {
    app.get("/hooks", async (request: FastifyRequest) => ({
      requestId: request.id,
    }));
  },
});

console.log(`listening at ${address}`);
