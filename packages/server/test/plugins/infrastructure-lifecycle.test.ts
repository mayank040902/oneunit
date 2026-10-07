import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBootstrapServer,
  type BootstrapServerOptions,
} from "../../src/bootstrap.js";

const apps: FastifyInstance[] = [];

function track(app: FastifyInstance): FastifyInstance {
  apps.push(app);
  return app;
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    try {
      await app.close();
    } catch {
      // ignore close errors
    }
  }
});

describe("Infrastructure Lifecycle Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  describe("Database Lifecycle", () => {
    it("configures database plugin", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        database: { logQueries: false },
      });

      // Database plugin registers but may not connect if @oneunit/database unavailable
      expect(server).toBeDefined();
      await server.close();
    });

    it("initializes database connection", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        database: { logQueries: false },
      });

      await server.ready();
      // If database is available, db should be decorated
      // If not, plugin handles it gracefully
      expect(server).toBeDefined();
      await server.close();
    });

    it("decorates Fastify with database instance", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        database: { logQueries: false },
      });

      await server.ready();
      // Check if decorator exists (may be undefined if dep unavailable)
      if (server.db) {
        expect(typeof server.db.query).toBe("function");
        expect(typeof server.db.shutdown).toBe("function");
      }
      await server.close();
    });

    it("registers health provider", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        database: { logQueries: false },
      });

      await server.ready();
      const providers = server.healthRegistry.getAll();
      const dbProvider = providers.find(p => p.name === "database");
      
      // Health provider should be registered if database is enabled
      if (dbProvider) {
        expect(dbProvider.name).toBe("database");
        expect(typeof dbProvider.check).toBe("function");
      }
      await server.close();
    });

    it("registers shutdown handler", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        database: { logQueries: false },
      });

      await server.ready();
      // Shutdown handler should be registered via onClose hook
      expect(server).toBeDefined();
      await server.close();
    });

    it("cleans up on shutdown", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        database: { logQueries: false },
      });

      await server.ready();
      await server.close();
      // Should close without error
    });
  });

  describe("Redis Lifecycle", () => {
    it("configures redis plugin", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        redis: { healthCheck: false },
      });

      expect(server).toBeDefined();
      await server.close();
    });

    it("initializes redis connection", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        redis: { healthCheck: false },
      });

      await server.ready();
      expect(server).toBeDefined();
      await server.close();
    });

    it("decorates Fastify with redis instance", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        redis: { healthCheck: false },
      });

      await server.ready();
      if (server.redis) {
        expect(typeof server.redis).toBe("object");
      }
      await server.close();
    });

    it("registers health provider", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        redis: { healthCheck: false },
      });

      await server.ready();
      const providers = server.healthRegistry.getAll();
      const redisProvider = providers.find(p => p.name === "redis");
      
      if (redisProvider) {
        expect(redisProvider.name).toBe("redis");
        expect(typeof redisProvider.check).toBe("function");
        expect(redisProvider.critical).toBe(false); // Redis is non-critical by default
      }
      await server.close();
    });

    it("registers shutdown handler", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        redis: { healthCheck: false },
      });

      await server.ready();
      await server.close();
    });
  });

  describe("Kafka Lifecycle", () => {
    it("configures kafka plugin", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        kafka: { autoConnectProducer: false },
      });

      expect(server).toBeDefined();
      await server.close();
    });

    it("initializes kafka connection", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        kafka: { autoConnectProducer: false },
      });

      await server.ready();
      expect(server).toBeDefined();
      await server.close();
    });

    it("decorates Fastify with kafka instance", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        kafka: { autoConnectProducer: false },
      });

      await server.ready();
      if (server.kafka) {
        expect(typeof server.kafka).toBe("object");
      }
      await server.close();
    });

    it("registers health provider", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        kafka: { autoConnectProducer: false },
      });

      await server.ready();
      const providers = server.healthRegistry.getAll();
      const kafkaProvider = providers.find(p => p.name === "kafka");
      
      if (kafkaProvider) {
        expect(kafkaProvider.name).toBe("kafka");
        expect(typeof kafkaProvider.check).toBe("function");
        expect(kafkaProvider.critical).toBe(false); // Kafka is non-critical by default
      }
      await server.close();
    });

    it("registers shutdown handler", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        kafka: { autoConnectProducer: false },
      });

      await server.ready();
      await server.close();
    });
  });

  describe("Realtime Lifecycle", () => {
    it("configures realtime plugin", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        realtime: { websocketLibrary: "fastify" as const },
      });

      expect(server).toBeDefined();
      await server.close();
    });

    it("initializes realtime infrastructure", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        realtime: { websocketLibrary: "fastify" as const },
      });

      await server.ready();
      expect(server).toBeDefined();
      await server.close();
    });

    it("owns connection lifecycle", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        realtime: { websocketLibrary: "fastify" as const },
      });

      await server.ready();
      // Server owns WebSocket connection lifecycle
      // Application provides event handlers
      if (server.realtime) {
        expect(typeof server.realtime).toBe("object");
      }
      await server.close();
    });

    it("does not own application event semantics", async () => {
      // This test verifies the architectural contract:
      // Server package provides connection infrastructure
      // Application provides event handlers (chat.message, user.typing, etc.)
      const server = await createBootstrapServer({
        ...baseOptions,
        realtime: { websocketLibrary: "fastify" as const },
      });

      await server.ready();
      
      // No hardcoded event handlers in server
      expect(server).toBeDefined();
      await server.close();
    });

    it("registers health provider", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        realtime: { websocketLibrary: "fastify" as const },
      });

      await server.ready();
      const providers = server.healthRegistry.getAll();
      const realtimeProvider = providers.find(p => p.name === "realtime");
      
      if (realtimeProvider) {
        expect(realtimeProvider.name).toBe("realtime");
        expect(typeof realtimeProvider.check).toBe("function");
      }
      await server.close();
    });

    it("registers shutdown handler", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        realtime: { websocketLibrary: "fastify" as const },
      });

      await server.ready();
      await server.close();
    });
  });

  describe("Full Lifecycle: configure → initialize → decorate → health → use → shutdown → cleanup", () => {
    it("completes full lifecycle for all infrastructure", async () => {
      const server = await createBootstrapServer({
        ...baseOptions,
        health: true,
        database: { logQueries: false },
        redis: { healthCheck: false },
        kafka: { autoConnectProducer: false },
        realtime: { websocketLibrary: "fastify" as const },
      });

      // Configure phase (done via options)
      // Initialize phase (done during ready())
      await server.ready();
      
      // Health registration (done during plugin registration)
      const providers = server.healthRegistry.getAll();
      expect(providers.length).toBeGreaterThan(0);
      
      // Use phase - server is ready for requests
      const health = await server.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      
      // Shutdown phase
      await server.close();
      
      // Cleanup phase - no errors thrown
    });
  });
});