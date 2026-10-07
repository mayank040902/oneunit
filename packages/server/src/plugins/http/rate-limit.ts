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
    whitelist?: string[];
    blacklist?: string[];
    disableCache?: boolean;
    global?: boolean;
}

let cachedPlugin: unknown = null;

async function loadRateLimitPlugin() {
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
    const plugin = await loadRateLimitPlugin();
    
    // Default to global limiting with per-route key generator
    const pluginOptions = {
        ...options,
        global: options.global ?? true,
        keyGenerator: options.keyGenerator ?? defaultKeyGenerator,
    };
    
    await server.register(plugin as Parameters<FastifyInstance["register"]>[0], pluginOptions);
}

export default fp(rateLimitPlugin);
export { rateLimitPlugin };