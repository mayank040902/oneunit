import { startServer } from "@oneunit/server";

const { address, close } = await startServer(8000, {
  serviceName: "api",
  logger: true,
  gracefulShutdown: true,
  database: false,
  kafka: false,
  redis: false,
  realtime: false,
});

console.log(`listening at ${address}`);
