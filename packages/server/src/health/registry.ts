import type { HealthProvider, HealthRegistry, HealthCheckResult } from "./types.js";

export function createHealthRegistry(): HealthRegistry {
    const providers = new Map<string, HealthProvider>();

    return {
        register(provider: HealthProvider): void {
            providers.set(provider.name, provider);
        },

        unregister(name: string): void {
            providers.delete(name);
        },

        getAll(): HealthProvider[] {
            return Array.from(providers.values());
        },

        async checkAll(): Promise<Record<string, HealthCheckResult>> {
            const results: Record<string, HealthCheckResult> = {};

            for (const provider of providers.values()) {
                const start = process.hrtime.bigint();
                try {
                    const result = await provider.check();
                    const end = process.hrtime.bigint();
                    results[provider.name] = {
                        ...result,
                        latency: Number(end - start) / 1_000_000,
                    };
                } catch (err) {
                    const end = process.hrtime.bigint();
                    results[provider.name] = {
                        status: "unhealthy",
                        latency: Number(end - start) / 1_000_000,
                        message: err instanceof Error ? err.message : "Health check failed",
                    };
                }
            }

            return results;
        },
    };
}

export type { HealthRegistry } from "./types.js";