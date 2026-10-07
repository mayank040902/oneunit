import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

export interface MultipartPluginOptions {
    limits?: {
        fieldNameSize?: number;
        fieldSize?: number;
        fields?: number;
        fileSize?: number;
        files?: number;
        headerPairs?: number;
        parts?: number;
    };
    attachFieldsToBody?: boolean;
    throwFileSizeLimit?: boolean;
}

async function multipartPlugin(
    server: FastifyInstance,
    options: MultipartPluginOptions = {},
): Promise<void> {
    // Import the fastify-plugin wrapped version
    const mod = await import("@fastify/multipart") as unknown as {
        'module.exports': Parameters<FastifyInstance["register"]>[0];
        default: unknown;
    };
    const plugin = mod['module.exports'] ?? mod.default;
    await server.register(plugin as Parameters<FastifyInstance["register"]>[0], options);
}

export default fp(multipartPlugin);
export { multipartPlugin };