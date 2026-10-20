// ---------------------------------------------------------------------------
// Error descriptions
// ---------------------------------------------------------------------------

/**
 * The error codes the response layer reports.
 *
 * A failure carries one of these, so a client can branch on it without
 * reading the message. A success carries the HTTP status instead.
 */
export const PLATFORM_ERROR_CODES = [
    "BAD_REQUEST",
    "VALIDATION_ERROR",
    "AUTHENTICATION_ERROR",
    "AUTHORIZATION_ERROR",
    "NOT_FOUND",
    "CONFLICT",
    "PAYLOAD_TOO_LARGE",
    "UNSUPPORTED_MEDIA_TYPE",
    "UNPROCESSABLE_ENTITY",
    "RATE_LIMIT_EXCEEDED",
    "INTERNAL_ERROR",
    "SERVICE_UNAVAILABLE",
    "TIMEOUT",
    "UNKNOWN_ERROR",
] as const;

export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[number];

const PLATFORM_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(PLATFORM_ERROR_CODES);

/** Whether a code is one the platform reports. */
export function isPlatformErrorCode(code: unknown): code is PlatformErrorCode {
    return typeof code === "string" && PLATFORM_ERROR_CODE_SET.has(code);
}

/** A request-facing failure, described in the response layer's terms. */
export interface ErrorDescription {
    /** HTTP status to answer with. */
    statusCode: number;
    /** Platform error code. */
    code: string;
    /** Message for the caller. */
    message: string;
    /** Structured details, such as a field map. */
    details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Validation issues
// ---------------------------------------------------------------------------

/** A schema validation issue, as reported by the request validator. */
export interface ValidationIssue {
    /** JSON pointer to the offending value. */
    instancePath?: string;
    /** The rule that failed, e.g. "required" or "format". */
    keyword?: string;
    /** Rule-specific values, e.g. the missing property or the expected format. */
    params?: Record<string, unknown>;
    /** The validator's own wording. */
    message?: string;
}

const unescapePointer = (segment: string): string =>
    segment.replace(/~1/g, "/").replace(/~0/g, "~");

/**
 * The field path an issue belongs to, in the same dotted form the
 * `toValidationFields` helper produces for a validation library's issues, so
 * a client binds either kind of failure to the same input.
 */
export function validationFieldPath(issue: ValidationIssue): string {
    const segments = (issue.instancePath ?? "")
        .split("/")
        .filter(Boolean)
        .map(unescapePointer);

    const missing = issue.params?.missingProperty;
    if (issue.keyword === "required" && typeof missing === "string") {
        segments.push(missing);
    }

    return segments.join(".");
}

/**
 * The message for a validation issue, in words a person can act on.
 *
 * A validator states a rule ("must match format \"email\""); a person needs
 * to know what to change ("Must be a valid email.").
 */
export function validationMessage(issue: ValidationIssue): string {
    const params = issue.params ?? {};

    switch (issue.keyword) {
        case "required":
            return "This field is required.";
        case "format":
            return typeof params.format === "string"
                ? `Must be a valid ${params.format}.`
                : "Must match the expected format.";
        case "type":
            return typeof params.type === "string"
                ? `Must be a ${params.type}.`
                : "Must be of the expected type.";
        case "minimum":
            return `Must be greater than or equal to ${String(params.limit)}.`;
        case "maximum":
            return `Must be less than or equal to ${String(params.limit)}.`;
        case "exclusiveMinimum":
            return `Must be greater than ${String(params.limit)}.`;
        case "exclusiveMaximum":
            return `Must be less than ${String(params.limit)}.`;
        case "minLength":
            return `Must be at least ${String(params.limit)} characters.`;
        case "maxLength":
            return `Must be at most ${String(params.limit)} characters.`;
        case "minItems":
            return `Must have at least ${String(params.limit)} items.`;
        case "maxItems":
            return `Must have at most ${String(params.limit)} items.`;
        case "enum":
            return Array.isArray(params.allowedValues)
                ? `Must be one of: ${params.allowedValues.map(String).join(", ")}.`
                : "Must be one of the allowed values.";
        case "const":
            return "Must be the expected value.";
        case "pattern":
            return "Must match the expected format.";
        case "uniqueItems":
            return "Must not contain duplicates.";
        case "additionalProperties":
            return "Contains a property that is not allowed.";
        default:
            return issue.message ?? "This value is not valid.";
    }
}

/**
 * Groups validation issues by field, one entry per field path holding every
 * message for that field.
 */
export function validationFields(
    issues: readonly ValidationIssue[],
): Record<string, string[]> {
    const fields: Record<string, string[]> = {};

    for (const issue of issues) {
        const path = validationFieldPath(issue) || "_";
        const messages = fields[path] ?? (fields[path] = []);
        messages.push(validationMessage(issue));
    }

    return fields;
}

// ---------------------------------------------------------------------------
// Framework errors
// ---------------------------------------------------------------------------

/**
 * The framework errors a caller can cause, described in terms of what to
 * change rather than in terms of how the parser works.
 */
const FRAMEWORK_ERRORS: Readonly<Record<string, Omit<ErrorDescription, "details">>> = {
    FST_ERR_CTP_INVALID_JSON_BODY: {
        statusCode: 400,
        code: "BAD_REQUEST",
        message:
            "The request body could not be read as JSON. Send a valid JSON body and set the Content-Type header to application/json.",
    },
    FST_ERR_CTP_EMPTY_JSON_BODY: {
        statusCode: 400,
        code: "BAD_REQUEST",
        message:
            "The request body is empty. Send a JSON body and set the Content-Type header to application/json.",
    },
    FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
        statusCode: 400,
        code: "BAD_REQUEST",
        message: "The Content-Length header does not match the size of the request body.",
    },
    FST_ERR_CTP_INVALID_MEDIA_TYPE: {
        statusCode: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The Content-Type header is not supported. Send the request body as application/json.",
    },
    FST_ERR_CTP_BODY_TOO_LARGE: {
        statusCode: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: "The request body is too large.",
    },
    FST_ERR_BAD_URL: {
        statusCode: 400,
        code: "BAD_REQUEST",
        message: "The request URL could not be read.",
    },
    FST_ERR_SCH_SERIALIZATION_FAILED: {
        statusCode: 500,
        code: "INTERNAL_ERROR",
        message: "The response could not be produced.",
    },
    FST_ERR_REP_ALREADY_SENT: {
        statusCode: 500,
        code: "INTERNAL_ERROR",
        message: "The response was already sent.",
    },
    FST_ERR_HOOK_TIMEOUT: {
        statusCode: 500,
        code: "TIMEOUT",
        message: "The request took too long to handle.",
    },
};

/** The message used for a fault, which may name internals. */
const INTERNAL_MESSAGE = "Something went wrong while handling the request.";

/**
 * Describes a thrown value as a request-facing failure.
 *
 * A failure that carries a platform code was raised deliberately and its
 * message is meant for the caller. A failure without one is a fault, so its
 * message is replaced: the detail belongs in the log, not in the response.
 */
export function describeError(
    error: unknown,
    options: { exposeInternalMessages?: boolean } = {},
): ErrorDescription {
    const thrown = (error ?? {}) as {
        message?: unknown;
        code?: unknown;
        statusCode?: unknown;
        validation?: unknown;
        stack?: unknown;
    };

    const validation = Array.isArray(thrown.validation)
        ? (thrown.validation as ValidationIssue[])
        : undefined;

    if (validation) {
        return {
            statusCode: 400,
            code: "VALIDATION_ERROR",
            message: "The request contains values that are not valid.",
            details: { fields: validationFields(validation) },
        };
    }

    const code = typeof thrown.code === "string" ? thrown.code : undefined;
    const framework = code ? FRAMEWORK_ERRORS[code] : undefined;
    if (framework) return { ...framework };

    const rawStatus = typeof thrown.statusCode === "number" ? thrown.statusCode : undefined;
    const status = rawStatus !== undefined && rawStatus >= 400 ? rawStatus : 500;
    const message = typeof thrown.message === "string" ? thrown.message : undefined;

    if (code === "FST_ERR_VALIDATION") {
        return {
            statusCode: 400,
            code: "VALIDATION_ERROR",
            message: "The request contains values that are not valid.",
        };
    }

    if (code && isPlatformErrorCode(code)) {
        return { statusCode: status, code, message: message ?? "Request failed." };
    }

    switch (status) {
        case 401:
            return { statusCode: 401, code: "AUTHENTICATION_ERROR", message: message ?? "Authentication is required." };
        case 403:
            return { statusCode: 403, code: "AUTHORIZATION_ERROR", message: message ?? "You do not have access to this resource." };
        case 404:
            return { statusCode: 404, code: "NOT_FOUND", message: message ?? "The requested resource does not exist." };
        case 409:
            return { statusCode: 409, code: "CONFLICT", message: message ?? "The request conflicts with the current state." };
        case 413:
            return { statusCode: 413, code: "PAYLOAD_TOO_LARGE", message: message ?? "The request body is too large." };
        case 415:
            return { statusCode: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: message ?? "The Content-Type header is not supported." };
        case 422:
            return { statusCode: 422, code: "UNPROCESSABLE_ENTITY", message: message ?? "The request could not be processed." };
        case 429:
            return { statusCode: 429, code: "RATE_LIMIT_EXCEEDED", message: message ?? "Too many requests. Try again later." };
        case 503:
            return { statusCode: 503, code: "SERVICE_UNAVAILABLE", message: message ?? "The service is temporarily unavailable." };
        case 504:
            return { statusCode: 504, code: "TIMEOUT", message: message ?? "The request timed out." };
        default:
            break;
    }

    if (status < 500) {
        return { statusCode: status, code: "BAD_REQUEST", message: message ?? "The request could not be processed." };
    }

    return {
        statusCode: status,
        code: "INTERNAL_ERROR",
        message: options.exposeInternalMessages && message ? message : INTERNAL_MESSAGE,
    };
}
