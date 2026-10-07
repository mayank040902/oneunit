import type { FastifyInstance } from "fastify";
import { createHealthRegistry, type HealthRegistry } from "./registry.js";

declare module "fastify" {
    interface FastifyInstance {
        healthRegistry: HealthRegistry;
    }
}

export function registerHealthRegistry(server: FastifyInstance): HealthRegistry {
    const registry = createHealthRegistry();
    server.decorate("healthRegistry", registry);
    return registry;
}

export function getHealthRegistry(server: FastifyInstance): HealthRegistry {
    return server.healthRegistry;
}

export { createHealthRegistry } from "./registry.js";
export { createHealthRoute } from "./route.js";
export { createHealthProvider, createDatabaseHealthProvider, createRedisHealthProvider, createKafkaHealthProvider } from "./provider.js";
export { registerSystemHealthProvider } from "../plugins/core/system-health.js";

export type {
    HealthStatus,
    HealthCheckResult,
    HealthCheck,
    HealthProvider,
    HealthRegistry,
    HealthRouteOptions,
} from "./types.js";