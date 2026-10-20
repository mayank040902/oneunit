import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { ResponseManager } from "./response-management.js";
import { sanitizeMetadata } from "./response-metadata.js";

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
    /**
     * Send framework errors in the response layer's standard envelope
     * (`{ success: false, code, message, data, metadata }`) instead of the
     * errors package's `{ error: { … } }` payload. Defaults to `false`.
     *
     * A framework error is one raised before the handler runs — a malformed
     * request body, an unsupported media type, an unmatched route, or a route
     * schema that did not validate — so the handler never gets the chance to
     * answer in the envelope it would normally use. Turning this on gives the
     * client one shape for every failure.
     */
    errorEnvelope?: boolean;
}

/** The parts of an application error the envelope handler reads. */
interface AppErrorLike {
    message?: string;
    code?: string;
    statusCode?: number;
    details?: Record<string, unknown>;
}

/**
 * Builds the error handler that answers with the response layer's envelope.
 *
 * The errors package hands over the normalised application error and then
 * steps aside, so the payload is re-shaped here rather than by the handler
 * that raised it. `details` is sanitised with the same options the errors
 * package would have used, so a field map keeps its bounds and its redaction.
 */
function createEnvelopeErrorHandler(
    options: ErrorHandlerPluginOptions
): (error: unknown, request: FastifyRequest, reply: FastifyReply) => Promise<void> {
    const manager = new ResponseManager();

    return async (error, request, reply) => {
        const appError = (error ?? {}) as AppErrorLike;

        const status =
            typeof appError.statusCode === "number" && appError.statusCode >= 400
                ? appError.statusCode
                : 500;

        if (appError.code === "RATE_LIMIT_EXCEEDED") {
            const retryAfter = appError.details?.retryAfter;
            if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
                reply.header("Retry-After", String(Math.ceil(retryAfter)));
            }
        }

        const details = sanitizeMetadata(appError.details, {
            redact: options.redactDetails ?? false,
            limits: options.detailLimits,
        });

        const envelope = manager.failed({
            code: appError.code ?? "INTERNAL_ERROR",
            message: appError.message ?? "Request failed",
            data: details,
            metadata: {
                requestId: request.id,
                path: request.url,
                timestamp: new Date().toISOString(),
            },
        });

        await reply.status(status).send(envelope);
    };
}

async function errorHandlerPlugin(
    server: FastifyInstance,
    options: ErrorHandlerPluginOptions = {}
): Promise<void> {
    const { errorEnvelope = false, ...handlerOptions } = options;

    const resolved: ErrorHandlerPluginOptions = { ...handlerOptions };
    if (errorEnvelope && !resolved.customHandler) {
        resolved.customHandler = createEnvelopeErrorHandler(handlerOptions);
    }

    try {
        const errorsModule = await import("@oneunit/errors/fastify") as {
            registerErrorHandler: (server: FastifyInstance, options: ErrorHandlerPluginOptions) => Promise<void>;
            errorHandlerPlugin: (server: FastifyInstance, options: ErrorHandlerPluginOptions) => Promise<void>;
            default: (server: FastifyInstance, options: ErrorHandlerPluginOptions) => Promise<void>;
        };
        // Use the plugin which registers both error handler and not-found handler
        await errorsModule.default(server, resolved);
    } catch (err) {
        server.log?.warn?.({ err }, "errors package not installed, using default Fastify error handler");
    }
}

export default fp(errorHandlerPlugin, {
    name: "error-handler",
    fastify: "5.x",
});
export { errorHandlerPlugin };
