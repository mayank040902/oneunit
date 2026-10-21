import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply } from "fastify";

// ============================================================================
// 1. HTTP STATUS CATALOG
// ============================================================================

export const HTTP_STATUS = {
    // 2xx — successful
    OK: 200,
    CREATED: 201,
    ACCEPTED: 202,
    NON_AUTHORITATIVE_INFORMATION: 203,
    NO_CONTENT: 204,
    RESET_CONTENT: 205,
    PARTIAL_CONTENT: 206,
    MULTI_STATUS: 207,
    ALREADY_REPORTED: 208,
    IM_USED: 226,

    // 3xx — redirects / caching (use Fastify redirect handling where relevant)
    MULTIPLE_CHOICES: 300,
    MOVED_PERMANENTLY: 301,
    FOUND: 302,
    SEE_OTHER: 303,
    NOT_MODIFIED: 304,
    TEMPORARY_REDIRECT: 307,
    PERMANENT_REDIRECT: 308,

    // 4xx — client errors
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    PAYMENT_REQUIRED: 402,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    NOT_ACCEPTABLE: 406,
    PROXY_AUTHENTICATION_REQUIRED: 407,
    REQUEST_TIMEOUT: 408,
    CONFLICT: 409,
    GONE: 410,
    LENGTH_REQUIRED: 411,
    PRECONDITION_FAILED: 412,
    PAYLOAD_TOO_LARGE: 413,
    URI_TOO_LONG: 414,
    UNSUPPORTED_MEDIA_TYPE: 415,
    RANGE_NOT_SATISFIABLE: 416,
    EXPECTATION_FAILED: 417,
    IM_A_TEAPOT: 418,
    MISDIRECTED_REQUEST: 421,
    UNPROCESSABLE_ENTITY: 422,
    LOCKED: 423,
    FAILED_DEPENDENCY: 424,
    TOO_EARLY: 425,
    UPGRADE_REQUIRED: 426,
    PRECONDITION_REQUIRED: 428,
    TOO_MANY_REQUESTS: 429,
    REQUEST_HEADER_FIELDS_TOO_LARGE: 431,
    UNAVAILABLE_FOR_LEGAL_REASONS: 451,

    // 5xx — server errors
    INTERNAL_SERVER_ERROR: 500,
    NOT_IMPLEMENTED: 501,
    BAD_GATEWAY: 502,
    SERVICE_UNAVAILABLE: 503,
    GATEWAY_TIMEOUT: 504,
    HTTP_VERSION_NOT_SUPPORTED: 505,
    VARIANT_ALSO_NEGOTIATES: 506,
    INSUFFICIENT_STORAGE: 507,
    LOOP_DETECTED: 508,
    NOT_EXTENDED: 510,
    NETWORK_AUTHENTICATION_REQUIRED: 511,
} as const;

export type HttpStatusCode =
    (typeof HTTP_STATUS)[keyof typeof HTTP_STATUS];

// ============================================================================
// 2. RESPONSE TYPES
// ============================================================================

export interface FieldError {
    field: string;
    message: string;
    code?: string;
}

export interface ApiResponse<T = unknown> {
    success: boolean;
    /** Application code or, by default, the HTTP status as a string. */
    code: string;
    /** Human-readable response message. */
    msg: string;
    /** Present when data is explicitly provided. */
    data?: T;
    /** Pagination, request ID, trace ID, or other safe context. */
    metadata?: Record<string, unknown>;
    /** Structured field-level or domain validation errors. */
    errors?: FieldError[];
}

export interface SuccessResponse<T = unknown> extends ApiResponse<T> {
    success: true;
}

export interface ErrorResponse<T = unknown> extends ApiResponse<T> {
    success: false;
}

export interface ResponseOptions<T = unknown> {
    message?: string;
    data?: T;
    /** Application code, e.g. USER_CREATED. Does not control HTTP status. */
    code?: string;
    metadata?: Record<string, unknown>;
}

export interface ErrorOptions<T = unknown> extends ResponseOptions<T> {
    errors?: FieldError[];
}

export interface ErrorResponseOptions<T = unknown> extends ErrorOptions<T> {
    status: number;
}

export interface PaginationMeta {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export interface PaginatedOptions<T> extends ResponseOptions<T[]> {
    data: T[];
    pagination: PaginationMeta;
}

/** Input accepted by the `reply.respond()` helper. */
export interface RespondOptions<T = unknown> {
    /** The HTTP status to answer with. */
    status: number;
    /** Envelope content. `errors` is only valid on 4xx/5xx responses. */
    response?: ErrorOptions<T>;
    /** Field-level errors. Shorthand for `response.errors`. */
    errors?: FieldError[];
}

export interface ResponseManagementOptions {
    /**
     * Message used by `reply.ok()` and `reply.success()` when the call does not
     * provide one. Defaults to "Success".
     */
    defaultSuccessMessage?: string;
    /**
     * Message used by `reply.error()` and `reply.failed()` when the call does
     * not provide one. Defaults to "Request failed". The status-specific
     * helpers (`reply.notFound()`, `reply.conflict()`, …) keep their own
     * message unless the call overrides it.
     */
    defaultErrorMessage?: string;
    /** Add the request id to `metadata` of every envelope. Defaults to `true`. */
    includeRequestId?: boolean;
}

/** Options accepted by the response management plugin. */
export type ResponseManagementPluginOptions = ResponseManagementOptions;

/**
 * @deprecated Misspelled alias kept for backwards compatibility.
 * Use {@link ResponseManagementPluginOptions} instead.
 */
export type ResponseManagmentPluginOptions = ResponseManagementOptions;

// ============================================================================
// 3. RESPONSE DEFINITIONS — ONE SOURCE OF TRUTH
// ============================================================================

export const ERROR_RESPONSES = {
    badRequest: { status: 400, message: "Bad request" },
    unauthorized: { status: 401, message: "Authentication required" },
    paymentRequired: { status: 402, message: "Payment required" },
    forbidden: { status: 403, message: "Access forbidden" },
    notFound: { status: 404, message: "Resource not found" },
    methodNotAllowed: { status: 405, message: "Method not allowed" },
    notAcceptable: { status: 406, message: "Acceptable representation not available" },
    proxyAuthenticationRequired: { status: 407, message: "Proxy authentication required" },
    requestTimeout: { status: 408, message: "Request timeout" },
    conflict: { status: 409, message: "Resource conflict" },
    gone: { status: 410, message: "Resource is no longer available" },
    lengthRequired: { status: 411, message: "Content length required" },
    preconditionFailed: { status: 412, message: "Request precondition failed" },
    payloadTooLarge: { status: 413, message: "Request payload too large" },
    uriTooLong: { status: 414, message: "Request URI too long" },
    unsupportedMediaType: { status: 415, message: "Unsupported media type" },
    rangeNotSatisfiable: { status: 416, message: "Requested range not satisfiable" },
    expectationFailed: { status: 417, message: "Request expectation failed" },
    imATeapot: { status: 418, message: "I'm a teapot" },
    misdirectedRequest: { status: 421, message: "Misdirected request" },
    unprocessable: { status: 422, message: "Request could not be processed" },
    validationError: { status: 422, message: "Validation failed" },
    locked: { status: 423, message: "Resource is locked" },
    failedDependency: { status: 424, message: "Dependent request failed" },
    tooEarly: { status: 425, message: "Request cannot be processed safely yet" },
    upgradeRequired: { status: 426, message: "Protocol upgrade required" },
    preconditionRequired: { status: 428, message: "Request precondition required" },
    tooManyRequests: { status: 429, message: "Too many requests" },
    requestHeaderFieldsTooLarge: { status: 431, message: "Request header fields too large" },
    unavailableForLegalReasons: { status: 451, message: "Unavailable for legal reasons" },

    serverError: { status: 500, message: "Internal server error" },
    notImplemented: { status: 501, message: "Not implemented" },
    badGateway: { status: 502, message: "Bad gateway" },
    serviceUnavailable: { status: 503, message: "Service unavailable" },
    gatewayTimeout: { status: 504, message: "Gateway timeout" },
    httpVersionNotSupported: { status: 505, message: "HTTP version not supported" },
    variantAlsoNegotiates: { status: 506, message: "Variant also negotiates" },
    insufficientStorage: { status: 507, message: "Insufficient storage" },
    loopDetected: { status: 508, message: "Loop detected" },
    notExtended: { status: 510, message: "Not extended" },
    networkAuthenticationRequired: { status: 511, message: "Network authentication required" },
} as const satisfies Record<string, { status: number; message: string }>;

export const SUCCESS_RESPONSES = {
    ok: { status: 200, message: "Success" },
    created: { status: 201, message: "Resource created successfully" },
    accepted: { status: 202, message: "Request accepted" },
    nonAuthoritativeInformation: { status: 203, message: "Non-authoritative information" },
    partialContent: { status: 206, message: "Partial content" },
    multiStatus: { status: 207, message: "Multiple operation results" },
    alreadyReported: { status: 208, message: "Resource already reported" },
    imUsed: { status: 226, message: "Instance manipulation applied" },
} as const satisfies Record<string, { status: number; message: string }>;

/** Name of every error helper registered by the plugin. */
export type ErrorResponseName = keyof typeof ERROR_RESPONSES;

/** Name of every success helper registered by the plugin. */
export type SuccessResponseName = keyof typeof SUCCESS_RESPONSES;

// ============================================================================
// 4. RESPONSE BUILDER
// ============================================================================

/** Statuses that must not carry a response body. */
const BODYLESS_STATUSES: readonly number[] = [
    HTTP_STATUS.NO_CONTENT,
    HTTP_STATUS.RESET_CONTENT,
    HTTP_STATUS.NOT_MODIFIED,
];

export class ResponseManager {
    readonly options: Required<ResponseManagementOptions>;

    constructor(options: ResponseManagementOptions = {}) {
        this.options = {
            defaultSuccessMessage: options.defaultSuccessMessage ?? "Success",
            defaultErrorMessage: options.defaultErrorMessage ?? "Request failed",
            includeRequestId: options.includeRequestId ?? true,
        };
    }

    success<T = unknown>(
        options: ResponseOptions<T> = {},
        status: number = HTTP_STATUS.OK,
    ): SuccessResponse<T> {
        this.assertStatus(status, 200, 299);
        this.assertBodyAllowed(status);

        return {
            success: true,
            code: options.code ?? String(status),
            msg: options.message ?? this.options.defaultSuccessMessage,
            ...(options.data !== undefined ? { data: options.data } : {}),
            ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
        };
    }

    error<T = unknown>(options: ErrorResponseOptions<T>): ErrorResponse<T> {
        this.assertStatus(options.status, 400, 599);

        return {
            success: false,
            code: options.code ?? String(options.status),
            msg: options.message ?? this.options.defaultErrorMessage,
            ...(options.data !== undefined ? { data: options.data } : {}),
            ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
            ...(options.errors !== undefined ? { errors: options.errors } : {}),
        };
    }

    paginated<T>(options: PaginatedOptions<T>): SuccessResponse<T[]> {
        const { pagination, metadata, ...responseOptions } = options;
        this.assertPagination(pagination);

        return this.success({
            ...responseOptions,
            metadata: { ...metadata, pagination },
        });
    }

    static pagination(total: number, page: number, pageSize: number): PaginationMeta {
        for (const [name, value] of Object.entries({ total, page, pageSize })) {
            if (!Number.isSafeInteger(value)) {
                throw new RangeError(`${name} must be a safe integer`);
            }
        }

        if (total < 0 || page < 1 || pageSize < 1) {
            throw new RangeError("total must be >= 0; page and pageSize must be >= 1");
        }

        return {
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }

    private assertPagination(pagination: PaginationMeta): void {
        const expected = ResponseManager.pagination(
            pagination.total,
            pagination.page,
            pagination.pageSize,
        );

        if (pagination.totalPages !== expected.totalPages) {
            throw new RangeError("pagination.totalPages does not match total and pageSize");
        }
    }

    private assertStatus(status: number, min: number, max: number): void {
        if (!Number.isInteger(status) || status < min || status > max) {
            throw new RangeError(`Expected HTTP status ${min}-${max}; received ${status}`);
        }
    }

    private assertBodyAllowed(status: number): void {
        if (BODYLESS_STATUSES.includes(status)) {
            throw new RangeError(
                `HTTP ${status} responses cannot carry a body; use reply.noContent() or reply.respond({ status: ${status} }).`,
            );
        }
    }
}

// ============================================================================
// 5. FASTIFY TYPE AUGMENTATION
// ============================================================================

declare module "fastify" {
    interface FastifyReply {
        respond<T = unknown>(options: RespondOptions<T>): FastifyReply;

        ok<T = unknown>(options?: ResponseOptions<T>): FastifyReply;
        success<T = unknown>(options?: ResponseOptions<T>): FastifyReply;
        created<T = unknown>(options?: ResponseOptions<T>): FastifyReply;
        accepted<T = unknown>(options?: ResponseOptions<T>): FastifyReply;
        noContent(): FastifyReply;
        paginated<T>(options: PaginatedOptions<T>): FastifyReply;
        error<T = unknown>(options: ErrorResponseOptions<T>): FastifyReply;
        failed<T = unknown>(options?: ErrorOptions<T> & { status?: number }): FastifyReply;

        badRequest<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        unauthorized<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        paymentRequired<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        forbidden<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        notFound<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        methodNotAllowed<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        notAcceptable<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        proxyAuthenticationRequired<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        requestTimeout<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        conflict<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        gone<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        lengthRequired<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        preconditionFailed<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        payloadTooLarge<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        uriTooLong<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        unsupportedMediaType<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        rangeNotSatisfiable<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        expectationFailed<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        imATeapot<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        misdirectedRequest<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        unprocessable<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        validationError<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        locked<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        failedDependency<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        tooEarly<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        upgradeRequired<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        preconditionRequired<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        tooManyRequests<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        requestHeaderFieldsTooLarge<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        unavailableForLegalReasons<T = unknown>(options?: ErrorOptions<T>): FastifyReply;

        serverError<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        notImplemented<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        badGateway<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        serviceUnavailable<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        gatewayTimeout<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        httpVersionNotSupported<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        variantAlsoNegotiates<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        insufficientStorage<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        loopDetected<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        notExtended<T = unknown>(options?: ErrorOptions<T>): FastifyReply;
        networkAuthenticationRequired<T = unknown>(options?: ErrorOptions<T>): FastifyReply;

        nonAuthoritativeInformation<T = unknown>(options?: ResponseOptions<T>): FastifyReply;
        partialContent<T = unknown>(options?: ResponseOptions<T>): FastifyReply;
        multiStatus<T = unknown>(options?: ResponseOptions<T>): FastifyReply;
        alreadyReported<T = unknown>(options?: ResponseOptions<T>): FastifyReply;
        imUsed<T = unknown>(options?: ResponseOptions<T>): FastifyReply;
    }
}

// ============================================================================
// 6. FASTIFY PLUGIN
// ============================================================================

/** Envelope members that make a response carry content. */
const ENVELOPE_CONTENT_KEYS = ["data", "message", "code", "metadata"] as const;

function hasEnvelopeContent(options: ResponseOptions<unknown>): boolean {
    return ENVELOPE_CONTENT_KEYS.some((key) => options[key] !== undefined);
}

async function responseManagementPlugin(
    server: FastifyInstance,
    options: ResponseManagementOptions = {},
): Promise<void> {
    const manager = new ResponseManager(options);
    const config = manager.options;

    const successNames = Object.keys(SUCCESS_RESPONSES) as SuccessResponseName[];
    const errorNames = Object.keys(ERROR_RESPONSES) as ErrorResponseName[];
    const names = [
        "respond", "ok", "success", "created", "accepted", "noContent",
        "paginated", "error", "failed",
        ...successNames,
        ...errorNames,
    ];

    // Detect conflicts before decorating anything.
    const uniqueNames = [...new Set(names)];
    for (const name of uniqueNames) {
        if (server.hasReplyDecorator(name)) {
            throw new Error(`Cannot register reply decorator "${name}": name already exists`);
        }
    }

    const addRequestId = (
        reply: FastifyReply,
        metadata?: Record<string, unknown>,
    ): Record<string, unknown> | undefined => {
        if (!config.includeRequestId) return metadata;
        return { ...metadata, requestId: reply.request.id };
    };

    const sendSuccess = <T>(
        reply: FastifyReply,
        status: number,
        responseOptions: ResponseOptions<T> = {},
    ): FastifyReply => {
        if (!Number.isInteger(status) || status < 200 || status > 299) {
            throw new RangeError(`Invalid JSON success status: ${status}`);
        }
        if (BODYLESS_STATUSES.includes(status)) {
            throw new RangeError(
                `HTTP ${status} responses cannot carry a body; use reply.noContent() or reply.respond({ status: ${status} }).`,
            );
        }

        const response = manager.success({
            ...responseOptions,
            metadata: addRequestId(reply, responseOptions.metadata),
        }, status);

        return reply.code(status).send(response);
    };

    const sendError = <T>(
        reply: FastifyReply,
        status: number,
        responseOptions: ErrorOptions<T> = {},
    ): FastifyReply => {
        if (!Number.isInteger(status) || status < 400 || status > 599) {
            throw new RangeError(`Invalid JSON error status: ${status}`);
        }

        const response = manager.error({
            ...responseOptions,
            status,
            metadata: addRequestId(reply, responseOptions.metadata),
        });

        return reply.code(status).send(response);
    };

    server.decorateReply("respond", function <T>(
        this: FastifyReply,
        input: RespondOptions<T>,
    ) {
        const { status, response = {}, errors } = input;

        if (!Number.isInteger(status) || status < 200 || status > 599) {
            throw new RangeError(`Invalid HTTP status: ${status}`);
        }
        if (status >= 300 && status < 400 && status !== HTTP_STATUS.NOT_MODIFIED) {
            throw new RangeError("Use Fastify redirect handling for 3xx responses");
        }
        if (BODYLESS_STATUSES.includes(status)) {
            if (hasEnvelopeContent(response) || errors !== undefined) {
                throw new Error(`${status} responses cannot include this response envelope`);
            }
            return this.code(status).send();
        }
        if (status >= 400) {
            if (response.errors !== undefined && errors !== undefined) {
                throw new Error("Pass field errors either as `response.errors` or as `errors`, not both");
            }
            return sendError(this, status, {
                ...response,
                ...(errors !== undefined ? { errors } : {}),
            });
        }
        if (errors !== undefined || response.errors !== undefined) {
            throw new Error("Field errors are only valid on 4xx/5xx responses");
        }
        return sendSuccess(this, status, response);
    });

    server.decorateReply("ok", function <T>(
        this: FastifyReply, responseOptions: ResponseOptions<T> = {},
    ) {
        return sendSuccess(this, 200, {
            message: config.defaultSuccessMessage,
            ...responseOptions,
        });
    });

    server.decorateReply("success", function <T>(
        this: FastifyReply, responseOptions: ResponseOptions<T> = {},
    ) {
        return sendSuccess(this, 200, {
            message: config.defaultSuccessMessage,
            ...responseOptions,
        });
    });

    server.decorateReply("created", function <T>(
        this: FastifyReply, responseOptions: ResponseOptions<T> = {},
    ) {
        return sendSuccess(this, 201, {
            message: SUCCESS_RESPONSES.created.message,
            ...responseOptions,
        });
    });

    server.decorateReply("accepted", function <T>(
        this: FastifyReply, responseOptions: ResponseOptions<T> = {},
    ) {
        return sendSuccess(this, 202, {
            message: SUCCESS_RESPONSES.accepted.message,
            ...responseOptions,
        });
    });

    server.decorateReply("noContent", function (this: FastifyReply) {
        return this.code(HTTP_STATUS.NO_CONTENT).send();
    });

    server.decorateReply("paginated", function <T>(
        this: FastifyReply, input: PaginatedOptions<T>,
    ) {
        const { pagination, metadata, ...rest } = input;
        const response = manager.paginated({
            ...rest,
            pagination,
            metadata: addRequestId(this, metadata),
        });
        return this.code(HTTP_STATUS.OK).send(response);
    });

    server.decorateReply("error", function <T>(
        this: FastifyReply, input: ErrorResponseOptions<T>,
    ) {
        const { status, ...responseOptions } = input;
        return sendError(this, status, responseOptions);
    });

    server.decorateReply("failed", function <T>(
        this: FastifyReply,
        input: (ErrorOptions<T> & { status?: number }) = {},
    ) {
        const { status = HTTP_STATUS.BAD_REQUEST, ...responseOptions } = input;
        return sendError(this, status, responseOptions);
    });

    // Register all additional success helpers from the catalog.
    for (const [name, definition] of Object.entries(SUCCESS_RESPONSES)) {
        if (["ok", "created", "accepted"].includes(name)) continue;

        server.decorateReply(name, function <T>(
            this: FastifyReply,
            responseOptions: ResponseOptions<T> = {},
        ) {
            return sendSuccess(this, definition.status, {
                message: definition.message,
                ...responseOptions,
            });
        });
    }

    // Register every 4xx/5xx helper from one source of truth.
    for (const [name, definition] of Object.entries(ERROR_RESPONSES)) {
        server.decorateReply(name, function <T>(
            this: FastifyReply,
            responseOptions: ErrorOptions<T> = {},
        ) {
            return sendError(this, definition.status, {
                message: definition.message,
                ...responseOptions,
            });
        });
    }
}

export default fp(responseManagementPlugin, {
    name: "response-management",
    fastify: "5.x",
});

export { responseManagementPlugin };
