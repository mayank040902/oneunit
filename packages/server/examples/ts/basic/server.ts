import { startServer } from "@oneunit/server";

const { address, close } = await startServer({
  serviceName: "example-service",
  host: "127.0.0.1",
  port: 0,
  logger: false,
  gracefulShutdown: true,
  configure: async (app) => {
    app.get("/", async () => {
      return {
        message: "Hello from @oneunit/server",
      };
    });
  },
});

console.log(`listening at ${address}`);
await close();
