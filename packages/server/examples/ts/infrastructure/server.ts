import { startServer } from "@oneunit/server";

const { address, close } = await startServer({
  serviceName: "infrastructure-example",
  host: "127.0.0.1",
  port: 0,
  logger: false,
  gracefulShutdown: false,
  database: false,
  redis: false,
  kafka: false,
  realtime: false,
  configure: async () => {
    console.log("infrastructure disabled by default in example");
  },
});

await close();
console.log("infrastructure example completed");
