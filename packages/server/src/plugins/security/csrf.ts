import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";

export interface CsrfPluginOptions {
    cookieOpts?: {
        domain?: string;
        path?: string;
        sameSite?: "strict" | "lax" | "none";
        secure?: boolean;
        httpOnly?: boolean;
        signed?: boolean;
    };
    cookieName?: string;
    sessionKey?: string;
    sessionPlugin?: "@fastify/session" | "@fastify/secure-session" | false;
    getToken?: (request: FastifyRequest) => string | Promise<string>;
    getUserInfo?: (request: FastifyRequest) => unknown | Promise<unknown>;
    ignoreMethods?: string[];
    ignoreRoutes?: string[];
    keyGenerator?: (request: FastifyRequest) => string | Promise<string>;
    skipCheck?: (request: FastifyRequest) => boolean | Promise<boolean>;
}

async function csrfPlugin(
    server: FastifyInstance,
    options: CsrfPluginOptions = {},
): Promise<void> {
    let mod: { default: (opts: CsrfPluginOptions) => unknown };
    try {
        mod = await import("@fastify/csrf-protection") as unknown as { default: (opts: CsrfPluginOptions) => unknown };
    } catch {
        server.log?.warn?.("@fastify/csrf-protection not installed, skipping csrf plugin");
        return;
    }
    await server.register(mod.default as unknown as Parameters<FastifyInstance["register"]>[0], options);
}

export default fp(csrfPlugin, {
    name: "csrf",
    fastify: "5.x",
});
export { csrfPlugin };