/**
 * Keys whose values are masked when {@link formatError} is asked to redact.
 * Matching is case-insensitive and applies to nested objects inside `details`.
 */
export const DEFAULT_SENSITIVE_KEYS = [
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

export type SensitiveKey = (typeof DEFAULT_SENSITIVE_KEYS)[number] | (string & {});

export interface DetailLimits {
  /** Longest string kept verbatim; the rest is cut and marked. Default 2048. */
  maxStringLength?: number;
  /** Longest array kept; the tail is dropped and counted. Default 100. */
  maxArrayLength?: number;
  /** Most keys kept per object; the rest are dropped and counted. Default 100. */
  maxKeys?: number;
  /** Deepest nesting walked. Default 8. */
  maxDepth?: number;
}

export const DEFAULT_DETAIL_LIMITS: Required<DetailLimits> = {
  maxStringLength: 2048,
  maxArrayLength: 100,
  maxKeys: 100,
  maxDepth: 8,
};

export const TRUNCATED = "[TRUNCATED]";

export interface FormatErrorOptions {
  /**
   * Include `stack` in the payload. Defaults to `true`, matching `toJSON()`;
   * HTTP handlers normally pass `false` so internals do not reach clients.
   */
  includeStack?: boolean;
  /**
   * Include the `cause` chain in the payload. Defaults to `false`, because a
   * cause chain routinely carries credentials and file paths.
   */
  includeCause?: boolean;
  /**
   * Include the sub-errors of an `AggregateError`. Defaults to `false`;
   * without it, a fan-out failure loses every reason but the summary.
   */
  includeAggregated?: boolean;
  /**
   * Keys to mask in `details`, plus the value written in their place.
   * Defaults to no redaction; pass `true` to use {@link DEFAULT_SENSITIVE_KEYS},
   * or an explicit key list.
   */
  redact?: boolean | readonly SensitiveKey[];
  /**
   * Bounds on the size of `details`. Omit to apply
   * {@link DEFAULT_DETAIL_LIMITS}; `details` is built from request input
   * somewhere, so an unbounded payload reaches clients and logs as-is.
   */
  limits?: DetailLimits;
}

export const REDACTED = "[REDACTED]";

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeKeys = (keys: true | readonly SensitiveKey[]): ReadonlySet<string> => {
  if (keys === true) return new Set<string>(DEFAULT_SENSITIVE_KEYS.map(key => key.toLowerCase()));
  return new Set<string>(keys.map(key => key.toLowerCase()));
};

const resolveLimits = (limits?: DetailLimits): Required<DetailLimits> => {
  if (limits === undefined) return DEFAULT_DETAIL_LIMITS;
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    maxStringLength: positive(limits.maxStringLength, DEFAULT_DETAIL_LIMITS.maxStringLength),
    maxArrayLength: positive(limits.maxArrayLength, DEFAULT_DETAIL_LIMITS.maxArrayLength),
    maxKeys: positive(limits.maxKeys, DEFAULT_DETAIL_LIMITS.maxKeys),
    maxDepth: positive(limits.maxDepth, DEFAULT_DETAIL_LIMITS.maxDepth),
  };
};

/**
 * Redacts and truncates a `details` record in a single pass.
 *
 * Both concerns share one walk because they are the same walk: a sanitizer that
 * copied the object twice would double the allocation on the error path and
 * could leave one transform's output inconsistent with the other's.
 *
 * Nothing here throws. A cycle becomes `"[Circular]"`, a cycle-free but too-deep
 * value becomes `"[Object]"`, and anything past a limit is replaced or cut with
 * a marker, because this runs where the program is already failing.
 *
 * @returns a new record; the input is never mutated.
 */
export function sanitizeDetails(
  details: Record<string, unknown> | undefined,
  options: {
    redact?: boolean | readonly SensitiveKey[];
    limits?: DetailLimits;
  } = {}
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;

  const sensitive = options.redact === undefined || options.redact === false
    ? new Set<string>()
    : normalizeKeys(options.redact);
  const limits = resolveLimits(options.limits);
  const seen = new WeakSet<object>();

  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      return value.length <= limits.maxStringLength
        ? value
        : `${value.slice(0, limits.maxStringLength)}${TRUNCATED}`;
    }

    if (Array.isArray(value)) {
      if (depth >= limits.maxDepth) return "[Object]";
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      const kept = value.slice(0, limits.maxArrayLength).map(item => walk(item, depth + 1));
      if (value.length > limits.maxArrayLength) {
        kept.push(`[${value.length - limits.maxArrayLength} more]`);
      }
      seen.delete(value);
      return kept;
    }

    if (!isPlainRecord(value)) return value;
    if (seen.has(value)) return "[Circular]";
    if (depth >= limits.maxDepth) return "[Object]";
    seen.add(value);

    const entries = Object.entries(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, limits.maxKeys)) {
      out[key] = sensitive.has(key.toLowerCase()) ? REDACTED : walk(item, depth + 1);
    }
    if (entries.length > limits.maxKeys) {
      out["[truncatedKeys]"] = entries.length - limits.maxKeys;
    }
    seen.delete(value);
    return out;
  };

  return walk(details, 0) as Record<string, unknown>;
}

/**
 * Masks sensitive keys in a plain record, recursing into nested objects and
 * arrays. A cycle (or a very deep structure) degrades to a marker rather than
 * throwing, because error formatting must never be the thing that fails.
 */
export function redactDetails(
  details: Record<string, unknown> | undefined,
  keys: true | readonly SensitiveKey[] = true,
  maxDepth = DEFAULT_DETAIL_LIMITS.maxDepth
): Record<string, unknown> | undefined {
  return sanitizeDetails(details, { redact: keys, limits: { maxDepth } });
}

/**
 * Reports whether an error is an {@link AggregateAppError} or a platform
 * `AggregateError`, so callers do not have to know which one they were handed.
 * `Promise.all` and `Promise.any` both produce the latter.
 */
export const isAggregateError = (error: unknown): boolean =>
  error instanceof AggregateAppError ||
  (typeof AggregateError === "function" && error instanceof AggregateError);

/**
 * The sub-errors of an aggregate, or `undefined` for anything else.
 */
export const getAggregateErrors = (error: unknown): unknown[] | undefined => {
  if (error instanceof AggregateAppError) return error.errors;
  if (typeof AggregateError === "function" && error instanceof AggregateError) {
    return (error as { errors?: unknown[] }).errors;
  }
  return undefined;
};

/**
 * Walks the `cause` chain and returns the deepest cause.
 *
 * Follows into an aggregate's sub-errors, so the root cause of a failed fan-out
 * is the root cause of whichever member failed deepest.
 *
 * @returns the root cause, or the error itself when it has none. Returns
 * `undefined` for non-error input.
 */
export function getRootCause(error: unknown, maxDepth = 32): Error | undefined {
  let current: Error | undefined = error instanceof Error ? error : undefined;
  if (current === undefined) return undefined;

  const seen = new Set<Error>([current]);

  for (let depth = 0; depth < maxDepth; depth++) {
    const candidates: unknown[] = [];
    const cause: unknown = current.cause;
    if (cause !== undefined && cause !== null) candidates.push(cause);
    // A cause is the more specific explanation, so it is followed first.
    candidates.push(...(getAggregateErrors(current) ?? []));

    const next = candidates.find(
      (candidate): candidate is Error => candidate instanceof Error && !seen.has(candidate)
    );
    if (next === undefined) break;
    seen.add(next);
    current = next;
  }

  return current;
}

/**
 * Returns the full error graph, nearest first: the error, its `cause` chain, and
 * the sub-errors of any aggregate, depth-first. Cycles and graphs larger than
 * `maxDepth` are cut off rather than followed forever.
 */
export function getErrorChain(error: unknown, maxDepth = 32): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth: number): void => {
    if (!(value instanceof Error) || seen.has(value) || depth >= maxDepth) return;
    seen.add(value);
    chain.push(value);

    const cause: unknown = value.cause;
    if (cause !== undefined && cause !== null) visit(cause, depth + 1);

    for (const child of getAggregateErrors(value) ?? []) visit(child, depth + 1);
  };

  visit(error, 0);
  return chain;
}

/**
 * Whether an error is worth retrying: transient client-side conditions, plus
 * anything from this package that maps to a retryable transport or server
 * fault. 4xx errors other than 408/425/429 are the caller's fault, and a
 * retry cannot fix them.
 */
export function isRetryable(error: unknown): boolean {
  const children = getAggregateErrors(error);
  // A fan-out is worth retrying if any member is: the caller will re-run the
  // whole batch, and the members that failed for a good reason still fail
  // cheaply. Requiring *every* member to be retryable would make a single
  // validation failure suppress retry of nine timeouts.
  if (children !== undefined && children.length > 0) {
    return children.some(isRetryable);
  }

  const statusCode = getErrorStatusCode(error);
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

/**
 * How long the caller was asked to wait before retrying, in milliseconds.
 *
 * Reads, in order: `details.retryAfter` on an `AppError` (seconds, as
 * `RateLimitError` accepts), a `retryAfter`/`retryAfterMs` field on a foreign
 * error, and a `Retry-After` header or `retry-after` property in seconds or as
 * an HTTP date.
 *
 * @returns the delay in milliseconds, or `undefined` when the error carries no
 * usable instruction. A non-positive or unparseable value is treated as absent
 * rather than as "retry immediately".
 */
export function getRetryAfter(error: unknown): number | undefined {
  if (isPlainRecord(error) || error instanceof AppError) {
    const details = (error as AppError).details;
    if (isPlainRecord(details)) {
      const seconds = details.retryAfter;
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
      }
    }
  }

  const candidate = error as { retryAfterMs?: unknown; retryAfter?: unknown; headers?: unknown };
  if (typeof candidate?.retryAfterMs === "number" && candidate.retryAfterMs >= 0) {
    return candidate.retryAfterMs;
  }

  const headers = candidate?.headers;
  const header =
    isPlainRecord(headers) ? headers["retry-after"] ?? headers["Retry-After"] : undefined;
  const raw = header ?? candidate?.retryAfter;

  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw * 1000 : undefined;
  if (typeof raw !== "string") return undefined;

  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return undefined;
  const delta = asDate - Date.now();
  return delta > 0 ? delta : 0;
}

/**
 * Base class for every error this package defines.
 *
 * Carries a stable machine-readable {@link code}, an HTTP {@link statusCode},
 * optional structured {@link details}, and the standard {@link Error.cause}.
 */
export class AppError extends Error {
  declare readonly cause?: Error;

  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, unknown>,
    cause?: Error
  ) {
    super(message, cause === undefined ? undefined : { cause });

    // `statusCode` reaches `reply.status()` in the Fastify handler, which
    // throws on anything outside 100-599. Validating here turns a latent
    // runtime failure into an immediate, obvious one.
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
      throw new RangeError(`Invalid statusCode ${String(statusCode)}; expected an integer between 100 and 599`);
    }

    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }

  /**
   * Rebuilds an error from {@link serializeError} output, so an `AppError`
   * survives a queue or database round trip with its class, code, status, and
   * nested causes intact. Returns a plain `Error` when the code has no
   * registered constructor.
   */
  static fromJSON(payload: unknown): AppError | Error | undefined {
    return deserializeError(payload);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      details: this.details,
      stack: this.stack,
    };
  }
}

/** Constructor signature used by the {@link deserializeError} registry. */
type AppErrorConstructor = new (...args: never[]) => AppError;

export class ValidationError extends AppError {
  constructor(message: string, public readonly fields: Record<string, string[]>, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", 400, { ...details, fields });
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      details: this.details,
      fields: this.fields,
      stack: this.stack,
    };
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication required", details?: Record<string, unknown>) {
    super(message, "AUTHENTICATION_ERROR", 401, details);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "Insufficient permissions", details?: Record<string, unknown>) {
    super(message, "AUTHORIZATION_ERROR", 403, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string | number, details?: Record<string, unknown>) {
    super(
      id === undefined || id === null ? `${resource} not found` : `${resource} with id "${id}" not found`,
      "NOT_FOUND",
      404,
      { ...details, resource, id }
    );
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CONFLICT", 409, details);
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests", retryAfter?: number, details?: Record<string, unknown>) {
    super(message, "RATE_LIMIT_EXCEEDED", 429, { ...details, retryAfter });
  }
}

export class InternalError extends AppError {
  constructor(message = "Internal server error", cause?: Error, details?: Record<string, unknown>) {
    super(message, "INTERNAL_ERROR", 500, details, cause);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "BAD_REQUEST", 400, details);
  }
}

export class UnprocessableError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "UNPROCESSABLE_ENTITY", 422, details);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service temporarily unavailable", details?: Record<string, unknown>) {
    super(message, "SERVICE_UNAVAILABLE", 503, details);
  }
}

export class TimeoutError extends AppError {
  constructor(message = "Operation timed out", details?: Record<string, unknown>) {
    super(message, "TIMEOUT", 504, details);
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CONFIGURATION_ERROR", 500, details);
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, public readonly query?: string, cause?: Error, details?: Record<string, unknown>) {
    super(message, "DATABASE_ERROR", 500, { ...details, query }, cause);
  }
}

export class ConnectionError extends AppError {
  constructor(service: string, cause?: Error, details?: Record<string, unknown>) {
    super(`Failed to connect to ${service}`, "CONNECTION_ERROR", 503, { ...details, service }, cause);
  }
}

export class ExternalServiceError extends AppError {
  constructor(service: string, message: string, cause?: Error, details?: Record<string, unknown>) {
    super(`${service}: ${message}`, "EXTERNAL_SERVICE_ERROR", 502, { ...details, service }, cause);
  }
}

export class KafkaError extends AppError {
  constructor(message: string, public readonly topic?: string, cause?: Error, details?: Record<string, unknown>) {
    super(message, "KAFKA_ERROR", 500, { ...details, topic }, cause);
  }
}

export class RedisError extends AppError {
  constructor(message: string, public readonly operation?: string, cause?: Error, details?: Record<string, unknown>) {
    super(message, "REDIS_ERROR", 500, { ...details, operation }, cause);
  }
}

export class WebSocketError extends AppError {
  constructor(message: string, public readonly clientId?: string, cause?: Error, details?: Record<string, unknown>) {
    super(message, "WEBSOCKET_ERROR", 500, { ...details, clientId }, cause);
  }
}

export class EncryptionError extends AppError {
  constructor(message: string, cause?: Error, details?: Record<string, unknown>) {
    super(message, "ENCRYPTION_ERROR", 500, details, cause);
  }
}

export class SerializationError extends AppError {
  constructor(message: string, cause?: Error, details?: Record<string, unknown>) {
    super(message, "SERIALIZATION_ERROR", 400, details, cause);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "Request payload too large", details?: Record<string, unknown>) {
    super(message, "PAYLOAD_TOO_LARGE", 413, details);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = "Unsupported media type", details?: Record<string, unknown>) {
    super(message, "UNSUPPORTED_MEDIA_TYPE", 415, details);
  }
}

/**
 * Several failures from one operation, kept together.
 *
 * The alternative - returning only the first error - discards the reasons for
 * every other failure, which is usually the only diagnostic that mattered.
 * `Promise.all` and `Promise.any` produce the platform `AggregateError`; this is
 * the same idea as an {@link AppError}, so it carries a code and a status.
 *
 * @example
 * ```typescript
 * const results = await Promise.allSettled([createUser(a), createUser(b)]);
 * const failures = results.filter(r => r.status === "rejected").map(r => r.reason);
 * if (failures.length > 0) throw new AggregateAppError("createUser failed", failures);
 * ```
 */
export class AggregateAppError extends AppError {
  /** Every underlying failure, in the order supplied. */
  readonly errors: unknown[];

  constructor(message: string, errors: unknown[] = [], details?: Record<string, unknown>) {
    // Report the most severe status among the members: a fan-out that includes a
    // 500 is a server fault even if three siblings returned 400.
    const statusCode = errors.reduce<number>(
      (worst, child) => Math.max(worst, getErrorStatusCode(child)),
      0
    );
    super(message, "AGGREGATE_ERROR", statusCode === 0 ? 500 : statusCode, details);
    this.errors = [...errors];
    Error.captureStackTrace?.(this, AggregateAppError);
  }

  /** The message of each member, for a one-line summary. */
  get summary(): string[] {
    return this.errors.map(child => (child instanceof Error ? child.message : String(child)));
  }

  toJSON() {
    return { ...super.toJSON(), errors: this.errors };
  }
}

export const isAppError = (error: unknown): error is AppError => {
  if (error instanceof AppError) return true;
  // A second copy of this package in the dependency tree, or a copy loaded
  // from another realm, is a fully usable AppError that fails `instanceof`.
  // Requiring `toJSON` keeps framework errors which merely happen to carry
  // `code` and `statusCode` - Fastify's own errors do - from being
  // misclassified, and guarantees `formatError` has a serializer to call.
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<AppError>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.statusCode === "number" &&
    typeof candidate.toJSON === "function"
  );
};

/**
 * Whether the error is an expected client-side condition (4xx) rather than a
 * fault in this service. Use it to decide whether to log at `error` level.
 */
export const isOperationalError = (error: unknown): boolean => {
  if (!isAppError(error)) return false;
  return error.statusCode < 500;
};

/**
 * The HTTP status to report for an error.
 *
 * Falls back to a `statusCode` or `status` carried by a foreign error before
 * defaulting to 500, so a library error that already knows its status is not
 * silently reported as a server fault.
 */
export const getErrorStatusCode = (error: unknown): number => {
  if (isAppError(error)) return error.statusCode;
  if (error instanceof Error) {
    const candidate = error as { statusCode?: unknown; status?: unknown };
    for (const value of [candidate.statusCode, candidate.status]) {
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
        return value;
      }
    }
  }
  return 500;
};

/**
 * The stable machine-readable code for an error. `AppError` subclasses report
 * their own `code`; other errors report `INTERNAL_ERROR`, and non-errors
 * report `UNKNOWN_ERROR`.
 */
export const getErrorCode = (error: unknown): string => {
  if (isAppError(error)) return error.code;
  if (error instanceof Error) return "INTERNAL_ERROR";
  return "UNKNOWN_ERROR";
};

/**
 * The canonical JSON payload for an error.
 *
 * @param error - any thrown value.
 * @param options - pass `redact` to mask sensitive keys in `details`, and
 * `includeCause` to append the `cause` chain. Both default to off because a
 * cause chain and unredacted `details` routinely carry credentials.
 */
export const formatError = (
  error: unknown,
  options: FormatErrorOptions = {}
): Record<string, unknown> => {
  const { includeStack = true, includeCause = false, includeAggregated = false, redact = false, limits } = options;

  const base: Record<string, unknown> = isAppError(error)
    ? error.toJSON()
    : error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          code: "INTERNAL_ERROR",
          statusCode: getErrorStatusCode(error),
          stack: error.stack,
        }
      : {
          name: "UnknownError",
          message: String(error),
          code: "UNKNOWN_ERROR",
          statusCode: 500,
        };

  // A platform `AggregateError` has no code or status, and without this its
  // sub-errors - the entire diagnostic - are dropped on the floor.
  if (base.errors === undefined) {
    const aggregated = getAggregateErrors(error);
    if (aggregated !== undefined) base.errors = aggregated;
  }

  if (base.details !== undefined && base.errors === undefined) {
    base.details = sanitizeDetails(base.details as Record<string, unknown>, { redact, limits });
  }

  if (!includeStack) {
    delete base.stack;
  }

  if (includeCause) {
    const chain = getErrorChain(error).slice(1);
    if (chain.length > 0) {
      base.cause = serializeError(chain[0], { maxDepth: 4, includeStack: true });
    }
  }

  if (includeAggregated && base.errors !== undefined) {
    base.errors = (base.errors as unknown[]).map(child => formatError(child, options));
  }

  return base;
};

/**
 * Every concrete error class, keyed by its stable {@link AppError.code}.
 *
 * Declared after the class definitions because it holds them by reference;
 * {@link deserializeError} reads it to rebuild an error from wire data.
 */
export const ERROR_REGISTRY: Readonly<Record<string, AppErrorConstructor>> = {
  VALIDATION_ERROR: ValidationError as unknown as AppErrorConstructor,
  AUTHENTICATION_ERROR: AuthenticationError as unknown as AppErrorConstructor,
  AUTHORIZATION_ERROR: AuthorizationError as unknown as AppErrorConstructor,
  NOT_FOUND: NotFoundError as unknown as AppErrorConstructor,
  CONFLICT: ConflictError as unknown as AppErrorConstructor,
  RATE_LIMIT_EXCEEDED: RateLimitError as unknown as AppErrorConstructor,
  INTERNAL_ERROR: InternalError as unknown as AppErrorConstructor,
  BAD_REQUEST: BadRequestError as unknown as AppErrorConstructor,
  UNPROCESSABLE_ENTITY: UnprocessableError as unknown as AppErrorConstructor,
  SERVICE_UNAVAILABLE: ServiceUnavailableError as unknown as AppErrorConstructor,
  TIMEOUT: TimeoutError as unknown as AppErrorConstructor,
  CONFIGURATION_ERROR: ConfigurationError as unknown as AppErrorConstructor,
  DATABASE_ERROR: DatabaseError as unknown as AppErrorConstructor,
  CONNECTION_ERROR: ConnectionError as unknown as AppErrorConstructor,
  EXTERNAL_SERVICE_ERROR: ExternalServiceError as unknown as AppErrorConstructor,
  KAFKA_ERROR: KafkaError as unknown as AppErrorConstructor,
  REDIS_ERROR: RedisError as unknown as AppErrorConstructor,
  WEBSOCKET_ERROR: WebSocketError as unknown as AppErrorConstructor,
  ENCRYPTION_ERROR: EncryptionError as unknown as AppErrorConstructor,
  SERIALIZATION_ERROR: SerializationError as unknown as AppErrorConstructor,
  PAYLOAD_TOO_LARGE: PayloadTooLargeError as unknown as AppErrorConstructor,
  UNSUPPORTED_MEDIA_TYPE: UnsupportedMediaTypeError as unknown as AppErrorConstructor,
  AGGREGATE_ERROR: AggregateAppError as unknown as AppErrorConstructor,
};

/**
 * Flattens an error into a JSON-safe structure that survives a network hop.
 *
 * Deliberately not `toJSON()` output: this carries the class name and the
 * `cause` chain, which `toJSON()` omits, so {@link deserializeError} can
 * rebuild the original on the far side. `details` is copied as-is - pass
 * {@link redactDetails} first if the payload may contain credentials.
 */
export function serializeError(
  error: unknown,
  options: { maxDepth?: number; includeStack?: boolean } = {}
): Record<string, unknown> {
  const { maxDepth = 8, includeStack = false } = options;

  const walk = (value: unknown, depth: number): Record<string, unknown> | string => {
    if (!(value instanceof Error)) return String(value);
    if (depth >= maxDepth) {
      return { name: value.name, message: value.message, truncated: true };
    }

    const payload: Record<string, unknown> = { name: value.name, message: value.message };

    if (isAppError(value)) {
      payload.code = value.code;
      payload.statusCode = value.statusCode;
      if (value.details !== undefined) payload.details = value.details;
    }
    if (includeStack && value.stack !== undefined) payload.stack = value.stack;

    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null) payload.cause = walk(cause, depth + 1);

    const aggregated = getAggregateErrors(value);
    if (aggregated !== undefined) payload.errors = aggregated.map(child => walk(child, depth + 1));

    return payload;
  };

  return walk(error, 0) as Record<string, unknown>;
}

/**
 * Rebuilds an error from {@link serializeError} output.
 *
 * A code in {@link ERROR_REGISTRY} rebuilds the matching class; any other code
 * yields a plain `Error` that still carries `code`, `statusCode`, and
 * `details`, so the consumer sees why it failed even without the class.
 * Returns `undefined` when the input is not a serialized error.
 */
export function deserializeError(payload: unknown): AppError | Error | undefined {
  if (!isPlainRecord(payload)) return undefined;
  if (typeof payload.name !== "string" || typeof payload.message !== "string") return undefined;

  const cause = payload.cause === undefined ? undefined : deserializeError(payload.cause);
  const details = isPlainRecord(payload.details) ? payload.details : undefined;
  const code = typeof payload.code === "string" ? payload.code : undefined;
  const rawStatus = typeof payload.statusCode === "number" ? payload.statusCode : undefined;
  // The base constructor rejects impossible statuses, and a payload may have
  // come from a producer that never went through this package.
  const statusCode =
    rawStatus !== undefined && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
      ? rawStatus
      : 500;

  const Constructor = code ? ERROR_REGISTRY[code] : undefined;
  let error: AppError | Error;

  if (Constructor === (AggregateAppError as unknown as AppErrorConstructor)) {
    const members = Array.isArray(payload.errors)
      ? payload.errors.map(child => deserializeError(child) ?? child)
      : [];
    error = new AggregateAppError(payload.message, members, details);
  } else if (Constructor) {
    // Subclasses take differing argument orders, so rebuild through the base
    // class and restore the original name. Every field the wire format carries
    // survives; only constructor-shaped extras such as `fields` are not.
    error = new AppError(payload.message, code as string, statusCode, details, cause);
    Object.defineProperty(error, "name", {
      value: Constructor.name,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  } else {
    error = new Error(payload.message, cause === undefined ? undefined : { cause });
    for (const [key, value] of Object.entries({ code, statusCode, details, name: payload.name })) {
      if (value !== undefined) {
        Object.defineProperty(error, key, {
          value,
          writable: true,
          // `name` follows Error semantics; the AppError-shaped fields are
          // enumerable so a consumer reading them off a plain Error finds them.
          enumerable: key !== "name",
          configurable: true,
        });
      }
    }
  }

  if (typeof payload.stack === "string") {
    Object.defineProperty(error, "stack", {
      value: payload.stack,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  return error;
}