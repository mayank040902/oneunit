import type { FastifyInstance, FastifyPluginOptions, FastifyServerOptions, FastifyListenOptions } from "fastify";
import type {
    BuiltinPluginsOptions,
    PluginConfig,
    LoggerPluginOptions,
    DatabasePluginOptions,
    RedisPluginOptions,
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
} from "../plugins/index.js";
import type { BootstrapHooks } from "../hooks/index.js";
import type { BootstrapHealthOptions } from "../routes/health.js";
import type { LoadEnvOptions } from "../config/load-env.js";

export type FastifyPlugin = (
    server: FastifyInstance,
    options: FastifyPluginOptions,
    done?: (error?: Error) => void,
) => void | Promise<void>;

export interface PluginRegistration {
    plugin: FastifyPlugin;
    options?: FastifyPluginOptions;
}

export type PluginEntry = FastifyPlugin | PluginRegistration;

export type Configurer = (server: FastifyInstance) => void | Promise<void>;

export interface BootstrapServerOptions {
    serviceName?: string;
    host?: string;
    port?: number;

    cors?: PluginConfig<CorsPluginOptions>;
    helmet?: PluginConfig<HelmetPluginOptions>;
    cookie?: PluginConfig<CookiePluginOptions>;
    compress?: PluginConfig<CompressPluginOptions>;
    rateLimit?: PluginConfig<RateLimitPluginOptions>;
    zod?: boolean;
    logger?: boolean | LoggerPluginOptions | FastifyServerOptions["logger"];
    database?: boolean | DatabasePluginOptions;
    redis?: PluginConfig<RedisPluginOptions>;
    kafka?: PluginConfig;
    realtime?: PluginConfig;
    responseManagement?: PluginConfig;
    errorHandler?: PluginConfig;
    msgpack?: PluginConfig;
    requestContext?: PluginConfig<RequestContextPluginOptions>;
    multipart?: PluginConfig<MultipartPluginOptions>;
    csrf?: PluginConfig<CsrfPluginOptions>;
    underPressure?: PluginConfig<UnderPressurePluginOptions>;
    swagger?: PluginConfig<SwaggerPluginOptions>;
    swaggerUI?: PluginConfig<SwaggerUIPluginOptions>;

    fastify?: FastifyServerOptions;
    plugins?: PluginEntry[] | BuiltinPluginsOptions;
    extraPlugins?: PluginEntry[];
    hooks?: BootstrapHooks;
    configure?: Configurer;
    health?: false | BootstrapHealthOptions;
    listen?: FastifyListenOptions;
    env?: false | LoadEnvOptions;
    gracefulShutdown?: boolean;
}

export interface StartedBootstrapServer {
    app: FastifyInstance;
    address: string;
    port: number;
    host: string;
    close(): Promise<void>;
}