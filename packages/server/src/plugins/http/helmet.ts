import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

export interface HelmetPluginOptions {
    contentSecurityPolicy?: boolean | object;
    crossOriginEmbedderPolicy?: boolean | object;
    crossOriginOpenerPolicy?: boolean | object;
    crossOriginResourcePolicy?: boolean | object;
    dnsPrefetchControl?: boolean | object;
    frameguard?: boolean | object;
    hidePoweredBy?: boolean | object;
    hsts?: boolean | object;
    ieNoOpen?: boolean | object;
    noSniff?: boolean | object;
    referrerPolicy?: boolean | object;
    xssFilter?: boolean | object;
}

async function helmetPlugin(
    server: FastifyInstance,
    options: HelmetPluginOptions = {},
): Promise<void> {
    let mod: { default: (opts: HelmetPluginOptions) => unknown };
    try {
        mod = await import("@fastify/helmet") as unknown as { default: (opts: HelmetPluginOptions) => unknown };
    } catch {
        server.log?.warn?.("@fastify/helmet not installed, skipping helmet plugin");
        return;
    }
    await server.register(mod.default as unknown as Parameters<FastifyInstance["register"]>[0], options);
}

export default fp(helmetPlugin, {
    name: "helmet",
    fastify: "5.x",
});
export { helmetPlugin };