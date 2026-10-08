import { startServer } from "@oneunit/server";

const { address, close } = await startServer({
  serviceName: "configure-example",
  host: "127.0.0.1",
  port: 0,
  logger: false,
  gracefulShutdown: false,
  configure: async (app) => {
    app.get("/hello", async () => {
      return {
        message: "hello",
      };
    });
  },
});

await close();
console.log("configure example completed");
