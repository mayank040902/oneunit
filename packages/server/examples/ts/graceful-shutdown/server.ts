import { startServer } from "@oneunit/server";

const { close } = await startServer({
  serviceName: "graceful-shutdown-example",
  host: "127.0.0.1",
  port: 0,
  logger: false,
  gracefulShutdown: true,
  configure: async () => {
    console.log("graceful shutdown enabled (opt-in)");
  },
});

await close();
console.log("shutdown complete");
