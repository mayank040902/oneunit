import type { HealthProvider, HealthCheckResult } from "./types.js";

export function createHealthProvider(
    name: string,
    check: () => HealthCheckResult | Promise<HealthCheckResult>,
    critical = false,
): HealthProvider {
    return { name, check, critical };
}

export function createDatabaseHealthProvider(
    check: () => Promise<unknown>,
    critical = false,
): HealthProvider {
    return createHealthProvider("database", async () => {
        await check();
        return { status: "healthy" };
    }, critical);
}

export function createRedisHealthProvider(
    check: () => Promise<unknown>,
    critical = false,
): HealthProvider {
    return createHealthProvider("redis", async () => {
        await check();
        return { status: "healthy" };
    }, critical);
}

export function createKafkaHealthProvider(
    check: () => Promise<unknown>,
    critical = false,
): HealthProvider {
    return createHealthProvider("kafka", async () => {
        await check();
        return { status: "healthy" };
    }, critical);
}