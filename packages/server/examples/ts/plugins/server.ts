import type { FastifyInstance } from "fastify";
import { startServer } from "@oneunit/server";

async function helloPlugin(server: FastifyInstance) {
  server.decorate("hello", () => "world");
  server.get("/plugin", async () => ({
    hello: server.hello(),
  }));
}

const { address, close } = await startServer({
  serviceName: "plugin-example",
  host: "127.0.0.1",
  port: 0,
  logger: false,
  gracefulShutdown: false,
  plugins: [helloPlugin],
  configure: async (app) => {
    app.get("/", async () => ({ status: "ok" }));
  },
});

await close();
console.log("plugin example completed");
