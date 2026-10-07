import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply } from "fastify";

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/** Standard envelope returned by every API endpoint. */
export interface ApiResponse<T = unknown> {
    /** Whether the request succeeded. */
    success: boolean;
    /** Application-level status code (e.g. "200", "NOT_FOUND"). */
    code: string;
    /** Human-readable message. */
    message: string;
    /** Response payload – absent on failure responses. */
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

// ---------------------------------------------------------------------------
// ResponseManager
// ---------------------------------------------------------------------------

/**
 * Utility class for building standardised {@link ApiResponse} objects.
 * Instantiate once and reuse across the process.
 */
export class ResponseManager {
    constructor(
        private readonly defaultMessage: string = "Success",
        private readonly defaultCode: string = "200"
    ) {}

    // ------------------------------------------------------------------
    // Success helpers
    // ------------------------------------------------------------------

    /** Generic 2xx success response. */
    success<T = unknown>(
        data: T,
        message?: string,
        code?: string,
        metadata?: Record<string, unknown>
    ): ApiResponse<T> {
        return {
            success: true,
            code: code ?? this.defaultCode,
            message: message ?? this.defaultMessage,
            data,
            metadata,
        };
    }

    /** Resource created (HTTP 201). */
    created<T = unknown>(
        data: T,
        message = "Resource created successfully",
        code = "201",
        metadata?: Record<string, unknown>
    ): ApiResponse<T> {
        return { success: true, code, message, data, metadata };
    }

    /** Resource updated (HTTP 200). */
    updated<T = unknown>(
        data: T,
        message = "Resource updated successfully",
        code = "200",
        metadata?: Record<string, unknown>
    ): ApiResponse<T> {
        return { success: true, code, message, data, metadata };
    }

    /** Resource deleted (HTTP 200). */
    deleted<T = unknown>(
        data: T,
        message = "Resource deleted successfully",
        code = "200",
        metadata?: Record<string, unknown>
    ): ApiResponse<T> {
        return { success: true, code, message, data, metadata };
    }

    /**
     * Paginated list response.
     * Pagination metadata is merged into `metadata` automatically.
     */
    paginated<T = unknown>(
        data: T[],
        pagination: PaginationMeta,
        message = "Data retrieved successfully",
        code = "200",
        metadata?: Record<string, unknown>
    ): ApiResponse<T[]> {
        return {
            success: true,
            code,
            message,
            data,
            metadata: { ...metadata, pagination },
        };
    }

    // ------------------------------------------------------------------
    // Error helpers
    // ------------------------------------------------------------------

    /** Generic failure (HTTP 400 by default). */
    failed(
        message = "Request failed",
        code = "400",
        metadata?: Record<string, unknown>
    ): ApiResponse {
        return { success: false, code, message, metadata };
    }

    /** 400 Bad Request. */
    badRequest(message = "Bad request", metadata?: Record<string, unknown>): ApiResponse {
        return this.failed(message, "400", metadata);
    }

    /** 401 Unauthorized. */
    unauthorized(message = "Unauthorized", metadata?: Record<string, unknown>): ApiResponse {
        return this.failed(message, "401", metadata);
    }

    /** 403 Forbidden. */
    forbidden(message = "Forbidden", metadata?: Record<string, unknown>): ApiResponse {
        return this.failed(message, "403", metadata);
    }

    /** 404 Not Found. */
    notFound(message = "Resource not found", metadata?: Record<string, unknown>): ApiResponse {
        return this.failed(message, "404", metadata);
    }

    /** 409 Conflict. */
    conflict(message = "Conflict", metadata?: Record<string, unknown>): ApiResponse {
        return this.failed(message, "409", metadata);
    }

    /** 422 Unprocessable Entity. */
    unprocessable(message = "Unprocessable entity", metadata?: Record<string, unknown>): ApiResponse {
        return this.failed(message, "422", metadata);
    }

    /** 500 Internal Server Error. */
    serverError(message = "Internal server error", metadata?: Record<string, unknown>): ApiResponse {
        return this.failed(message, "500", metadata);
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
        success<T>(data: T, message?: string, code?: string, metadata?: Record<string, unknown>): FastifyReply;
        /** 201 – resource created. */
        created<T>(data: T, message?: string, code?: string, metadata?: Record<string, unknown>): FastifyReply;
        /** 200 – resource updated. */
        updated<T>(data: T, message?: string, code?: string, metadata?: Record<string, unknown>): FastifyReply;
        /** 200 – resource deleted. */
        deleted<T>(data: T, message?: string, code?: string, metadata?: Record<string, unknown>): FastifyReply;
        /** 200 – paginated list. */
        paginated<T>(data: T[], pagination: PaginationMeta, message?: string, code?: string, metadata?: Record<string, unknown>): FastifyReply;
        /** 4xx/5xx – generic failure. */
        failed(message?: string, code?: string, metadata?: Record<string, unknown>): FastifyReply;
        /** 400 – bad request. */
        badRequest(message?: string, metadata?: Record<string, unknown>): FastifyReply;
        /** 401 – unauthorized. */
        unauthorized(message?: string, metadata?: Record<string, unknown>): FastifyReply;
        /** 403 – forbidden. */
        forbidden(message?: string, metadata?: Record<string, unknown>): FastifyReply;
        /** 404 – not found. */
        notFound(message?: string, metadata?: Record<string, unknown>): FastifyReply;
        /** 409 – conflict. */
        conflict(message?: string, metadata?: Record<string, unknown>): FastifyReply;
        /** 422 – unprocessable entity. */
        unprocessable(message?: string, metadata?: Record<string, unknown>): FastifyReply;
        /** 500 – internal server error. */
        serverError(message?: string, metadata?: Record<string, unknown>): FastifyReply;
    }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ResponseManagementPluginOptions {}

/**
 * Fastify plugin that decorates every {@link FastifyReply} with typed
 * response helpers backed by {@link ResponseManager}.
 */
async function responseManagementPlugin(
    server: FastifyInstance,
    _options: ResponseManagementPluginOptions = {}
): Promise<void> {
    const manager = new ResponseManager();

    server.decorateReply(
        "response",
        function <T>(this: FastifyReply, response: ApiResponse<T>, statusCode = 200) {
            return this.code(statusCode).send(response);
        }
    );

    server.decorateReply(
        "success",
        function <T>(this: FastifyReply, data: T, message?: string, code?: string, metadata?: Record<string, unknown>) {
            return this.code(200).send(manager.success(data, message, code, metadata));
        }
    );

    server.decorateReply(
        "created",
        function <T>(this: FastifyReply, data: T, message?: string, code?: string, metadata?: Record<string, unknown>) {
            return this.code(201).send(manager.created(data, message, code, metadata));
        }
    );

    server.decorateReply(
        "updated",
        function <T>(this: FastifyReply, data: T, message?: string, code?: string, metadata?: Record<string, unknown>) {
            return this.code(200).send(manager.updated(data, message, code, metadata));
        }
    );

    server.decorateReply(
        "deleted",
        function <T>(this: FastifyReply, data: T, message?: string, code?: string, metadata?: Record<string, unknown>) {
            return this.code(200).send(manager.deleted(data, message, code, metadata));
        }
    );

    server.decorateReply(
        "paginated",
        function <T>(
            this: FastifyReply,
            data: T[],
            pagination: PaginationMeta,
            message?: string,
            code?: string,
            metadata?: Record<string, unknown>
        ) {
            return this.code(200).send(manager.paginated(data, pagination, message, code, metadata));
        }
    );

    server.decorateReply(
        "failed",
        function (this: FastifyReply, message?: string, code?: string, metadata?: Record<string, unknown>) {
            const httpStatus = code ? (Number(code) || 400) : 400;
            return this.code(httpStatus).send(manager.failed(message, code, metadata));
        }
    );

    server.decorateReply(
        "badRequest",
        function (this: FastifyReply, message?: string, metadata?: Record<string, unknown>) {
            return this.code(400).send(manager.badRequest(message, metadata));
        }
    );

    server.decorateReply(
        "unauthorized",
        function (this: FastifyReply, message?: string, metadata?: Record<string, unknown>) {
            return this.code(401).send(manager.unauthorized(message, metadata));
        }
    );

    server.decorateReply(
        "forbidden",
        function (this: FastifyReply, message?: string, metadata?: Record<string, unknown>) {
            return this.code(403).send(manager.forbidden(message, metadata));
        }
    );

    server.decorateReply(
        "notFound",
        function (this: FastifyReply, message?: string, metadata?: Record<string, unknown>) {
            return this.code(404).send(manager.notFound(message, metadata));
        }
    );

    server.decorateReply(
        "conflict",
        function (this: FastifyReply, message?: string, metadata?: Record<string, unknown>) {
            return this.code(409).send(manager.conflict(message, metadata));
        }
    );

    server.decorateReply(
        "unprocessable",
        function (this: FastifyReply, message?: string, metadata?: Record<string, unknown>) {
            return this.code(422).send(manager.unprocessable(message, metadata));
        }
    );

    server.decorateReply(
        "serverError",
        function (this: FastifyReply, message?: string, metadata?: Record<string, unknown>) {
            return this.code(500).send(manager.serverError(message, metadata));
        }
    );
}

export default fp(responseManagementPlugin, {
    name: "response-management",
    fastify: "5.x",
});

export { responseManagementPlugin };

// Backward-compatible alias for the old misspelled name
export type { ResponseManagementPluginOptions as ResponseManagmentPluginOptions };