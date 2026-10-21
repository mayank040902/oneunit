import type { FastifyInstance } from "fastify";
import type { ResponseManagementPluginOptions } from "./core/response-management.js";
import { applyZodTypeProvider } from "./http/zod.js";

export type { ResponseManagementPluginOptions };
export { applyZodTypeProvider } from "./http/zod.js";

export type PluginConfig<T extends object = Record<string, unknown>> = boolean | T;

// Re-export all plugin option types
export type {
    DatabasePluginOptions,
    KafkaPluginOptions,
    RedisPluginOptions,
    RealtimePluginOptions,
    ErrorHandlerPluginOptions,
    MsgpackPluginOptions,
    LoggerPluginOptions,
    CorsPluginOptions,
    HelmetPluginOptions,
    CookiePluginOptions,
    CompressPluginOptions,
    RateLimitPluginOptions,
    RequestContextPluginOptions,
    MultipartPluginOptions,
    CsrfPluginOptions,
    UnderPressurePluginOptions,
    SwaggerPluginOptions,
    SwaggerUIPluginOptions,
    BuiltinPluginsOptions,
} from "../types/plugins.js";

// Individual plugin registration functions
export { corsPlugin } from "./http/cors.js";
export { helmetPlugin } from "./http/helmet.js";
export { cookiePlugin } from "./http/cookie.js";
export { compressPlugin } from "./http/compress.js";
export { rateLimitPlugin } from "./http/rate-limit.js";
export { requestContextPlugin } from "./http/request-context.js";
export { multipartPlugin } from "./http/multipart.js";
export { csrfPlugin } from "./security/csrf.js";
export { underPressurePlugin } from "./performance/under-pressure.js";
export { swaggerPlugin } from "./documentation/swagger.js";
export { swaggerUIPlugin } from "./documentation/swagger-ui.js";
export { databasePlugin } from "./infrastructure/database.js";
export { kafkaPlugin } from "./infrastructure/kafka.js";
export { redisPlugin } from "./infrastructure/redis.js";
export { realtimePlugin } from "./realtime/realtime.js";
export { errorHandlerPlugin } from "./core/errors.js";
export {
    responseManagementPlugin,
    ResponseManager,
    HTTP_STATUS,
    ERROR_RESPONSES,
    SUCCESS_RESPONSES,
} from "./core/response-management.js";
export type {
    ApiResponse,
    SuccessResponse,
    ErrorResponse,
    FieldError,
    HttpStatusCode,
    ResponseOptions,
    ErrorOptions,
    ErrorResponseOptions,
    RespondOptions,
    PaginatedOptions,
    PaginationMeta,
    ResponseManagementOptions,
    ErrorResponseName,
    SuccessResponseName,
} from "./core/response-management.js";
export { msgpackPlugin } from "./core/msgpack.js";
export { loggerPlugin } from "./core/logger.js";
export { registerSystemHealthProvider } from "./core/system-health.js";

import { type BuiltinPluginsOptions } from "../types/plugins.js";

export const DEFAULT_BUILTIN_PLUGINS: BuiltinPluginsOptions = {
    cors: { origin: true, credentials: true },
    helmet: true,
    cookie: true,
    compress: true,
    rateLimit: { max: 1000, timeWindow: "1 minute" },
    zod: true,
    responseManagement: true,
    logger: { useHttpLogger: true },
    database: false,
    kafka: false,
    redis: false,
    realtime: false,
    errorHandler: { includeStack: false, logErrors: true },
    msgpack: { enableBuiltin: true },
    requestContext: true,
    multipart: false,
    csrf: false,
    underPressure: false,
    swagger: false,
    swaggerUI: false,
};

interface PluginSpec {
    key: keyof Omit<BuiltinPluginsOptions, "zod">;
    specifier: string;
    defaults: Record<string, unknown> | false;
}

export const OPTIONAL_PLUGINS: PluginSpec[] = [
    // Framework primitives
    {
        key: "logger",
        specifier: "./core/logger.js",
        defaults: { useHttpLogger: true },
    },
    {
        key: "errorHandler",
        specifier: "./core/errors.js",
        defaults: { includeStack: false, logErrors: true },
    },
    {
        key: "responseManagement",
        specifier: "./core/response-management.js",
        defaults: {},
    },
    {
        key: "msgpack",
        specifier: "./core/msgpack.js",
        defaults: { enableBuiltin: true },
    },
    // HTTP & Security
    {
        key: "cors",
        specifier: "./http/cors.js",
        defaults: { origin: true, credentials: true },
    },
    {
        key: "helmet",
        specifier: "./http/helmet.js",
        defaults: {},
    },
    {
        key: "cookie",
        specifier: "./http/cookie.js",
        defaults: {},
    },
    {
        key: "compress",
        specifier: "./http/compress.js",
        defaults: {},
    },
    {
        key: "rateLimit",
        specifier: "./http/rate-limit.js",
        defaults: { max: 1000, timeWindow: "1 minute" },
    },
    {
        key: "requestContext",
        specifier: "./http/request-context.js",
        defaults: {},
    },
    {
        key: "multipart",
        specifier: "./http/multipart.js",
        defaults: false,
    },
    {
        key: "csrf",
        specifier: "./security/csrf.js",
        defaults: false,
    },
    // Performance
    {
        key: "underPressure",
        specifier: "./performance/under-pressure.js",
        defaults: false,
    },
    // Infrastructure
    {
        key: "database",
        specifier: "./infrastructure/database.js",
        defaults: false,
    },
    {
        key: "kafka",
        specifier: "./infrastructure/kafka.js",
        defaults: false,
    },
    {
        key: "redis",
        specifier: "./infrastructure/redis.js",
        defaults: false,
    },
    {
        key: "realtime",
        specifier: "./realtime/realtime.js",
        defaults: false,
    },
    // Documentation
    {
        key: "swagger",
        specifier: "./documentation/swagger.js",
        defaults: false,
    },
    {
        key: "swaggerUI",
        specifier: "./documentation/swagger-ui.js",
        defaults: false,
    },
];

async function loadModule(specifier: string): Promise<Record<string, unknown> | null> {
    try {
        return await import(specifier) as Record<string, unknown>;
    } catch (err) {
        // Only a genuinely absent module is optional. A module that exists but
        // fails to evaluate is a defect and must not be reported as "not
        // installed", which would silently disable the plugin.
        const code = (err as { code?: string } | undefined)?.code;
        if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
            throw err;
        }
        return null;
    }
}

export async function registerOptionalPlugin(
    server: FastifyInstance,
    spec: PluginSpec,
    config: PluginConfig | undefined,
): Promise<void> {
    if (config === false) {
        return;
    }

    const pluginOptions = config === true || config === undefined ? spec.defaults : config;

    // Skip if defaults is explicitly false
    if (pluginOptions === false) {
        return;
    }

    const mod = await loadModule(spec.specifier);

    if (!mod) {
        // Infrastructure plugins must fail if explicitly enabled but dependency missing
        const infrastructureKeys = ["database", "redis", "kafka", "realtime"];
        if (infrastructureKeys.includes(spec.key)) {
            throw new Error(`Missing required dependency for ${spec.key} plugin. Install the peer dependency or disable the plugin.`);
        }
        // For other optional plugins, if explicitly configured (not just default true), warn and skip
        if (config !== undefined && config !== true) {
            server.log?.warn?.(`Optional plugin "${spec.key}" not installed, skipping`);
            return;
        }
        // If enabled by default but dependency missing, skip gracefully (many @fastify/* peers are optional)
        return;
    }

    // For fastify plugins, the fastify-plugin wrapped version is typically at module.exports
    // Fall back to default export for compatibility
    const moduleExports = (mod as Record<string, unknown>)["module.exports"];
    const plugin = (moduleExports ?? mod.default ?? mod) as Parameters<FastifyInstance["register"]>[0];
    await server.register(plugin, pluginOptions);
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined),
    ) as Partial<T>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges the plugin layers, one level deep for the option objects.
 *
 * A flat merge would drop the siblings of every key the caller sets: `cors:
 * { origin: [...] }` would lose the default `credentials: true`, and the
 * documented default would no longer hold.
 */
export function mergeBuiltinPlugins(
    ...layers: Array<BuiltinPluginsOptions | undefined>
): BuiltinPluginsOptions {
    const merged: Record<string, unknown> = { ...DEFAULT_BUILTIN_PLUGINS };

    for (const layer of layers.filter(Boolean)) {
        const entries = Object.entries(withoutUndefined(layer as BuiltinPluginsOptions));

        for (const [key, value] of entries) {
            const current = merged[key];
            merged[key] = isPlainObject(current) && isPlainObject(value)
                ? { ...current, ...value }
                : value;
        }
    }

    return merged as BuiltinPluginsOptions;
}

// Registration functions for each plugin category in the correct order
export async function registerFrameworkPlugins(
    server: FastifyInstance,
    options: BuiltinPluginsOptions = {},
): Promise<void> {
    // 1. Framework primitives: logger, errors, response management, serialization (zod)
    if (options.zod !== false) {
        await applyZodTypeProvider(server);
    }

    // Register logger first so other plugins can use it
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "logger")!, options.logger as PluginConfig<Record<string, unknown>>);

    // Register error handler
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "errorHandler")!, options.errorHandler as PluginConfig<Record<string, unknown>>);

    // Register response management
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "responseManagement")!, options.responseManagement as PluginConfig<Record<string, unknown>>);

    // Register msgpack
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "msgpack")!, options.msgpack as PluginConfig<Record<string, unknown>>);
}

export async function registerRequestInfrastructurePlugins(
    server: FastifyInstance,
    options: BuiltinPluginsOptions = {},
): Promise<void> {
    // 2. Request infrastructure: request context
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "requestContext")!, options.requestContext as PluginConfig<Record<string, unknown>>);
}

export async function registerSecurityPlugins(
    server: FastifyInstance,
    options: BuiltinPluginsOptions = {},
): Promise<void> {
    // 3. Security: helmet, cookie, CSRF
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "helmet")!, options.helmet as PluginConfig<Record<string, unknown>>);
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "cookie")!, options.cookie as PluginConfig<Record<string, unknown>>);
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "csrf")!, options.csrf as PluginConfig<Record<string, unknown>>);
}

export async function registerHttpPlugins(
    server: FastifyInstance,
    options: BuiltinPluginsOptions = {},
): Promise<void> {
    // 4. HTTP: CORS, compression, rate limit, validation, multipart
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "cors")!, options.cors as PluginConfig<Record<string, unknown>>);
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "compress")!, options.compress as PluginConfig<Record<string, unknown>>);
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "rateLimit")!, options.rateLimit as PluginConfig<Record<string, unknown>>);
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "multipart")!, options.multipart as PluginConfig<Record<string, unknown>>);
}

export async function registerPerformancePlugins(
    server: FastifyInstance,
    options: BuiltinPluginsOptions = {},
): Promise<void> {
    // 5. Performance: under-pressure
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "underPressure")!, options.underPressure as PluginConfig<Record<string, unknown>>);
}

export async function registerInfrastructurePlugins(
    server: FastifyInstance,
    options: BuiltinPluginsOptions = {},
): Promise<void> {
    // 6. Infrastructure: database, redis, kafka, realtime
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "database")!, options.database as PluginConfig<Record<string, unknown>>);
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "redis")!, options.redis as PluginConfig<Record<string, unknown>>);
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "kafka")!, options.kafka as PluginConfig<Record<string, unknown>>);
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "realtime")!, options.realtime as PluginConfig<Record<string, unknown>>);
}

export async function registerHealthPlugin(
    _server: FastifyInstance,
    _options: BuiltinPluginsOptions = {},
): Promise<void> {
    // System health provider is already registered in bootstrap.ts via
    // registerSystemHealthProvider(server, { disabled: ... })
    // which respects the health: false option.
    // No re-registration here to prevent duplicate providers.
}

export async function registerDocumentationPlugins(
    server: FastifyInstance,
    options: BuiltinPluginsOptions = {},
): Promise<void> {
    // 8. Documentation: Swagger, Swagger UI
    // Swagger UI depends on Swagger, so only register Swagger UI if Swagger is enabled
    const swaggerEnabled = options.swagger !== false;
    await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "swagger")!, options.swagger as PluginConfig<Record<string, unknown>>);
    
    if (swaggerEnabled) {
        await registerOptionalPlugin(server, OPTIONAL_PLUGINS.find((s) => s.key === "swaggerUI")!, options.swaggerUI as PluginConfig<Record<string, unknown>>);
    }
}

export async function registerBuiltinPlugins(
    server: FastifyInstance,
    options: BuiltinPluginsOptions = {},
): Promise<void> {
    // Register in the correct order as per architecture:
    // 1. Framework primitives
    await registerFrameworkPlugins(server, options);

    // 2. Request infrastructure
    await registerRequestInfrastructurePlugins(server, options);

    // 3. Security
    await registerSecurityPlugins(server, options);

    // 4. HTTP middleware
    await registerHttpPlugins(server, options);

    // 5. Performance
    await registerPerformancePlugins(server, options);

    // 6. Infrastructure
    await registerInfrastructurePlugins(server, options);

    // 7. Health
    await registerHealthPlugin(server, options);

    // 8. Documentation
    await registerDocumentationPlugins(server, options);
}