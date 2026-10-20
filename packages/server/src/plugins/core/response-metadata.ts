// ---------------------------------------------------------------------------
// Metadata sanitisation
// ---------------------------------------------------------------------------

/**
 * `metadata` is the free-form bag that rides alongside `data` in every response
 * envelope. Because it accepts anything, it is also the easiest place for a
 * secret or an unbounded user payload to leak to a client: a handler that
 * echoes the submitted body, or the raw issues of a validation library, ends
 * up sending credentials and validator internals over the wire.
 *
 * This module redacts sensitive keys and bounds the size of the value before
 * it leaves the process. The payload itself (`data`) is deliberately never
 * touched: it is the application's deliberate output, and redacting it would
 * corrupt legitimate business data such as a freshly minted access token.
 * ---------------------------------------------------------------------------

/** Bounds applied to a response metadata payload. */
export interface MetadataLimits {
    /** Longest string kept verbatim; the rest is cut and marked. Default 2048. */
    maxStringLength?: number;
    /** Most array entries kept; the tail is dropped and counted. Default 100. */
    maxArrayLength?: number;
    /** Most keys kept per object; the rest are dropped and counted. Default 100. */
    maxKeys?: number;
    /** Deepest nesting walked. Default 8. */
    maxDepth?: number;
}

export const DEFAULT_METADATA_LIMITS: Required<MetadataLimits> = {
    maxStringLength: 2048,
    maxArrayLength: 100,
    maxKeys: 100,
    maxDepth: 8,
};

/**
 * Keys whose values are masked in metadata. Matching is case-insensitive and
 * applies to nested objects inside the metadata. Mirrors the key set the error
 * package masks in error details, so a value is masked the same way whether it
 * travels on the error path or the response path.
 */
export const DEFAULT_SENSITIVE_METADATA_KEYS = [
    "password",
    "passwd",
    "secret",
    "token",
    "accesstoken",
    "refreshtoken",
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "privatekey",
    "sessionid",
    "ssn",
    "cvv",
    "pin",
] as const;

export type SensitiveMetadataKey = (typeof DEFAULT_SENSITIVE_METADATA_KEYS)[number] | (string & {});

/** Value written in place of a redacted key. */
export const REDACTED_METADATA_VALUE = "[REDACTED]";

/** Marker appended to a string that was cut short. */
export const TRUNCATED_METADATA_VALUE = "[TRUNCATED]";

export interface MetadataSanitizeOptions {
    /**
     * Redact sensitive keys. `true` (default) uses
     * {@link DEFAULT_SENSITIVE_METADATA_KEYS}, an array overrides that list,
     * `false` disables redaction.
     */
    redact?: boolean | readonly SensitiveMetadataKey[];
    /** Bounds on the metadata size. */
    limits?: MetadataLimits;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Values that know how to serialise themselves keep their own representation;
 * walking them would turn a `Date` into `{}` and a `Buffer` into its bytes.
 */
const hasToJson = (value: object): boolean =>
    typeof (value as { toJSON?: unknown }).toJSON === "function";

/** Resolves the effective limits, ignoring non-positive or non-finite values. */
export function resolveMetadataLimits(limits?: MetadataLimits): Required<MetadataLimits> {
    if (limits === undefined) return DEFAULT_METADATA_LIMITS;

    const positive = (value: number | undefined, fallback: number): number =>
        typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

    return {
        maxStringLength: positive(limits.maxStringLength, DEFAULT_METADATA_LIMITS.maxStringLength),
        maxArrayLength: positive(limits.maxArrayLength, DEFAULT_METADATA_LIMITS.maxArrayLength),
        maxKeys: positive(limits.maxKeys, DEFAULT_METADATA_LIMITS.maxKeys),
        maxDepth: positive(limits.maxDepth, DEFAULT_METADATA_LIMITS.maxDepth),
    };
}

function resolveSensitiveKeys(
    redact: MetadataSanitizeOptions["redact"],
): ReadonlySet<string> {
    if (redact === false) return new Set<string>();
    if (redact === undefined || redact === true) {
        return new Set<string>(DEFAULT_SENSITIVE_METADATA_KEYS.map((key) => key.toLowerCase()));
    }
    return new Set<string>(redact.map((key) => key.toLowerCase()));
}

/**
 * Redacts sensitive keys in a metadata record and bounds its size.
 *
 * Nothing here throws. A cycle becomes `"[Circular]"`, a cycle-free but
 * too-deep value becomes `"[Object]"`, and anything past a limit is cut or
 * replaced with a marker, because this runs on the response path where the
 * program may already be failing.
 *
 * @returns a new record; the input is never mutated.
 */
export function sanitizeMetadata(
    metadata: Record<string, unknown> | undefined,
    options: MetadataSanitizeOptions = {},
): Record<string, unknown> | undefined {
    if (metadata === undefined) return undefined;

    const sensitive = resolveSensitiveKeys(options.redact);
    const limits = resolveMetadataLimits(options.limits);
    const seen = new WeakSet<object>();

    const walk = (value: unknown, depth: number): unknown => {
        if (typeof value === "string") {
            return value.length <= limits.maxStringLength
                ? value
                : `${value.slice(0, limits.maxStringLength)}${TRUNCATED_METADATA_VALUE}`;
        }

        if (value === null || typeof value !== "object") return value;

        if (Array.isArray(value)) {
            if (depth >= limits.maxDepth) return "[Object]";
            if (seen.has(value)) return "[Circular]";
            seen.add(value);
            const kept = value
                .slice(0, limits.maxArrayLength)
                .map((item) => walk(item, depth + 1));
            if (value.length > limits.maxArrayLength) {
                kept.push(`[${value.length - limits.maxArrayLength} more]`);
            }
            seen.delete(value);
            return kept;
        }

        if (!isRecord(value) || hasToJson(value)) return value;
        if (seen.has(value)) return "[Circular]";
        if (depth >= limits.maxDepth) return "[Object]";
        seen.add(value);

        const entries = Object.entries(value);
        const out: Record<string, unknown> = {};
        for (const [key, item] of entries.slice(0, limits.maxKeys)) {
            out[key] = sensitive.has(key.toLowerCase())
                ? REDACTED_METADATA_VALUE
                : walk(item, depth + 1);
        }
        if (entries.length > limits.maxKeys) {
            out["[truncatedKeys]"] = entries.length - limits.maxKeys;
        }
        seen.delete(value);
        return out;
    };

    return walk(metadata, 0) as Record<string, unknown>;
}
