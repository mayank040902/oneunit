import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";

export interface ErrorHandlerPluginOptions {
    /** Include `stack` in the response body. Defaults to `false`. */
    includeStack?: boolean;
    /** Log every error at `error` level. Defaults to `true`. */
    logErrors?: boolean;
    /** Log 4xx at `warn` and 5xx at `error` instead of everything at `error`. */
    logOperationalAsWarn?: boolean;
    /** Mask sensitive keys in `details` before sending. `true` uses default sensitive keys; pass an explicit key list to override. Defaults to off. */
    redactDetails?: boolean | readonly string[];
    /** Bounds on the size of `details` in both the response and the log line. */
    detailLimits?: { maxKeys?: number; maxDepth?: number; maxStringLength?: number };
    /** Include the sub-errors of an `AggregateError` in the response. Defaults to `true`. */
    includeAggregated?: boolean;
    customHandler?: (error: unknown, request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

async function errorHandlerPlugin(
    server: FastifyInstance,
    options: ErrorHandlerPluginOptions = {},
): Promise<void> {
    try {
        const errorsModule = await import("@oneunit/errors/fastify") as {
            registerErrorHandler: (server: FastifyInstance, options: ErrorHandlerPluginOptions) => Promise<void>;
            errorHandlerPlugin: (server: FastifyInstance, options: ErrorHandlerPluginOptions) => Promise<void>;
            default: (server: FastifyInstance, options: ErrorHandlerPluginOptions) => Promise<void>;
        };
        // Use the plugin which registers both error handler and not-found handler
        await errorsModule.default(server, options);
    } catch (err) {
        server.log?.warn?.({ err }, "errors package not installed, using default Fastify error handler");
    }
}

export default fp(errorHandlerPlugin, {
    name: "error-handler",
    fastify: "5.x",
});
export { errorHandlerPlugin };