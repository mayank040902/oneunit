import { startServer } from "@oneunit/server";

const { address, close } = await startServer({
  serviceName: "health-example",
  host: "127.0.0.1",
  port: 0,
  logger: false,
  gracefulShutdown: false,
  configure: async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
    });
    console.log(`health status: ${res.statusCode}`);
  },
});

await close();
