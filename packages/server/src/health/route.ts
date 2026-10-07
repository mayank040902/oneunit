import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { HealthRegistry, HealthRouteOptions } from "./types.js";

export function createHealthRoute(registry: HealthRegistry, options: HealthRouteOptions = {}): FastifyPluginAsync {
    const { path = "/health", serviceName = "app", includeDetails = false } = options;

    return async (server: FastifyInstance) => {
        server.get(path, async (_request, reply) => {
            const checks = await registry.checkAll();

            let overallStatus: "healthy" | "degraded" | "unhealthy" = "healthy";
            let hasCriticalFailure = false;

            for (const [name, result] of Object.entries(checks)) {
                const provider = registry.getAll().find((p) => p.name === name);
                if (provider?.critical && result.status === "unhealthy") {
                    hasCriticalFailure = true;
                    overallStatus = "unhealthy";
                } else if (result.status === "unhealthy") {
                    overallStatus = "unhealthy";
                } else if (result.status === "degraded" && overallStatus === "healthy") {
                    overallStatus = "degraded";
                }
            }

            const response = {
                service: serviceName,
                status: overallStatus,
                timestamp: new Date().toISOString(),
                checks: includeDetails ? checks : Object.fromEntries(
                    Object.entries(checks).map(([key, value]) => [key, { status: value.status }])
                ),
            };

            if (hasCriticalFailure) {
                reply.code(503);
            } else {
                reply.code(200);
            }

            return response;
        });

        if (includeDetails) {
            server.get(`${path}/details`, async () => {
                const checks = await registry.checkAll();
                return { checks };
            });
        }
    };
}