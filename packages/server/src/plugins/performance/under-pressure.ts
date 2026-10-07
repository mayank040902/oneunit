import type { FastifyInstance } from "fastify";

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
    const mod = await import("@fastify/under-pressure") as unknown as { default: (opts: UnderPressurePluginOptions) => unknown };
    await server.register(mod.default as unknown as Parameters<FastifyInstance["register"]>[0], options);
}

export default underPressurePlugin;
export { underPressurePlugin };