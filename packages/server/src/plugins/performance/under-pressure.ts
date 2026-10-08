import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

export interface UnderPressurePluginOptions {
    maxEventLoopDelay?: number;
    maxHeapUsedBytes?: number;
    maxRssBytes?: number;
    maxEventLoopUtilization?: number;
    message?: string;
    retryAfter?: string | number;
    exposeRoute?: string;
    exposeErrors?: boolean;
    healthCheck?: boolean;
}

async function underPressurePlugin(
    server: FastifyInstance,
    options: UnderPressurePluginOptions = {},
): Promise<void> {
    let mod: { default: (opts: UnderPressurePluginOptions) => unknown };
    try {
        mod = await import("@fastify/under-pressure") as unknown as { default: (opts: UnderPressurePluginOptions) => unknown };
    } catch {
        server.log?.warn?.("@fastify/under-pressure not installed, skipping under-pressure plugin");
        return;
    }
    await server.register(mod.default as unknown as Parameters<FastifyInstance["register"]>[0], options);
}

export default fp(underPressurePlugin, {
    name: "under-pressure",
    fastify: "5.x",
});
export { underPressurePlugin };