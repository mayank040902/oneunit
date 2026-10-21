export {
    createBootstrapServer,
    startBootstrapServer,
    createServer,
    startServer,
} from "./bootstrap.js";

export * from "./config/index.js";
export * from "./routes/index.js";
export * from "./plugins/index.js";
export * from "./hooks/index.js";
export * from "./lib/index.js";
export * from "./health/index.js";

export type {
    BootstrapServerOptions,
    StartedBootstrapServer,
    PluginEntry,
    Configurer,
} from "./types/bootstrap.js";

export type {
    PluginConfig,
    DatabasePluginOptions,
    KafkaPluginOptions,
    RedisPluginOptions,
    RealtimePluginOptions,
    ErrorHandlerPluginOptions,
    MsgpackPluginOptions,
    LoggerPluginOptions,
    BuiltinPluginsOptions,
    ResponseManagementPluginOptions,
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
} from "./types/plugins.js";

export type {
    HealthStatus,
    HealthCheckResult,
    HealthCheck,
    HealthProvider,
    HealthRegistry,
    HealthRouteOptions,
    HealthCheckProvider,
    BootstrapHealthOptions,
} from "./types/health.js";

export type { BootstrapHooks, HookList } from "./types/hooks.js";