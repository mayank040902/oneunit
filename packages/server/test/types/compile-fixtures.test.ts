import { describe, expect, it } from "vitest";
import {
    createBootstrapServer,
    startBootstrapServer,
    type BootstrapServerOptions,
    type StartedBootstrapServer,
    type PluginEntry,
    type Configurer,
    type BuiltinPluginsOptions,
    type PluginConfig,
    type LoggerPluginOptions,
    type DatabasePluginOptions,
    type RedisPluginOptions,
    type KafkaPluginOptions,
    type ErrorHandlerPluginOptions,
    type MsgpackPluginOptions,
    type CorsPluginOptions,
    type HelmetPluginOptions,
    type CookiePluginOptions,
    type CompressPluginOptions,
    type RateLimitPluginOptions,
    type RequestContextPluginOptions,
    type MultipartPluginOptions,
    type CsrfPluginOptions,
    type UnderPressurePluginOptions,
    type SwaggerPluginOptions,
    type SwaggerUIPluginOptions,
    type RealtimePluginOptions,
    type BootstrapHooks,
    type HookList,
    type HealthStatus,
    type HealthCheckResult,
    type HealthProvider,
    type HealthRegistry,
    type HealthRouteOptions,
    type LoadEnvOptions,
} from "../../src/bootstrap.js";

describe("Type-Level Compile Fixtures", () => {
    it("BootstrapServerOptions accepts all valid fields", () => {
        const opts: BootstrapServerOptions = {
            serviceName: "api",
            port: 3000,
            host: "0.0.0.0",
            logger: true,
            errorHandler: { includeStack: true },
            responseManagement: true,
            msgpack: { enableBuiltin: true },
            zod: true,
            cors: { origin: ["https://example.com"], credentials: true },
            helmet: true,
            cookie: { secret: "cookie-secret-key" },
            compress: true,
            rateLimit: { max: 100, timeWindow: "1 minute" },
            requestContext: true,
            multipart: true,
            csrf: false,
            underPressure: false,
            swagger: false,
            swaggerUI: false,
            database: false,
            redis: false,
            kafka: false,
            realtime: false,
            fastify: { trustProxy: true },
            plugins: [],
            extraPlugins: [],
            hooks: {},
            configure: () => {},
            health: { includeDetails: true },
            listen: { port: 3000 },
            env: false,
            gracefulShutdown: true,
        };

        expect(opts).toBeDefined();
    });

    it("BootstrapServerOptions accepts partial configuration", () => {
        const opts: BootstrapServerOptions = {
            port: 3000,
        };
        expect(opts.port).toBe(3000);
    });

    it("PluginConfig accepts boolean or options object", () => {
        const a: PluginConfig = true;
        const b: PluginConfig = false;
        const c: PluginConfig = { key: "value" };

        expect(a).toBe(true);
        expect(b).toBe(false);
        expect(c).toEqual({ key: "value" });
    });

    it("PluginEntry accepts function or registration object", () => {
        const fn: PluginEntry = async () => {};
        const obj: PluginEntry = { plugin: async () => {}, options: { prefix: "/api" } };

        expect(typeof fn).toBe("function");
        expect(typeof obj).toBe("object");
    });

    it("Configurer is a function type", () => {
        const fn: Configurer = () => {};
        expect(typeof fn).toBe("function");
    });

    it("StartedBootstrapServer has correct shape", async () => {
        const result: Promise<StartedBootstrapServer> = startBootstrapServer({
            port: 0,
            logger: false,
            kafka: false,
            realtime: false,
            database: false,
            redis: false,
            env: false,
            health: false,
            gracefulShutdown: false,
        });

        const server = await result;
        expect(typeof server.close).toBe("function");
        expect(typeof server.port).toBe("number");
        await server.close();
    });

    it("HealthStatus type values", () => {
        const healthy: HealthStatus = "healthy";
        const degraded: HealthStatus = "degraded";
        const unhealthy: HealthStatus = "unhealthy";

        expect(healthy).toBe("healthy");
        expect(degraded).toBe("degraded");
        expect(unhealthy).toBe("unhealthy");
    });

    it("HealthProvider has correct shape", () => {
        const provider: HealthProvider = {
            name: "test",
            check: async () => ({ status: "healthy" }),
            critical: false,
        };
        expect(provider.name).toBe("test");
    });

    it("HealthCheckResult has correct shape", () => {
        const result: HealthCheckResult = {
            status: "healthy",
            latency: 5,
            message: "ok",
            details: { info: "test" },
        };
        expect(result.status).toBe("healthy");
    });

    it("HealthRouteOptions accepts includeDetails", () => {
        const opts: HealthRouteOptions = {
            path: "/healthz",
            serviceName: "svc",
            includeDetails: true,
        };
        expect(opts.includeDetails).toBe(true);
    });

    it("BootstrapHooks accepts all hook types", () => {
        const hooks: BootstrapHooks = {
            onRequest: [async () => {}],
            preParsing: [async () => ""],
            preValidation: [async () => {}],
            preHandler: [async () => {}],
            preSerialization: [async () => { return {}; }],
            onSend: [async () => ""],
            onResponse: [async () => ""],
            onError: [async () => {}],
            onTimeout: [async () => {}],
            onRequestAbort: [async () => {}],
            onReady: [async () => {}],
            onListen: [async () => {}],
            onClose: [async () => {}],
            onRoute: [async () => {}],
            onRegister: [async () => {}],
        };
        expect(hooks).toBeDefined();
    });

    it("HookList type works for arrays of hooks", () => {
        const list: HookList<() => void> = [() => {}];
        expect(list.length).toBe(1);
    });

    it("LoadEnvOptions type exists", () => {
        const opts: LoadEnvOptions = {
            path: ".env",
            debug: true,
        };
        expect(opts.debug).toBe(true);
    });

    it("BuiltinPluginsOptions accepts all plugin configs", () => {
        const opts: BuiltinPluginsOptions = {
            cors: true,
            helmet: true,
            cookie: true,
            compress: true,
            rateLimit: true,
            zod: false,
            logger: true,
            database: false,
            kafka: false,
            redis: false,
            realtime: false,
            errorHandler: true,
            msgpack: true,
            requestContext: true,
            multipart: false,
            csrf: false,
            underPressure: false,
            swagger: false,
            swaggerUI: false,
        };
        expect(opts).toBeDefined();
    });

    it("All plugin option types are usable", () => {
        const loggerOpts: LoggerPluginOptions = { useHttpLogger: false };
        const dbOpts: DatabasePluginOptions = { connectionString: "postgres://localhost" };
        const redisOpts: RedisPluginOptions = { healthCheck: true };
        const kafkaOpts: KafkaPluginOptions = { autoConnectProducer: true };
        const errorOpts: ErrorHandlerPluginOptions = { includeStack: true };
        const msgpackOpts: MsgpackPluginOptions = { enableBuiltin: false };
        const corsOpts: CorsPluginOptions = { origin: "*" };
        const helmetOpts: HelmetPluginOptions = { contentSecurityPolicy: false };
        const cookieOpts: CookiePluginOptions = { secret: "secret" };
        const compressOpts: CompressPluginOptions = { threshold: 1024 };
        const rateLimitOpts: RateLimitPluginOptions = { max: 100 };
        const reqCtxOpts: RequestContextPluginOptions = {};
        const multipartOpts: MultipartPluginOptions = { limits: { fileSize: 1024 } };
        const csrfOpts: CsrfPluginOptions = { cookieOpts: { secure: false } };
        const upOpts: UnderPressurePluginOptions = { exposeRoute: "true" };
        const swaggerOpts: SwaggerPluginOptions = { openapi: { info: { title: "T", version: "1" } } };
        const swaggerUIOpts: SwaggerUIPluginOptions = { routePrefix: "/docs" };
        const realtimeOpts: RealtimePluginOptions = {};

        expect(loggerOpts.useHttpLogger).toBe(false);
        expect(dbOpts.connectionString).toBe("postgres://localhost");
        expect(redisOpts.healthCheck).toBe(true);
        expect(kafkaOpts.autoConnectProducer).toBe(true);
        expect(errorOpts.includeStack).toBe(true);
        expect(msgpackOpts.enableBuiltin).toBe(false);
        expect(corsOpts.origin).toBe("*");
        expect(helmetOpts.contentSecurityPolicy).toBe(false);
        expect(cookieOpts.secret).toBe("secret");
        expect(compressOpts.threshold).toBe(1024);
        expect(rateLimitOpts.max).toBe(100);
        expect(multipartOpts.limits?.fileSize).toBe(1024);
        expect(csrfOpts.cookieOpts?.secure).toBe(false);
        expect(upOpts.exposeRoute).toBe("true");
        expect(swaggerOpts.openapi?.info?.title).toBe("T");
        expect(swaggerUIOpts.routePrefix).toBe("/docs");
        expect(realtimeOpts).toEqual({});
    });

    it("createBootstrapServer function type works", async () => {
        const server = await createBootstrapServer({
            port: 0,
            logger: false,
            kafka: false,
            realtime: false,
            database: false,
            redis: false,
            env: false,
            health: false,
        });
        expect(server).toBeDefined();
        await server.close();
    });

    it("startBootstrapServer function type works", async () => {
        const result = await startBootstrapServer({
            port: 0,
            logger: false,
            kafka: false,
            realtime: false,
            database: false,
            redis: false,
            env: false,
            health: false,
            gracefulShutdown: false,
        });
        expect(result.address).toBeDefined();
        await result.close();
    });
});
