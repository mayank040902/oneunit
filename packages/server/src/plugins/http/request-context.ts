import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

export interface RequestContextPluginOptions {
    key?: string;
}

const requestContextPlugin: FastifyPluginAsync<RequestContextPluginOptions> = async (
    server: FastifyInstance,
    options: RequestContextPluginOptions = {},
): Promise<void> => {
    const mod = await import("@fastify/request-context") as unknown as { default: FastifyPluginAsync<RequestContextPluginOptions> };
    await server.register(mod.default, options);
};

export default fp(requestContextPlugin);
export { requestContextPlugin };