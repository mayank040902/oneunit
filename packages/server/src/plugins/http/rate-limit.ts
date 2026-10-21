import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

export interface RateLimitPluginOptions {
    max?: number;
    timeWindow?: string | number;
    cache?: number;
    allowList?: string[];
    redis?: unknown;
    keyGenerator?: (request: FastifyRequest) => string;
    skipOnError?: boolean;
    /** Alias of `allowList`, kept for the older option name. */
    whitelist?: string[];
    /** Addresses that are always rejected with 429. */
    blacklist?: string[];
    /**
     * @deprecated The upstream plugin always keeps an in-memory store; the
     * option has no effect.
     */
    disableCache?: boolean;
    global?: boolean;
}

let cachedPlugin: unknown = null;

async function loadRateLimitPlugin(): Promise<unknown> {
    if (cachedPlugin) return cachedPlugin;
    const mod = await import("@fastify/rate-limit");
    cachedPlugin = mod.default;
    return cachedPlugin;
}

// Default key generator that includes the route path for per-route limiting
function defaultKeyGenerator(request: FastifyRequest): string {
    const ip = request.ip;
    const route = request.routeOptions?.url || request.url;
    return `${ip}:${route}`;
}

async function rateLimitPlugin(
    server: FastifyInstance,
    options: RateLimitPluginOptions = {},
): Promise<void> {
    let plugin: unknown;
    try {
        plugin = await loadRateLimitPlugin();
    } catch {
        server.log?.warn?.("@fastify/rate-limit not installed, skipping rate-limit plugin");
        return;
    }

    const { whitelist, blacklist, disableCache: _disableCache, ...rest } = options;

    // Default to global limiting with per-route key generator
    const pluginOptions = {
        ...rest,
        // The upstream plugin only knows `allowList`; the older name is
        // mapped onto it so it is not silently dropped.
        ...(whitelist ? { allowList: whitelist } : {}),
        global: options.global ?? true,
        keyGenerator: options.keyGenerator ?? defaultKeyGenerator,
    };

    await server.register(plugin as Parameters<FastifyInstance["register"]>[0], pluginOptions);

    // The upstream plugin has no blacklist. Rejecting the addresses here
    // keeps the option from being a promise that is never kept.
    if (blacklist && blacklist.length > 0) {
        const blocked = new Set(blacklist);
        server.addHook("onRequest", async (request, reply) => {
            if (blocked.has(request.ip)) {
                return reply.code(429).send({
                    statusCode: 429,
                    error: "Too Many Requests",
                    message: "Rate limit exceeded",
                });
            }
        });
    }
}

export default fp(rateLimitPlugin);
export { rateLimitPlugin };