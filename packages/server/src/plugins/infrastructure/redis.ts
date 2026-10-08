import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { getHealthRegistry, createRedisHealthProvider } from "../../health/index.js";

export interface RedisPluginOptions {
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    lazyConnect?: boolean;
    maxRetriesPerRequest?: number;
    retryStrategy?: (times: number) => number | Error | null;
    enableReadyCheck?: boolean;
    enableOfflineQueue?: boolean;
    connectTimeout?: number;
    healthCheck?: boolean;
    healthCheckPath?: string;
    [key: string]: unknown;
}

declare module "fastify" {
    interface FastifyInstance {
        redis: unknown;
    }
}

async function redisPlugin(
    server: FastifyInstance,
    options: RedisPluginOptions = {},
): Promise<void> {
    let createClient: (options: RedisPluginOptions, logger?: unknown) => unknown;
    let health: (client: unknown, options?: { timeout?: number }) => Promise<{ status: "up" | "down"; latency: { value: number; unit: "ms" }; error?: string }>;
    let shutdown: (client: unknown | null | undefined, logger?: unknown) => Promise<void>;

    try {
        const redisModule = await import("@oneunit/redis") as {
            createClient: typeof createClient;
            health: typeof health;
            shutdown: typeof shutdown;
        };
        createClient = redisModule.createClient;
        health = redisModule.health;
        shutdown = redisModule.shutdown;
    } catch (err) {
        server.log?.warn?.({ err }, "redis package not installed, skipping redis plugin");
        return;
    }

    const {
        healthCheck = false,
        healthCheckPath = "/health/redis",
        ...clientOptions
    } = options;

    const client = createClient(clientOptions, server.log);

    server.decorate("redis", client);

    // Register health check
    const registry = getHealthRegistry(server);
    registry.register(createRedisHealthProvider(
        async () => {
            await health(client);
        },
        false, // Redis is not critical by default
    ));

    if (healthCheck) {
        server.get(healthCheckPath, async () => {
            return health(client);
        });
    }

    server.addHook("onClose", async () => {
        await shutdown(client, server.log);
    });
}

export default fp(redisPlugin, {
    name: "redis",
    fastify: "5.x",
});
export { redisPlugin };