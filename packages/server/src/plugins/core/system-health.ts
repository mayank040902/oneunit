import type { FastifyInstance } from "fastify";
import { getHealthRegistry } from "../../health/index.js";
import { getSystemInfo } from "../../lib/system.js";
import { getSystemStatus, DEFAULT_THRESHOLDS, type SystemMetrics, type SystemThresholds } from "../../lib/system-status.js";

export interface SystemHealthOptions {
    disabled?: boolean;
    thresholds?: SystemThresholds;
}

export function registerSystemHealthProvider(server: FastifyInstance, options: SystemHealthOptions = {}): void {
    if (options.disabled) {
        return;
    }

    const registry = getHealthRegistry(server);

    // In test environments, use more lenient thresholds to avoid false "degraded" status
    const isTestEnv = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    const testThresholds: SystemThresholds = {
        memory: {
            degraded: 95,
            unhealthy: 98,
        },
        load: {
            degraded: 10,
            unhealthy: 20,
        },
    };

    const effectiveThresholds = options.thresholds ?? (isTestEnv ? testThresholds : DEFAULT_THRESHOLDS);

    registry.register({
        name: "system",
        check: async () => {
            const systemInfo = getSystemInfo();
            const systemMetrics: SystemMetrics = {
                memory: {
                    usagePercent: systemInfo.memory.usagePercent,
                },
                cpu: {
                    cores: systemInfo.cpu.cores,
                    loadAverage: {
                        oneMinute: systemInfo.cpu.loadAverage.oneMinute,
                    },
                },
            };

            const checks: Record<string, { status: boolean; latency?: number; message?: string }> = {};
            const status = getSystemStatus(systemMetrics, checks, effectiveThresholds);

            return {
                status,
                details: systemInfo,
            };
        },
        critical: false,
    });
}