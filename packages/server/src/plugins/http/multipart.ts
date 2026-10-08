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
    let mod: {
        'module.exports': Parameters<FastifyInstance["register"]>[0];
        default: unknown;
    };
    try {
        // Import the fastify-plugin wrapped version
        mod = await import("@fastify/multipart") as unknown as {
            'module.exports': Parameters<FastifyInstance["register"]>[0];
            default: unknown;
        };
    } catch {
        server.log?.warn?.("@fastify/multipart not installed, skipping multipart plugin");
        return;
    }
    const plugin = mod['module.exports'] ?? mod.default;
    await server.register(plugin as Parameters<FastifyInstance["register"]>[0], options);
}

export default fp(multipartPlugin);
export { multipartPlugin };