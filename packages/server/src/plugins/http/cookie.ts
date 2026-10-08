import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

export interface CookiePluginOptions {
    secret?: string | string[];
    parseOptions?: object;
    hook?: "onRequest" | "preHandler";
}

async function cookiePlugin(
    server: FastifyInstance,
    options: CookiePluginOptions = {},
): Promise<void> {
    let mod: { default: (opts: CookiePluginOptions) => unknown };
    try {
        mod = await import("@fastify/cookie") as unknown as { default: (opts: CookiePluginOptions) => unknown };
    } catch {
        server.log?.warn?.("@fastify/cookie not installed, skipping cookie plugin");
        return;
    }
    await server.register(mod.default as unknown as Parameters<FastifyInstance["register"]>[0], options);
}

export default fp(cookiePlugin, {
    name: "cookie",
    fastify: "5.x",
});
export { cookiePlugin };