import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
    resolveMetadataLimits,
    sanitizeMetadata,
    type MetadataLimits,
    type SensitiveMetadataKey,
} from "./response-metadata.js";

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/** Standard envelope returned by every API endpoint. */
export interface ApiResponse<T = unknown> {
    /** Whether the request succeeded. */
    success: boolean;
    /**
     * Application-level code. The HTTP status as a string on a success
     * ("200", "201"); the platform error code on a failure ("BAD_REQUEST",
     * "NOT_FOUND"), so a failure reads the same whether the handler or the
     * framework raised it.
     */
    code: string;
    /** Human-readable message. */
    message: string;
    /** Response payload – present on successes, and on failures that carry one. */
    data?: T;
    /** Optional extra context (pagination, trace-ids, …). */
    metadata?: Record<string, unknown>;
}

/** Pagination metadata that can be attached to list responses. */
export interface PaginationMeta {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

/** Payload carried by a validation failure. */
export interface ValidationErrorPayload {
    /** Field path to the messages reported for that field. */
    fields: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Fields every response helper accepts.
 *
 * The helpers take their parts by name rather than by position. A positional
 * API cannot say which argument is the message and which is the payload:
 * `data` and `metadata` share a type, so a swapped argument type-checked and
 * then failed silently, and the order was not even consistent across the
 * family — a success took the payload first while a failure took the message
 * first.
 */
export interface ResponseOptions {
    /** Human-readable message for the caller. */
    message?: string;
    /** Application-level status code, e.g. "200" or "NOT_FOUND". */
    code?: string;
    /** Extra context. Sanitised before it is sent. */
    metadata?: Record<string, unknown>;
}

/** A successful response. */
export interface SuccessOptions<T = unknown> extends ResponseOptions {
    /** The payload. */
    data: T;
}

/** A deletion response, which may not carry a payload. */
export interface DeletionOptions<T = unknown> extends ResponseOptions {
    /** The payload, if the deletion produced one. */
    data?: T;
}

/** A paginated list response. */
export interface PaginatedOptions<T = unknown> extends ResponseOptions {
    /** The rows of the current page. */
    data: T[];
    /** Counts describing the whole result set. */
    pagination: PaginationMeta;
}

/** A failed response. */
export interface FailureOptions extends ResponseOptions {
    /** Structured payload describing the failure. */
    data?: object;
}

/** A failed response whose HTTP status is derived from its code. */
export interface FailedOptions extends FailureOptions {
    /** Explicit HTTP status. Overrides the status derived from `code`. */
    statusCode?: number;
}

/** A validation failure. */
export interface ValidationFailedOptions extends ResponseOptions {
    /** Field path to the messages reported for that field. */
    fields: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Call-site guards
// ---------------------------------------------------------------------------

const describeValue = (value: unknown): string => {
    if (value === null) return "null";
    if (Array.isArray(value)) return "an array";
    return `a ${typeof value}`;
};

function asOptions<T extends object>(method: string, value: unknown): T {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(
            `reply.${method} expects an options object such as { data, message, code, metadata }, ` +
            `but received ${describeValue(value)}. Positional arguments are no longer supported.`,
        );
    }
    return value as T;
}

function asOptionalOptions<T extends object>(method: string, value: unknown): T {
    if (value === undefined) return {} as T;
    return asOptions<T>(method, value);
}

function requireDataKey(method: string, options: object): void {
    if (!("data" in options)) {
        throw new TypeError(
            `reply.${method} expects an options object with a "data" property, ` +
            `such as { data, message, code, metadata }.`,
        );
    }
}

// ---------------------------------------------------------------------------
// Status resolution
// ---------------------------------------------------------------------------

/**
 * HTTP status for the symbolic application-level codes used across the
 * platform. `code` stays a string so clients can branch on it, but a symbolic
 * code must still reach the client as the right HTTP status rather than
 * silently degrading to 400.
 */
const CODE_HTTP_STATUS: Readonly<Record<string, number>> = {
    BAD_REQUEST: 400,
    VALIDATION_ERROR: 400,
    UNAUTHORIZED: 401,
    AUTHENTICATION_ERROR: 401,
    FORBIDDEN: 403,
    AUTHORIZATION_ERROR: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    PAYLOAD_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415,
    UNPROCESSABLE_ENTITY: 422,
    TOO_MANY_REQUESTS: 429,
    RATE_LIMIT_EXCEEDED: 429,
    INTERNAL_ERROR: 500,
    UNKNOWN_ERROR: 500,
    SERVICE_UNAVAILABLE: 503,
    TIMEOUT: 504,
};

/**
 * Resolves the HTTP status for an application-level code.
 *
 * A numeric code is used as-is when it is a valid HTTP status. A symbolic code
 * is looked up in {@link CODE_HTTP_STATUS}. Anything else falls back.
 */
export function resolveHttpStatus(code?: string, fallback = 400): number {
    if (code === undefined) return fallback;

    const numeric = Number(code);
    if (Number.isFinite(numeric) && numeric >= 100 && numeric <= 599) return numeric;

    return CODE_HTTP_STATUS[code.toUpperCase()] ?? fallback;
}

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

export interface ResponseManagementPluginOptions {
    /**
     * Redact sensitive keys in response metadata. `true` (default) masks the
     * built-in key list, an array overrides that list, `false` disables
     * redaction. Only `metadata` is affected; the `data` payload is never
     * rewritten.
     */
    redactMetadata?: boolean | readonly SensitiveMetadataKey[];
    /** Bounds on response metadata size. */
    metadataLimits?: MetadataLimits;
    /** Default `message` used by the success helpers. Defaults to "Success". */
    defaultMessage?: string;
    /** Default `code` used by the success helpers. Defaults to "200". */
    defaultCode?: string;
}

// ---------------------------------------------------------------------------
// ResponseManager
// ---------------------------------------------------------------------------

/**
 * Utility class for building standardised {@link ApiResponse} objects.
 * Instantiate once and reuse across the process.
 *
 * Metadata is sanitised on the way out: sensitive keys are masked and the
 * payload is bounded, so a handler that echoes user input cannot leak a
 * credential to the client.
 */
export class ResponseManager {
    constructor(
        private readonly defaultMessage: string = "Success",
        private readonly defaultCode: string = "200",
        private readonly options: ResponseManagementPluginOptions = {},
    ) {}

    // ------------------------------------------------------------------
    // Success helpers
    // ------------------------------------------------------------------

    /** Generic 2xx success response. */
    success<T = unknown>(options: SuccessOptions<T>): ApiResponse<T> {
        const opts = asOptions<SuccessOptions<T>>("success", options);
        requireDataKey("success", opts);

        return {
            success: true,
            code: opts.code ?? this.defaultCode,
            message: opts.message ?? this.defaultMessage,
            data: opts.data,
            metadata: this.cleanMetadata(opts.metadata),
        };
    }

    /** Resource created (HTTP 201). */
    created<T = unknown>(options: SuccessOptions<T>): ApiResponse<T> {
        const opts = asOptions<SuccessOptions<T>>("created", options);
        requireDataKey("created", opts);

        return {
            success: true,
            code: opts.code ?? "201",
            message: opts.message ?? "Resource created successfully",
            data: opts.data,
            metadata: this.cleanMetadata(opts.metadata),
        };
    }

    /** Resource updated (HTTP 200). */
    updated<T = unknown>(options: SuccessOptions<T>): ApiResponse<T> {
        const opts = asOptions<SuccessOptions<T>>("updated", options);
        requireDataKey("updated", opts);

        return {
            success: true,
            code: opts.code ?? "200",
            message: opts.message ?? "Resource updated successfully",
            data: opts.data,
            metadata: this.cleanMetadata(opts.metadata),
        };
    }

    /** Resource deleted (HTTP 200). */
    deleted<T = unknown>(options?: DeletionOptions<T>): ApiResponse<T | undefined> {
        const opts = asOptionalOptions<DeletionOptions<T>>("deleted", options);

        return {
            success: true,
            code: opts.code ?? "200",
            message: opts.message ?? "Resource deleted successfully",
            data: opts.data,
            metadata: this.cleanMetadata(opts.metadata),
        };
    }

    /** Paginated list response. */
    paginated<T = unknown>(options: PaginatedOptions<T>): ApiResponse<T[]> {
        const opts = asOptions<PaginatedOptions<T>>("paginated", options);
        requireDataKey("paginated", opts);

        return {
            success: true,
            code: opts.code ?? "200",
            message: opts.message ?? "Data retrieved successfully",
            data: opts.data,
            metadata: this.cleanMetadata({ ...opts.metadata, pagination: opts.pagination }),
        };
    }

    // ------------------------------------------------------------------
    // Error helpers
    // ------------------------------------------------------------------

    /**
     * Generic failure (HTTP 400 by default).
     *
     * The HTTP status is derived from `code` unless `statusCode` says
     * otherwise; see {@link resolveHttpStatus}.
     */
    failed(options?: FailedOptions): ApiResponse<object | undefined> {
        const opts = asOptionalOptions<FailedOptions>("failed", options);

        return {
            success: false,
            code: opts.code ?? "BAD_REQUEST",
            message: opts.message ?? "Request failed",
            data: opts.data,
            metadata: this.cleanMetadata(opts.metadata),
        };
    }

    /** 400 Bad Request. */
    badRequest(options?: FailureOptions): ApiResponse<object | undefined> {
        return this.failure("badRequest", "BAD_REQUEST", "Bad request", options);
    }

    /** 401 Unauthorized. */
    unauthorized(options?: FailureOptions): ApiResponse<object | undefined> {
        return this.failure("unauthorized", "AUTHENTICATION_ERROR", "Unauthorized", options);
    }

    /** 403 Forbidden. */
    forbidden(options?: FailureOptions): ApiResponse<object | undefined> {
        return this.failure("forbidden", "AUTHORIZATION_ERROR", "Forbidden", options);
    }

    /** 404 Not Found. */
    notFound(options?: FailureOptions): ApiResponse<object | undefined> {
        return this.failure("notFound", "NOT_FOUND", "Resource not found", options);
    }

    /** 409 Conflict. */
    conflict(options?: FailureOptions): ApiResponse<object | undefined> {
        return this.failure("conflict", "CONFLICT", "Conflict", options);
    }

    /** 422 Unprocessable Entity. */
    unprocessable(options?: FailureOptions): ApiResponse<object | undefined> {
        return this.failure("unprocessable", "UNPROCESSABLE_ENTITY", "Unprocessable entity", options);
    }

    /** 500 Internal Server Error. */
    serverError(options?: FailureOptions): ApiResponse<object | undefined> {
        return this.failure("serverError", "INTERNAL_ERROR", "Internal server error", options);
    }

    /**
     * 400 – validation failure.
     *
     * `fields` maps a field path to the messages for that field, which is the
     * shape a client binds to its inputs. Build it from the issues of a
     * validation library with `toValidationFields` rather than forwarding the
     * raw issues, which carry validator internals meant for developers.
     */
    validationFailed(options: ValidationFailedOptions): ApiResponse<ValidationErrorPayload> {
        const opts = asOptions<ValidationFailedOptions>("validationFailed", options);
        const limits = resolveMetadataLimits(this.options.metadataLimits);
        const entries = Object.entries(opts.fields ?? {}).slice(0, limits.maxKeys);

        return {
            success: false,
            code: opts.code ?? "VALIDATION_ERROR",
            message: opts.message ?? "Validation failed",
            data: { fields: Object.fromEntries(entries) },
            metadata: this.cleanMetadata(opts.metadata),
        };
    }

    // ------------------------------------------------------------------
    // Envelope post-processing
    // ------------------------------------------------------------------

    /**
     * Applies the configured metadata sanitisation to an already-built
     * envelope, so an envelope that was assembled by hand is held to the same
     * standard as one produced by this class.
     */
    sanitizeEnvelope<T>(response: ApiResponse<T>): ApiResponse<T> {
        if (response.metadata === undefined) return response;
        return { ...response, metadata: this.cleanMetadata(response.metadata) };
    }

    private failure(
        method: string,
        code: string,
        message: string,
        options: FailureOptions | undefined
    ): ApiResponse<object | undefined> {
        const opts = asOptionalOptions<FailureOptions>(method, options);

        return {
            success: false,
            code: opts.code ?? code,
            message: opts.message ?? message,
            data: opts.data,
            metadata: this.cleanMetadata(opts.metadata),
        };
    }

    private cleanMetadata(
        metadata?: Record<string, unknown>
    ): Record<string, unknown> | undefined {
        return sanitizeMetadata(metadata, {
            redact: this.options.redactMetadata,
            limits: this.options.metadataLimits,
        });
    }
}

// ---------------------------------------------------------------------------
// Fastify type augmentation
// ---------------------------------------------------------------------------

declare module "fastify" {
    interface FastifyReply {
        /** Send a pre-built {@link ApiResponse} with an explicit HTTP status code. */
        response<T>(response: ApiResponse<T>, statusCode?: number): FastifyReply;
        /** 200 – generic success. */
        success<T>(options: SuccessOptions<T>): FastifyReply;
        /** 201 – resource created. */
        created<T>(options: SuccessOptions<T>): FastifyReply;
        /** 200 – resource updated. */
        updated<T>(options: SuccessOptions<T>): FastifyReply;
        /** 200 – resource deleted. */
        deleted<T>(options: DeletionOptions<T>): FastifyReply;
        /** 200 – paginated list. */
        paginated<T>(options: PaginatedOptions<T>): FastifyReply;
        /** 4xx/5xx – generic failure. */
        failed(options?: FailedOptions): FastifyReply;
        /** 400 – bad request. */
        badRequest(options?: FailureOptions): FastifyReply;
        /** 401 – unauthorized. */
        unauthorized(options?: FailureOptions): FastifyReply;
        /** 403 – forbidden. */
        forbidden(options?: FailureOptions): FastifyReply;
        /** 404 – not found. */
        notFound(options?: FailureOptions): FastifyReply;
        /** 409 – conflict. */
        conflict(options?: FailureOptions): FastifyReply;
        /** 422 – unprocessable entity. */
        unprocessable(options?: FailureOptions): FastifyReply;
        /** 500 – internal server error. */
        serverError(options?: FailureOptions): FastifyReply;
        /** 400 – validation failure with a field-keyed error map. */
        validationFailed(options: ValidationFailedOptions): FastifyReply;
    }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Fastify plugin that decorates every {@link FastifyReply} with typed
 * response helpers backed by {@link ResponseManager}.
 */
async function responseManagementPlugin(
    server: FastifyInstance,
    options: ResponseManagementPluginOptions = {}
): Promise<void> {
    const manager = new ResponseManager(
        options.defaultMessage ?? "Success",
        options.defaultCode ?? "200",
        options,
    );

    server.decorateReply(
        "response",
        function <T>(this: FastifyReply, response: ApiResponse<T>, statusCode = 200) {
            return this.code(statusCode).send(manager.sanitizeEnvelope(response));
        }
    );

    server.decorateReply(
        "success",
        function <T>(this: FastifyReply, options: SuccessOptions<T>) {
            return this.code(200).send(manager.success(options));
        }
    );

    server.decorateReply(
        "created",
        function <T>(this: FastifyReply, options: SuccessOptions<T>) {
            return this.code(201).send(manager.created(options));
        }
    );

    server.decorateReply(
        "updated",
        function <T>(this: FastifyReply, options: SuccessOptions<T>) {
            return this.code(200).send(manager.updated(options));
        }
    );

    server.decorateReply(
        "deleted",
        function <T>(this: FastifyReply, options?: DeletionOptions<T>) {
            return this.code(200).send(manager.deleted(options));
        }
    );

    server.decorateReply(
        "paginated",
        function <T>(this: FastifyReply, options: PaginatedOptions<T>) {
            return this.code(200).send(manager.paginated(options));
        }
    );

    server.decorateReply(
        "failed",
        function (this: FastifyReply, options?: FailedOptions) {
            const opts = asOptionalOptions<FailedOptions>("failed", options);
            const httpStatus = opts.statusCode ?? resolveHttpStatus(opts.code, 400);
            return this.code(httpStatus).send(manager.failed(opts));
        }
    );

    server.decorateReply(
        "badRequest",
        function (this: FastifyReply, options?: FailureOptions) {
            return this.code(400).send(manager.badRequest(options));
        }
    );

    server.decorateReply(
        "unauthorized",
        function (this: FastifyReply, options?: FailureOptions) {
            return this.code(401).send(manager.unauthorized(options));
        }
    );

    server.decorateReply(
        "forbidden",
        function (this: FastifyReply, options?: FailureOptions) {
            return this.code(403).send(manager.forbidden(options));
        }
    );

    server.decorateReply(
        "notFound",
        function (this: FastifyReply, options?: FailureOptions) {
            return this.code(404).send(manager.notFound(options));
        }
    );

    server.decorateReply(
        "conflict",
        function (this: FastifyReply, options?: FailureOptions) {
            return this.code(409).send(manager.conflict(options));
        }
    );

    server.decorateReply(
        "unprocessable",
        function (this: FastifyReply, options?: FailureOptions) {
            return this.code(422).send(manager.unprocessable(options));
        }
    );

    server.decorateReply(
        "serverError",
        function (this: FastifyReply, options?: FailureOptions) {
            return this.code(500).send(manager.serverError(options));
        }
    );

    server.decorateReply(
        "validationFailed",
        function (this: FastifyReply, options: ValidationFailedOptions) {
            return this.code(400).send(manager.validationFailed(options));
        }
    );
}

export default fp(responseManagementPlugin, {
    name: "response-management",
    fastify: "5.x",
});

export { responseManagementPlugin };

export {
    DEFAULT_METADATA_LIMITS,
    DEFAULT_SENSITIVE_METADATA_KEYS,
    REDACTED_METADATA_VALUE,
    TRUNCATED_METADATA_VALUE,
    sanitizeMetadata,
} from "./response-metadata.js";

export type { MetadataLimits, MetadataSanitizeOptions, SensitiveMetadataKey } from "./response-metadata.js";

// Backward-compatible alias for the old misspelled name
export type { ResponseManagementPluginOptions as ResponseManagmentPluginOptions };
