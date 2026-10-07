import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

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
    const mod = await import("@fastify/csrf-protection") as unknown as { default: (opts: CsrfPluginOptions) => unknown };
    await server.register(mod.default as unknown as Parameters<FastifyInstance["register"]>[0], options);
}

export default csrfPlugin;
export { csrfPlugin };