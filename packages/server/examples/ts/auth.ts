import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { startServer } from "@oneunit/server";

async function authPlugin(server: FastifyInstance) {
  server.decorate("userService", {
    async authenticate(token: string) {
      if (token === "valid-token") {
        return { id: 1, name: "user" };
      }
      return null;
    },
  });
}

const { address } = await startServer({
  serviceName: "auth-server",
  logger: true,
  gracefulShutdown: true,
  port: 8080,
  plugins: [
    authPlugin,
    {
      plugin: async (server: FastifyInstance) => {
        server.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
          const header = request.headers.authorization;
          if (header && header.startsWith("Bearer ")) {
            const user = await server.userService.authenticate(header.substring(7));
            if (!user) {
              reply.code(401).send({ error: "Invalid token" });
            }
          }
        });
      },
    },
  ],
  configure(app) {
    app.get("/profile", async (request: FastifyRequest, reply: FastifyReply) => {
      const header = request.headers.authorization;
      if (header && header.startsWith("Bearer ")) {
        const user = header.substring(7);
        return { user };
      }
      reply.code(401).send({ error: "No token provided" });
      return null;
    });
  },
});

console.log(`listening at ${address}`);
