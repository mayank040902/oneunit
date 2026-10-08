import type { FastifyInstance, FastifyPluginCallback } from "fastify";
import fp from "fastify-plugin";

export interface SwaggerUIPluginOptions {
    routePrefix?: string;
    uiConfig?: {
        docExpansion?: "list" | "full" | "none";
        deepLinking?: boolean;
        defaultModelsExpandDepth?: number;
        defaultModelExpandDepth?: number;
        defaultModelRendering?: "example" | "model";
        displayOperationId?: boolean;
        displayRequestDuration?: boolean;
        filter?: boolean | string;
        maxDisplayedTags?: number;
        showExtensions?: boolean;
        showCommonExtensions?: boolean;
        tryItOutEnabled?: boolean;
    };
    staticCSP?: boolean;
    transformSpecification?: (swaggerObject: unknown) => unknown;
    transformSpecificationClone?: boolean;
}

let swaggerUIModule: FastifyPluginCallback<SwaggerUIPluginOptions> | null = null;

async function loadSwaggerUIModule(): Promise<FastifyPluginCallback<SwaggerUIPluginOptions> | null> {
    if (swaggerUIModule) {
        return swaggerUIModule;
    }
    const mod = await import("@fastify/swagger-ui") as unknown as { default: FastifyPluginCallback<SwaggerUIPluginOptions> };
    swaggerUIModule = mod.default;
    return swaggerUIModule;
}

async function swaggerUIPlugin(
    server: FastifyInstance,
    options: SwaggerUIPluginOptions = {},
): Promise<void> {
    let plugin: FastifyPluginCallback<SwaggerUIPluginOptions> | null;
    try {
        plugin = await loadSwaggerUIModule();
    } catch {
        server.log?.warn?.("@fastify/swagger-ui not installed, skipping swagger-ui plugin");
        return;
    }
    if (!plugin) {
        server.log?.warn?.("@fastify/swagger-ui not installed, skipping swagger-ui plugin");
        return;
    }
    await server.register(plugin, options);
}

export default fp(swaggerUIPlugin);
export { swaggerUIPlugin };