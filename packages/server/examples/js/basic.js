import { startServer } from "@oneunit/server";

startServer({
  serviceName: "api",
  logger: true,
  gracefulShutdown: true,
  port: 8080,
  database: false,
  kafka: false,
  redis: false,
  realtime: false,
});
