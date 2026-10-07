import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

export interface CorsPluginOptions {
    origin?: boolean | string | string[] | ((origin: string, callback: (err: Error | null, allow?: boolean) => void) => void);
    credentials?: boolean;
    methods?: string[];
    allowedHeaders?: string[];
    exposedHeaders?: string[];
    maxAge?: number;
    preflightContinue?: boolean;
    optionsSuccessStatus?: number;
}

async function corsPlugin(
    server: FastifyInstance,
    options: CorsPluginOptions = {},
): Promise<void> {
    const mod = await import("@fastify/cors") as unknown as { default: (opts: CorsPluginOptions) => unknown };
    await server.register(mod.default as unknown as Parameters<FastifyInstance["register"]>[0], options);
}

export default fp(corsPlugin, {
    name: "cors",
    fastify: "5.x",
});
export { corsPlugin };