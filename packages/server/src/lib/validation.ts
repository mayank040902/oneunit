// ---------------------------------------------------------------------------
// Validation issues
// ---------------------------------------------------------------------------

/**
 * The shape a validation library exposes for a single failed constraint.
 * Zod's `$ZodIssue`, Joi's `ValidationErrorItem` and Yup's `ValidationError`
 * all satisfy it, so the same mapper works for any of them.
 */
export interface ValidationIssueLike {
    /** Path to the offending value, outermost segment first. */
    path?: ReadonlyArray<string | number>;
    /** Human-readable message for the offending value. */
    message?: string;
}

/** A validation error that carries its issues, such as a `ZodError`. */
export interface ValidationErrorLike {
    issues?: readonly ValidationIssueLike[];
}

export interface ToValidationFieldsOptions {
    /** Most fields kept; the rest are dropped. Default 50. */
    maxFields?: number;
    /** Key used for an issue that has no path. Default "_". */
    fallbackKey?: string;
    /** Message used for an issue that has none. Default "Invalid value". */
    fallbackMessage?: string;
}

/**
 * How many fields a validation map holds before the rest are dropped.
 *
 * A form with more failing fields than this produces more noise than
 * guidance, and the bound keeps the payload size predictable for the client.
 */
export const DEFAULT_MAX_VALIDATION_FIELDS = 50;

const resolveIssues = (
    source: readonly ValidationIssueLike[] | ValidationErrorLike | undefined,
): readonly ValidationIssueLike[] | undefined => {
    if (source === undefined) return undefined;
    if (Array.isArray(source)) return source as readonly ValidationIssueLike[];
    return (source as ValidationErrorLike).issues;
};

/**
 * Maps validation issues to a field-keyed error map: one entry per field
 * path, holding every message for that field.
 *
 * Only the issue's `message` is carried over. The rest of a raw issue is
 * developer-facing — the validator's issue code, the expected type, the
 * constraint pattern — and belongs in a server log, not in a client payload.
 *
 * @example
 * ```ts
 * const result = schema.safeParse(request.body);
 * if (!result.success) {
 *     return reply.validationFailed({
 *         fields: toValidationFields(result.error),
 *         message: "Please check the highlighted fields",
 *     });
 * }
 * ```
 */
export function toValidationFields(
    source: readonly ValidationIssueLike[] | ValidationErrorLike | undefined,
    options: ToValidationFieldsOptions = {},
): Record<string, string[]> {
    const issues = resolveIssues(source);
    if (!issues || issues.length === 0) return {};

    const maxFields =
        typeof options.maxFields === "number" && options.maxFields > 0
            ? Math.floor(options.maxFields)
            : DEFAULT_MAX_VALIDATION_FIELDS;
    const fallbackKey = options.fallbackKey ?? "_";
    const fallbackMessage = options.fallbackMessage ?? "Invalid value";

    const fields: Record<string, string[]> = {};
    let fieldCount = 0;

    for (const issue of issues) {
        const path = issue.path ?? [];
        const key = path.length > 0 ? path.map(String).join(".") : fallbackKey;

        let messages = fields[key];
        if (!messages) {
            if (fieldCount >= maxFields) continue;
            messages = [];
            fields[key] = messages;
            fieldCount += 1;
        }
        messages.push(issue.message ?? fallbackMessage);
    }

    return fields;
}
