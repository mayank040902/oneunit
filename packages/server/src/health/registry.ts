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
            const entries = Array.from(providers.values());

            // The checks run in parallel: the endpoint answers in the time of
            // the slowest provider instead of the sum of all of them. A slow
            // dependency must not delay the answer of the others.
            const results = await Promise.all(
                entries.map(async (provider) => {
                    const start = process.hrtime.bigint();
                    try {
                        const result = await provider.check();
                        const end = process.hrtime.bigint();
                        return [
                            provider.name,
                            {
                                ...result,
                                latency: Number(end - start) / 1_000_000,
                            },
                        ] as const;
                    } catch (err) {
                        const end = process.hrtime.bigint();
                        return [
                            provider.name,
                            {
                                status: "unhealthy" as const,
                                latency: Number(end - start) / 1_000_000,
                                message: err instanceof Error ? err.message : "Health check failed",
                            },
                        ] as const;
                    }
                }),
            );

            return Object.fromEntries(results);
        },
    };
}

export type { HealthRegistry } from "./types.js";