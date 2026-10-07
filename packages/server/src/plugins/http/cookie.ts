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
    const mod = await import("@fastify/cookie") as unknown as { default: (opts: CookiePluginOptions) => unknown };
    await server.register(mod.default as unknown as Parameters<FastifyInstance["register"]>[0], options);
}

export default fp(cookiePlugin, {
    name: "cookie",
    fastify: "5.x",
});
export { cookiePlugin };