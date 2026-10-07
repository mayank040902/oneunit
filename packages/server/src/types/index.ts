export type {
    BootstrapServerOptions,
    StartedBootstrapServer,
    FastifyPlugin,
    PluginRegistration,
    PluginEntry,
    Configurer,
} from "./bootstrap.js";

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
} from "./plugins.js";

export type {
    HealthStatus,
    HealthCheckResult,
    HealthCheck,
    HealthProvider,
    HealthRegistry,
    HealthRouteOptions,
    HealthCheckProvider,
    BootstrapHealthOptions,
} from "./health.js";

export type { BootstrapHooks, HookList } from "./hooks.js";