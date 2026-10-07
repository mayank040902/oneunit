import type { FastifyInstance, FastifyPluginCallback } from "fastify";
import fp from "fastify-plugin";

export interface SwaggerPluginOptions {
    openapi?: {
        info?: {
            title?: string;
            version?: string;
            description?: string;
        };
        components?: {
            securitySchemes?: Record<string, unknown>;
        };
        tags?: Array<{ name: string; description?: string }>;
        externalDocs?: { description?: string; url?: string };
    };
    hideUntagged?: boolean;
    stripBasePath?: boolean;
    transform?: (schema: unknown) => unknown;
    transformSpec?: (spec: unknown) => unknown;
    refResolver?: {
        buildLocalReference?: (json: unknown, baseUri: string, fragment: string, i: number) => string;
    };
    mode?: "static" | "dynamic";
}

let swaggerModule: FastifyPluginCallback<SwaggerPluginOptions> | null = null;

async function loadSwaggerModule(): Promise<FastifyPluginCallback<SwaggerPluginOptions>> {
    if (swaggerModule) {
        return swaggerModule;
    }
    const mod = await import("@fastify/swagger") as unknown as { default: FastifyPluginCallback<SwaggerPluginOptions> };
    swaggerModule = mod.default;
    return swaggerModule;
}

async function swaggerPlugin(
    server: FastifyInstance,
    options: SwaggerPluginOptions = {},
): Promise<void> {
    const plugin = await loadSwaggerModule();
    await server.register(plugin, options);
}

export default fp(swaggerPlugin);
export { swaggerPlugin };