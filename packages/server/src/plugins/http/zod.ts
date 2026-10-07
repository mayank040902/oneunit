import type { FastifyInstance } from "fastify";

export async function applyZodTypeProvider(server: FastifyInstance): Promise<void> {
    const mod = await import("fastify-type-provider-zod") as {
        serializerCompiler?: unknown;
        validatorCompiler?: unknown;
        default?: {
            serializerCompiler?: unknown;
            validatorCompiler?: unknown;
        };
    };

    const provider = mod;
    const serializerCompiler = provider.serializerCompiler ?? provider.default?.serializerCompiler;
    const validatorCompiler = provider.validatorCompiler ?? provider.default?.validatorCompiler;

    if (typeof validatorCompiler === "function") {
        server.setValidatorCompiler(validatorCompiler as Parameters<FastifyInstance["setValidatorCompiler"]>[0]);
    }
    if (typeof serializerCompiler === "function") {
        server.setSerializerCompiler(serializerCompiler as Parameters<FastifyInstance["setSerializerCompiler"]>[0]);
    }
}