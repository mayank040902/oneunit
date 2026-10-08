import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

export interface LoggerPluginOptions {
    useHttpLogger?: boolean;
    serviceName?: string;
    mode?: "development" | "production" | "test";
    serializers?: Record<string, unknown>;
    childBindings?: Record<string, unknown>;
    pino?: Record<string, unknown>;
}

async function loggerPlugin(
    server: FastifyInstance,
    options: LoggerPluginOptions = {},
): Promise<void> {
    let createLogger: (options: Record<string, unknown>) => unknown;

    try {
        const loggerModule = await import("@oneunit/logger") as {
            createLogger: typeof createLogger;
        };
        createLogger = loggerModule.createLogger;
    } catch (err) {
        server.log.warn({ err }, "logger package not installed, using default Fastify logger");
        return;
    }

    const { useHttpLogger = true, serviceName, mode, serializers, childBindings, pino, ...rest } = options;

    const effectiveServiceName = serviceName ?? (server as { name?: string }).name;

    const loggerOptions = {
        mode,
        childBindings: effectiveServiceName ? { service: effectiveServiceName } : childBindings,
        serializers,
        pino,
        ...rest,
    };

    const logger = createLogger(loggerOptions);
    server.log = logger as typeof server.log;

    // Note: Fastify's HTTP logging is handled internally when you set server.log
    // The @oneunit/logger's createHttpLogger returns a pino-http middleware 
    // designed for standard Node.js http servers, not Fastify.
    // Fastify automatically uses the provided logger for request/response logging
    // when logger is configured, so we don't need to register an additional hook.
    if (useHttpLogger) {
        // HTTP logging is automatic in Fastify when logger is set
        // The logger instance will be used for all request/response logging
    }

    server.decorate("logger", logger);
}

export default fp(loggerPlugin, {
    name: "logger",
    fastify: "5.x",
});
export { loggerPlugin };