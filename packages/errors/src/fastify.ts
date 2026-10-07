import type { FastifyInstance, FastifyError, FastifyRequest, FastifyReply, FastifySchemaValidationError } from "fastify";
import { 
  AppError, 
  isAppError, 
  formatError, 
  getErrorStatusCode,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalError,
  UnprocessableError,
  ServiceUnavailableError,
  TimeoutError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  isOperationalError,
  isAggregateError,
  getAggregateErrors,
  AggregateAppError
} from "./errors.js";
import type { SensitiveKey, DetailLimits } from "./errors.js";

export interface ErrorHandlerOptions {
  /** Include `stack` in the response body. Defaults to `false`. */
  includeStack?: boolean;
  /** Log every error at `error` level. Defaults to `true`. */
  logErrors?: boolean;
  /** Log 4xx at `warn` and 5xx at `error` instead of everything at `error`. */
  logOperationalAsWarn?: boolean;
  /**
   * Mask sensitive keys in `details` before sending. `true` uses
   * `DEFAULT_SENSITIVE_KEYS` from `errors.js`; pass an explicit key list to
   * override. Defaults to off so existing payloads are unchanged.
   */
  redactDetails?: boolean | readonly SensitiveKey[];
  /**
   * Bounds on the size of `details` in both the response and the log line.
   * `details` is frequently built from request input, so without a bound a
   * large body is echoed back to the client and written to the log verbatim.
   * Omit for {@link DEFAULT_DETAIL_LIMITS}.
   */
  detailLimits?: DetailLimits;
  /**
   * Include the sub-errors of an `AggregateError` in the response. Defaults to
   * `true` for the default payload.
   */
  includeAggregated?: boolean;
  customHandler?: (error: AppError, request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

function toCause(error: FastifyError): Error | undefined {
  const original = (error as { original?: unknown }).original;
  return original instanceof Error ? original : error;
}

function causeOf(value: unknown): Error | undefined {
  if (value instanceof Error) return value;
  return undefined;
}

type PayloadOptions = Pick<
  ErrorHandlerOptions,
  "includeStack" | "redactDetails" | "detailLimits" | "includeAggregated"
>;

function payloadOptionsFrom(options: ErrorHandlerOptions): PayloadOptions {
  return {
    includeStack: options.includeStack,
    redactDetails: options.redactDetails,
    detailLimits: options.detailLimits,
    includeAggregated: options.includeAggregated,
  };
}

function buildPayload(
  appError: AppError,
  request: FastifyRequest,
  options: PayloadOptions
): Record<string, unknown> {
  const response = formatError(appError, {
    includeStack: options.includeStack === true,
    includeAggregated: options.includeAggregated ?? true,
    redact: options.redactDetails ?? false,
    limits: options.detailLimits,
  });

  return {
    error: response,
    timestamp: new Date().toISOString(),
    path: request.url,
    requestId: request.id,
  };
}

/**
 * The object handed to the logger in place of the error itself.
 *
 * `redactDetails` protects the response body, but the log line is the copy that
 * usually survives longer and is read by more people, so the same masking and
 * limits have to apply here. Returns `undefined` when neither is configured, so
 * the default path keeps handing pino the real `Error` and its own serializer.
 */
function loggableError(
  error: AppError,
  options: Pick<ErrorHandlerOptions, "redactDetails" | "detailLimits">
): AppError | Record<string, unknown> | undefined {
  if (options.redactDetails === undefined || options.redactDetails === false) {
    if (options.detailLimits === undefined) return undefined;
  }

  return formatError(error, {
    includeStack: true,
    includeAggregated: options.redactDetails !== false,
    redact: options.redactDetails ?? false,
    limits: options.detailLimits,
  });
}

/**
 * A 429 without a `Retry-After` header is not actionable: every HTTP client,
 * proxy, and rate-limit middleware reads that header, and this handler is the
 * only place that knows the retry window.
 */
function applyRetryHeaders(error: AppError, reply: FastifyReply): void {
  if (error.code !== "RATE_LIMIT_EXCEEDED") return;

  const retryAfter = error.details?.retryAfter;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
    reply.header("Retry-After", String(Math.ceil(retryAfter)));
  }
}

/**
 * Ajv reports a missing property with an empty `instancePath` and the property
 * name only in `params.missingProperty`. Keying those by `keyword` alone
 * collapsed every missing field of one schema into a single `required` bucket.
 */
function validationFieldPath(issue: FastifySchemaValidationError): string {
  const missingProperty = (issue.params as { missingProperty?: string } | undefined)?.missingProperty;
  if (issue.keyword === "required" && missingProperty) {
    return `${issue.instancePath}/${missingProperty}`;
  }
  return issue.instancePath || issue.keyword || "unknown";
}

export function createErrorHandler(options: ErrorHandlerOptions = {}) {
  const { logErrors = true, logOperationalAsWarn = false, customHandler } = options;
  const payloadOptions = payloadOptionsFrom(options);

  return async function errorHandler(
    error: FastifyError,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    let appError: AppError;

    // Handle non-Error values (strings, numbers, etc.) by wrapping them
    let fastifyError: FastifyError = error;
    if (!(error instanceof Error)) {
      fastifyError = new Error(String(error)) as FastifyError;
    }

    if (isAppError(fastifyError)) {
      appError = fastifyError;
    } else if (isAggregateError(fastifyError)) {
      // Preserved whole: flattening a fan-out failure to its summary discards
      // every reason except the first.
      appError = new AggregateAppError(
        fastifyError.message,
        getAggregateErrors(fastifyError) ?? [],
        undefined
      );
    } else if (fastifyError.validation) {
      const fields: Record<string, string[]> = {};
      for (const issue of fastifyError.validation) {
        const path = validationFieldPath(issue);
        if (!fields[path]) fields[path] = [];
        fields[path].push(issue.message || "Validation failed");
      }
      appError = new ValidationError("Request validation failed", fields);
    } else if (fastifyError.statusCode === 401) {
      appError = new AuthenticationError(fastifyError.message);
    } else if (fastifyError.statusCode === 403) {
      appError = new AuthorizationError(fastifyError.message);
    } else if (fastifyError.statusCode === 404) {
      appError = new NotFoundError("Resource", undefined, { path: request.url });
    } else if (fastifyError.statusCode === 409) {
      appError = new ConflictError(fastifyError.message);
    } else if (fastifyError.statusCode === 413) {
      appError = new PayloadTooLargeError();
    } else if (fastifyError.statusCode === 415) {
      appError = new UnsupportedMediaTypeError();
    } else if (fastifyError.statusCode === 422) {
      appError = new UnprocessableError(fastifyError.message);
    } else if (fastifyError.statusCode === 429) {
      appError = new RateLimitError(fastifyError.message);
    } else if (fastifyError.statusCode === 503) {
      appError = new ServiceUnavailableError(fastifyError.message);
    } else if (fastifyError.statusCode === 504) {
      appError = new TimeoutError(fastifyError.message);
    } else if (fastifyError.statusCode && fastifyError.statusCode >= 500) {
      appError = new InternalError(fastifyError.message, toCause(fastifyError));
    } else if (fastifyError.statusCode && fastifyError.statusCode >= 400) {
      appError = new AppError(fastifyError.message, "BAD_REQUEST", fastifyError.statusCode);
    } else {
      appError = new InternalError(fastifyError.message, toCause(fastifyError));
    }

    if (logErrors) {
      const loggable = loggableError(appError, options) ?? appError;
      const context = { err: loggable, path: request.url, method: request.method };
      // A 4xx is the caller's problem, not a fault in this service; alerting
      // on it as `error` buries the 5xxs that actually need attention.
      if (logOperationalAsWarn && isOperationalError(appError)) {
        request.log.warn(context, "Request error");
      } else {
        request.log.error(context, "Request error");
      }
    }

    if (customHandler) {
      try {
        await customHandler(appError, request, reply);
      } catch (handlerError) {
        // A custom handler that throws would otherwise escape to Fastify's own
        // fallback, replacing the canonical payload with an unstructured one.
        request.log.error({ err: handlerError, path: request.url }, "Custom error handler failed");
        if (!reply.sent) {
          const failure = new InternalError("Error handler failed", causeOf(handlerError));
          reply.status(getErrorStatusCode(failure)).send(buildPayload(failure, request, payloadOptions));
        }
      }
      return;
    }

    applyRetryHeaders(appError, reply);
    reply.status(getErrorStatusCode(appError)).send(buildPayload(appError, request, payloadOptions));
  };
}

/**
 * Fastify answers unmatched routes from its own not-found handler, which never
 * reaches `setErrorHandler`. Without this, every 404 came back in Fastify's
 * default `{ message, error, statusCode }` shape instead of the canonical
 * payload the rest of this package produces.
 */
export function createNotFoundHandler(options: ErrorHandlerOptions = {}) {
  const { customHandler } = options;
  const payloadOptions = payloadOptionsFrom(options);

  return async function notFoundHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const appError = new NotFoundError("Route", undefined, {
      method: request.method,
      path: request.url,
    });

    if (customHandler) {
      try {
        await customHandler(appError, request, reply);
        return;
      } catch (handlerError) {
        request.log.error({ err: handlerError, path: request.url }, "Custom not-found handler failed");
        if (reply.sent) return;
      }
    }

    reply.status(404).send(buildPayload(appError, request, payloadOptions));
  };
}

export async function registerErrorHandler(
  server: FastifyInstance,
  options: ErrorHandlerOptions = {}
): Promise<void> {
  server.setErrorHandler(createErrorHandler(options));
  server.setNotFoundHandler(createNotFoundHandler(options));
}

export async function errorHandlerPlugin(
  server: FastifyInstance,
  options: ErrorHandlerOptions = {}
): Promise<void> {
  server.setErrorHandler(createErrorHandler(options));
  server.setNotFoundHandler(createNotFoundHandler(options));
}

export default errorHandlerPlugin;

Object.assign(errorHandlerPlugin, {
  [Symbol.for("skip-override")]: true,
  [Symbol.for("plugin-meta")]: {
    name: "@oneunit/errors",
  },
});

/**
 * The canonical payload shape every error response from this package uses.
 *
 * @deprecated Prefer {@link formatError}, which produces the `error` member of
 * this shape for any error, not only validation failures. This response type
 * flattens the error to the top level, which no handler in this package emits.
 */
export interface ValidationErrorResponse {
  statusCode: 400;
  error: "Validation Error";
  message: string;
  fields: Record<string, string[]>;
  timestamp: string;
  path: string;
  requestId: string;
}

/**
 * Builds the response body for a {@link ValidationError}.
 *
 * Returns the canonical `{ error: { ... }, timestamp, path, requestId }` shape
 * that {@link createErrorHandler} sends, so there is a single payload format
 * rather than two. Pass it to `reply.status(400).send(...)` from a
 * `customHandler` to keep validation failures consistent.
 */
export function formatValidationError(
  error: ValidationError,
  request: FastifyRequest,
  options: PayloadOptions = {}
): Record<string, unknown> {
  return buildPayload(error, request, options);
}

/** Stable machine-readable codes, one per error class plus `UNKNOWN_ERROR`. */
export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  AUTHENTICATION_ERROR: "AUTHENTICATION_ERROR",
  AUTHORIZATION_ERROR: "AUTHORIZATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  BAD_REQUEST: "BAD_REQUEST",
  UNPROCESSABLE_ENTITY: "UNPROCESSABLE_ENTITY",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  TIMEOUT: "TIMEOUT",
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
  DATABASE_ERROR: "DATABASE_ERROR",
  CONNECTION_ERROR: "CONNECTION_ERROR",
  EXTERNAL_SERVICE_ERROR: "EXTERNAL_SERVICE_ERROR",
  KAFKA_ERROR: "KAFKA_ERROR",
  REDIS_ERROR: "REDIS_ERROR",
  WEBSOCKET_ERROR: "WEBSOCKET_ERROR",
  ENCRYPTION_ERROR: "ENCRYPTION_ERROR",
  SERIALIZATION_ERROR: "SERIALIZATION_ERROR",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  AGGREGATE_ERROR: "AGGREGATE_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

/** Narrows a string to a known {@link ErrorCode}. */
export function isErrorCode(code: string): code is ErrorCode {
  return Object.values(ERROR_CODES).includes(code as ErrorCode);
}

/**
 * Builds a bare error body for transports that do not wrap it in the canonical
 * envelope.
 *
 * @deprecated This produced a fourth payload shape, inconsistent with the
 * handler, {@link formatValidationError}, and {@link formatError}. Use
 * `formatError(new AppError(message, code, statusCode, details))` instead.
 */
export function createErrorResponse(
  code: ErrorCode,
  message: string,
  statusCode: number,
  details?: Record<string, unknown>
): Record<string, unknown> {
  return formatError(new AppError(message, code, statusCode, details));
}