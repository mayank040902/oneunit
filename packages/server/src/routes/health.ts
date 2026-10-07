import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { createHealthRoute, getHealthRegistry } from "../health/index.js";
import { getSystemInfo } from "../lib/system.js";
import type { HealthCheckResult } from "../health/types.js";

export interface HealthRouteOptions {
    path?: string;
    serviceName?: string;
    checks?: Record<string, HealthCheckResult> | HealthCheckProvider;
}

export type HealthCheckProvider = (server: FastifyInstance) => Record<string, HealthCheckResult> | Promise<Record<string, HealthCheckResult>>;

export type BootstrapHealthOptions = HealthRouteOptions;

function convertToProviders(server: FastifyInstance, checks: Record<string, HealthCheckResult | { status: boolean }>): ReturnType<typeof getHealthRegistry> {
    const registry = getHealthRegistry(server);
    for (const [name, result] of Object.entries(checks)) {
        const status = "status" in result && typeof result.status === "boolean"
            ? (result.status ? "healthy" : "unhealthy")
            : result.status;
        registry.register({
            name,
            check: () => ({ ...result, status }),
            critical: true,
        });
    }
    return registry;
}

export function createHealthPlugin(options: HealthRouteOptions = {}): FastifyPluginAsync {
    const { path = "/health", serviceName = "app", checks = {}, includeDetails = false } = options;

    return async (server: FastifyInstance) => {
        let registry: ReturnType<typeof getHealthRegistry>;

        if (typeof checks === "function") {
            const resolvedChecks = await checks(server);
            registry = convertToProviders(server, resolvedChecks);
        } else {
            registry = convertToProviders(server, checks);
        }

        await server.register(createHealthRoute(registry, { path, serviceName, includeDetails }));
    };
}