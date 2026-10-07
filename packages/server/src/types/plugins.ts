export type PluginConfig<T extends object = Record<string, unknown>> = boolean | T;

export interface DatabasePluginOptions {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    ssl?: boolean | object;
    application_name?: string;
    logQueries?: boolean;
    logParameters?: boolean;
    slowQueryMs?: number;
    queryTimeout?: number;
    connectTimeout?: number;
    retry?: boolean | number | object;
    onQuery?: (info: { sql?: string; parameters?: unknown[]; durationMs: number; rowCount?: number; success: boolean }) => void;
    onError?: (info: { error: Error; sql?: string; durationMs: number }) => void;
    onRetry?: (info: { attempt: number; error: Error }) => void;
}

export interface KafkaPluginOptions {
    brokers?: string | string[];
    clientId?: string;
    groupId?: string;
    ssl?: boolean | object;
    sasl?: boolean | object;
    retry?: object;
    logLevel?: string;
    partitioner?: string;
    autoConnectProducer?: boolean;
    consumerGroupId?: string;
    subscribeTopics?: string | string[];
    onMessage?: (payload: { topic: string; partition: number; key: unknown; value: unknown }) => Promise<void>;
    producer?: object;
    consumer?: object;
    admin?: object;
}

export interface RedisPluginOptions {
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    lazyConnect?: boolean;
    healthCheck?: boolean;
    healthCheckPath?: string;
    [key: string]: unknown;
}

export interface RealtimePluginOptions {
    websocketLibrary?: "fastify" | "ws";
    path?: string;
    routes?: (app: import("fastify").FastifyInstance) => Promise<void>;
}

export interface ErrorHandlerPluginOptions {
    includeStack?: boolean;
    logErrors?: boolean;
    customHandler?: (error: unknown, request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
}

export interface MsgpackPluginOptions {
    enableBuiltin?: boolean;
    extensions?: Array<{ type: number; encode: unknown; decode: unknown }>;
}

export interface LoggerPluginOptions {
    useHttpLogger?: boolean;
    serviceName?: string;
    mode?: "development" | "production" | "test";
    serializers?: Record<string, unknown>;
    childBindings?: Record<string, unknown>;
}

export interface CorsPluginOptions {
    origin?: boolean | string | string[] | ((origin: string, callback: (err: Error | null, allow?: boolean) => void) => void);
    credentials?: boolean;
    methods?: string[];
    allowedHeaders?: string[];
    exposedHeaders?: string[];
    maxAge?: number;
    preflightContinue?: boolean;
    optionsSuccessStatus?: number;
}

export interface HelmetPluginOptions {
    contentSecurityPolicy?: boolean | object;
    crossOriginEmbedderPolicy?: boolean | object;
    crossOriginOpenerPolicy?: boolean | object;
    crossOriginResourcePolicy?: boolean | object;
    dnsPrefetchControl?: boolean | object;
    frameguard?: boolean | object;
    hidePoweredBy?: boolean | object;
    hsts?: boolean | object;
    ieNoOpen?: boolean | object;
    noSniff?: boolean | object;
    referrerPolicy?: boolean | object;
    xssFilter?: boolean | object;
}

export interface CookiePluginOptions {
    secret?: string | string[];
    parseOptions?: object;
    hook?: "onRequest" | "preHandler";
}

export interface CompressPluginOptions {
    threshold?: number;
    encodings?: string[];
    filter?: (contentType: string) => boolean;
    global?: boolean;
}

export interface RateLimitPluginOptions {
    max?: number;
    timeWindow?: string | number;
    cache?: number;
    allowList?: string[];
    redis?: unknown;
    keyGenerator?: (request: import("fastify").FastifyRequest) => string;
    skipOnError?: boolean;
    whitelist?: string[];
    blacklist?: string[];
    disableCache?: boolean;
}

export interface RequestContextPluginOptions {
    key?: string;
}

export interface MultipartPluginOptions {
    limits?: {
        fieldNameSize?: number;
        fieldSize?: number;
        fields?: number;
        fileSize?: number;
        files?: number;
        headerPairs?: number;
        parts?: number;
    };
    attachFieldsToBody?: boolean;
    throwFileSizeLimit?: boolean;
}

export interface CsrfPluginOptions {
    cookieOpts?: {
        domain?: string;
        path?: string;
        sameSite?: "strict" | "lax" | "none";
        secure?: boolean;
        httpOnly?: boolean;
        signed?: boolean;
    };
    cookieName?: string;
    sessionKey?: string;
    sessionPlugin?: "@fastify/session" | "@fastify/secure-session" | false;
    getToken?: (request: import("fastify").FastifyRequest) => string | Promise<string>;
    getUserInfo?: (request: import("fastify").FastifyRequest) => unknown | Promise<unknown>;
    ignoreMethods?: string[];
    ignoreRoutes?: string[];
    keyGenerator?: (request: import("fastify").FastifyRequest) => string | Promise<string>;
    skipCheck?: (request: import("fastify").FastifyRequest) => boolean | Promise<boolean>;
}

export interface UnderPressurePluginOptions {
    maxEventLoopDelay?: number;
    maxHeapUsedBytes?: number;
    maxRssBytes?: number;
    maxEventLoopUtilization?: number;
    message?: string;
    retryAfter?: string | number;
    exposeRoute?: string;
    exposeErrors?: boolean;
    healthCheck?: boolean;
}

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

export interface BuiltinPluginsOptions {
    cors?: PluginConfig<CorsPluginOptions>;
    helmet?: PluginConfig<HelmetPluginOptions>;
    cookie?: PluginConfig<CookiePluginOptions>;
    compress?: PluginConfig<CompressPluginOptions>;
    rateLimit?: PluginConfig<RateLimitPluginOptions>;
    zod?: boolean;
    responseManagement?: PluginConfig<ResponseManagementPluginOptions>;
    logger?: PluginConfig<LoggerPluginOptions>;
    database?: PluginConfig<DatabasePluginOptions>;
    kafka?: PluginConfig<KafkaPluginOptions>;
    redis?: PluginConfig<RedisPluginOptions>;
    realtime?: PluginConfig<RealtimePluginOptions>;
    errorHandler?: PluginConfig<ErrorHandlerPluginOptions>;
    msgpack?: PluginConfig<MsgpackPluginOptions>;
    requestContext?: PluginConfig<RequestContextPluginOptions>;
    multipart?: PluginConfig<MultipartPluginOptions>;
    csrf?: PluginConfig<CsrfPluginOptions>;
    underPressure?: PluginConfig<UnderPressurePluginOptions>;
    swagger?: PluginConfig<SwaggerPluginOptions>;
    swaggerUI?: PluginConfig<SwaggerUIPluginOptions>;
}

export interface ResponseManagementPluginOptions {}