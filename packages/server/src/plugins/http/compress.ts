import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

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
    let mod: { default: (opts: CompressPluginOptions) => unknown };
    try {
        mod = await import("@fastify/compress") as unknown as { default: (opts: CompressPluginOptions) => unknown };
    } catch {
        server.log?.warn?.("@fastify/compress not installed, skipping compress plugin");
        return;
    }
    await server.register(mod.default as unknown as Parameters<FastifyInstance["register"]>[0], options);
}

export default fp(compressPlugin, {
    name: "compress",
    fastify: "5.x",
});
export { compressPlugin };