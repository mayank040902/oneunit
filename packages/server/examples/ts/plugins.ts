import { startServer } from "@oneunit/server";

const { close } = await startServer({
  serviceName: "api",
  logger: true,
  gracefulShutdown: true,
  port: 8080,
  cors: { origin: ["http://localhost:5173"], credentials: true },
  compress: { threshold: 1024 },
  rateLimit: { max: 100, timeWindow: "1 minute" },
  helmet: false,
  database: false,
  kafka: false,
  redis: false,
  configure(app) {
    app.get("/", async () => ({ status: "ok" }));
  },
});
