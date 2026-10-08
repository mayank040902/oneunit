import type { FastifyInstance, FastifySchemaCompiler, FastifySerializerCompiler } from "fastify";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { kSchemaController, kOptions } = require("fastify/lib/symbols.js") as { kSchemaController: symbol; kOptions: symbol };

interface SchemaControllerLike {
    validatorCompiler?: (opts: { schema: unknown }) => (data: unknown) => { value?: unknown; error?: Error };
    serializerCompiler?: (opts: { schema: unknown }) => (data: unknown) => string;
    setupValidator?: (opts: unknown) => void;
    setupSerializer?: (opts: unknown) => void;
}

export async function applyZodTypeProvider(server: FastifyInstance): Promise<void> {
    let mod: {
        serializerCompiler?: unknown;
        validatorCompiler?: unknown;
        default?: {
            serializerCompiler?: unknown;
            validatorCompiler?: unknown;
        };
    };

    try {
        mod = await import("fastify-type-provider-zod") as typeof mod;
    } catch {
        // fastify-type-provider-zod not installed — skip Zod type provider
        return;
    }

    const provider = mod;
    const zodSerializer = provider.serializerCompiler ?? provider.default?.serializerCompiler;
    const zodValidator = provider.validatorCompiler ?? provider.default?.validatorCompiler;

    if (typeof zodValidator !== "function" && typeof zodSerializer !== "function") {
        return;
    }

    // Import $ZodType to check if a schema is a Zod schema
    let ZodTypeCtor: { new (...args: unknown[]): unknown } | undefined;
    try {
        const zodCore = await import("zod/v4/core") as { $ZodType: { new (...args: unknown[]): unknown } };
        ZodTypeCtor = zodCore.$ZodType;
    } catch {
        // zod not installed — skip
    }

    if (!ZodTypeCtor) {
        return;
    }

    // Access Fastify's internal schema controller to obtain default compilers
    const controller = (server as unknown as Record<symbol, SchemaControllerLike>)[kSchemaController];

    if (!controller) {
        return;
    }

    const serverOpts = (server as unknown as Record<symbol, unknown>)[kOptions];

    // Ensure default compilers are initialized before we override them
    if (controller.setupValidator) {
        controller.setupValidator(serverOpts);
    }
    if (controller.setupSerializer) {
        controller.setupSerializer(serverOpts);
    }

    const defaultValidator = controller.validatorCompiler;
    const defaultSerializer = controller.serializerCompiler;

    // Create wrapper that delegates to Zod for Zod schemas, falls back to Fastify default for JSON schemas
    if (typeof zodValidator === "function" && defaultValidator) {
        server.setValidatorCompiler(((opts: { schema: unknown }) => {
            if (opts.schema instanceof ZodTypeCtor) {
                return (zodValidator as (opts: { schema: unknown }) => (data: unknown) => { value?: unknown; error?: Error })(opts);
            }
            return defaultValidator(opts);
        }) as FastifySchemaCompiler<unknown>);
    }

    if (typeof zodSerializer === "function" && defaultSerializer) {
        server.setSerializerCompiler(((opts: { schema: unknown }) => {
            const schema = opts.schema;
            const isZod =
                schema instanceof ZodTypeCtor ||
                (typeof schema === "object" &&
                    schema !== null &&
                    "properties" in schema &&
                    (schema as Record<string, unknown>).properties instanceof ZodTypeCtor);
            if (isZod) {
                return (zodSerializer as (opts: { schema: unknown }) => (data: unknown) => string)(opts);
            }
            return defaultSerializer(opts);
        }) as FastifySerializerCompiler<unknown>);
    }
}
