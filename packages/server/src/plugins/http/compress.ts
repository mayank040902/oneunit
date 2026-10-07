import type { FastifyInstance } from "fastify";

export interface CompressPluginOptions {
    threshold?: number;
    encodings?: string[];
    filter?: (contentType: string) => boolean;
    global?: boolean;
}

async function compressPlugin(
    server: FastifyInstance,
    options: CompressPluginOptions = {},
): Promise<void> {
    const mod = await import("@fastify/compress") as unknown as { default: (opts: CompressPluginOptions) => unknown };
    await server.register(mod.default as unknown as Parameters<FastifyInstance["register"]>[0], options);
}

export default compressPlugin;
export { compressPlugin };