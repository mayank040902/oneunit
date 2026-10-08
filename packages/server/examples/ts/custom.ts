import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { startServer } from "@oneunit/server";

async function authPlugin(server: FastifyInstance) {
  server.decorate("auth", {
    check: (request: FastifyRequest, reply: FastifyReply) => {
      const token = request.headers.authorization;
      if (!token) {
        reply.code(401).send({ error: "Missing authorization header" });
        return false;
      }
      return true;
    },
  });

  server.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (reply.request.headers.authorization) {
      request.log = server.log;
    }
  });
}

const { address, close } = await startServer({
  serviceName: "api",
  logger: true,
  gracefulShutdown: true,
  port: 8080,
  plugins: [authPlugin],
  configure(app) {
    app.get(
      "/protected",
      {
        preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
          const auth = app.auth;
          if (!auth || !auth.check(request, reply)) {
            return reply.code(401).send({ error: "Unauthorized" });
          }
        },
      },
      async (request: FastifyRequest) => {
        return { authenticated: true };
      },
    );
  },
});

console.log(`listening at ${address}`);
