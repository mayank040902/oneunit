import { startServer } from "@oneunit/server";

const { address, close } = await startServer({
  serviceName: "example-service-js",
  host: "127.0.0.1",
  port: 0,
  logger: false,
  gracefulShutdown: false,
  configure: async (app) => {
    app.get("/", async () => {
      return {
        message: "Hello from @oneunit/server (js)",
      };
    });
  },
});

// await close();
console.log("js basic example completed");
