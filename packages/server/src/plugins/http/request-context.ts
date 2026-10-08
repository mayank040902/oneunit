import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

export interface RequestContextPluginOptions {
    key?: string;
}

const requestContextPlugin: FastifyPluginAsync<RequestContextPluginOptions> = async (
    server: FastifyInstance,
    options: RequestContextPluginOptions = {},
): Promise<void> => {
    let mod: { default: FastifyPluginAsync<RequestContextPluginOptions> };
    try {
        mod = await import("@fastify/request-context") as unknown as { default: FastifyPluginAsync<RequestContextPluginOptions> };
    } catch {
        server.log?.warn?.("@fastify/request-context not installed, skipping request-context plugin");
        return;
    }
    await server.register(mod.default, options);
};

export default fp(requestContextPlugin);
export { requestContextPlugin };