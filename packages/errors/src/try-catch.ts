import { 
  AppError, 
  InternalError, 
  TimeoutError,
  AggregateAppError,
  isRetryable,
  getRetryAfter,
} from "./errors.js";

/** Shared shape returned by the try/catch helpers. */
export interface TryCatchResult<T, E extends AppError = AppError> {
  data: T | null;
  error: E | null;
}

/** @deprecated Use {@link TryCatchResult}; the two shapes are identical. */
export type AsyncTryCatchResult<T, E extends AppError = AppError> = TryCatchResult<T, E>;

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) return new InternalError(error.message, error);
  return new InternalError(String(error));
}

function toError<E>(errorFactory: ((error: unknown) => E) | undefined, caught: unknown): E {
  if (errorFactory) {
    try {
      return errorFactory(caught);
    } catch {
      return toAppError(caught) as E;
    }
  }
  return toAppError(caught) as E;
}

export function tryCatch<T, E extends AppError = AppError>(
  fn: () => T,
  errorFactory?: (error: unknown) => E
): TryCatchResult<T, E> {
  try {
    const data = fn();
    return { data, error: null };
  } catch (err: unknown) {
    return { data: null, error: toError(errorFactory, err) };
  }
}

export async function tryCatchAsync<T, E extends AppError = AppError>(
  promise: Promise<T>,
  errorFactory?: (error: unknown) => E
): Promise<AsyncTryCatchResult<T, E>> {
  try {
    const data = await promise;
    return { data, error: null };
  } catch (err: unknown) {
    return { data: null, error: toError(errorFactory, err) };
  }
}

export function tryCatchSync<T, E extends AppError = AppError>(
  fn: () => T,
  options?: {
    onError?: (error: E) => void;
    errorFactory?: (error: unknown) => E;
  }
): T | null {
  try {
    return fn();
  } catch (err: unknown) {
    const error = toError(options?.errorFactory, err);
    options?.onError?.(error);
    return null;
  }
}

export async function tryCatchPromise<T, E extends AppError = AppError>(
  promise: Promise<T>,
  options?: {
    onError?: (error: E) => void;
    errorFactory?: (error: unknown) => E;
  }
): Promise<T | null> {
  try {
    return await promise;
  } catch (err: unknown) {
    const error = toError(options?.errorFactory, err);
    options?.onError?.(error);
    return null;
  }
}

export function assertNever(value: never, message = "Unexpected value"): never {
  throw new InternalError(message);
}

export function unreachable(message = "Unreachable code reached"): never {
  throw new InternalError(message);
}

export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Recovers from an error result with a fallback derived from the error. */
export function unwrapOrElse<T, E>(result: Result<T, E>, onError: (error: E) => T): T {
  return result.ok ? result.value : onError(result.error);
}

/**
 * Folds both branches into a single value - the exhaustive way to consume a
 * `Result` without an intermediate `if`.
 */
export function match<T, E, U>(
  result: Result<T, E>,
  handlers: { ok: (value: T) => U; err: (error: E) => U }
): U {
  return result.ok ? handlers.ok(result.value) : handlers.err(result.error);
}

/** Alias for {@link match}, named for the algebraic term. */
export function fold<T, E, U>(
  result: Result<T, E>,
  handlers: { ok: (value: T) => U; err: (error: E) => U }
): U {
  return match(result, handlers);
}

/** Runs `fn` for its side effect on success, returning the result unchanged. */
export function tap<T, E>(result: Result<T, E>, fn: (value: T) => void): Result<T, E> {
  if (result.ok) fn(result.value);
  return result;
}

/**
 * Short-circuits on the first error, like `Promise.all` - every operation is
 * started, but the returned result is the first failure in argument order.
 */
export function collect<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

/**
 * Every failure, not just the first.
 *
 * {@link collect} discards the failures it did not return, which is usually the
 * wrong trade when each one came from a different operation. This keeps them
 * all in an {@link AggregateAppError} in argument order.
 *
 * @returns the values when nothing failed, otherwise an `AggregateAppError`
 * carrying every failure. With no failures the result is `ok([])`.
 */
export function combineAll<T, E>(results: readonly Result<T, E>[]): Result<T[], AggregateAppError> {
  const values: T[] = [];
  const failures: E[] = [];

  for (const result of results) {
    if (result.ok) values.push(result.value);
    else failures.push(result.error);
  }

  if (failures.length === 0) return ok(values);

  return err(
    new AggregateAppError(
      failures.length === 1
        ? (failures[0] instanceof Error ? failures[0].message : String(failures[0]))
        : `${failures.length} of ${results.length} operations failed`,
      failures
    )
  );
}

/**
 * The settling counterpart to {@link tryAll}: keeps every failure rather than
 * only the first.
 *
 * @example
 * ```typescript
 * const result = await tryAllSettled([save(a), save(b), save(c)]);
 * if (isErr(result)) result.error.errors.forEach(e => report(e));
 * ```
 */
export async function tryAllSettled<T, E>(
  promises: Promise<T>[],
  errorFactory?: (error: unknown) => E
): Promise<Result<T[], AggregateAppError>> {
  const results: Result<T, E>[] = await Promise.all(
    promises.map(p =>
      p.then(value => ok(value) as Result<T, E>)
       .catch((caught: unknown) => err(toError(errorFactory, caught)))
    )
  );
  return combineAll(results);
}

export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

export function andThen<T, U, E>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/**
 * Async {@link andThen}. A rejection from `fn` is captured as an error result
 * instead of propagating, so an async chain never leaves the `Result` world by
 * accident.
 */
export async function andThenAsync<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Promise<Result<U, E>>
): Promise<Result<U, E>> {
  if (!result.ok) return result;
  try {
    return await fn(result.value);
  } catch (caught: unknown) {
    return err(caught as E);
  }
}

/** Async {@link collect}: awaits every result and short-circuits on the first error. */
export async function collectAsync<T, E>(
  results: readonly Promise<Result<T, E>>[]
): Promise<Result<T[], E>> {
  const settled = await Promise.all(results);
  return collect(settled);
}

export function orElse<T, E, F>(result: Result<T, E>, fn: (error: E) => Result<T, F>): Result<T, F> {
  return result.ok ? result : fn(result.error);
}

export async function tryCatchResult<T, E extends AppError = AppError>(
  promise: Promise<T>,
  errorFactory?: (error: unknown) => E
): Promise<Result<T, E>> {
  try {
    const data = await promise;
    return ok(data);
  } catch (caughtErr: unknown) {
    return err(toError(errorFactory, caughtErr));
  }
}

export function combine<E>(results: readonly Result<unknown, E>[]): Result<unknown[], E> {
  const values: unknown[] = [];
  for (const result of results) {
    if (!result.ok) return result as Result<unknown[], E>;
    values.push(result.value);
  }
  return ok(values);
}

export async function tryAll<E>(
  promises: Promise<unknown>[],
  errorFactory?: (error: unknown) => E
): Promise<Result<unknown[], E>> {
  const results: Result<unknown, E>[] = await Promise.all(
    promises.map(p =>
      p.then(value => ok(value) as Result<unknown, E>)
       .catch((caught: unknown) => err(toError(errorFactory, caught)))
    )
  );
  return combine(results);
}

/**
 * Rejection reason used when a {@link withTimeout} or {@link withRetry} call is
 * aborted.
 *
 * Always this class, never the platform's `DOMException`, so a caller can
 * recognise an abort with `instanceof` regardless of how the signal was
 * triggered. The platform reason is kept in `cause`.
 */
export class AbortError extends Error {
  declare readonly cause?: unknown;

  constructor(message = "Operation aborted", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AbortError";
    Error.captureStackTrace?.(this, AbortError);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): AbortError {
  return new AbortError("Operation aborted", signal.reason);
}

/**
 * Awaits `promise`, rejecting with {@link TimeoutError} if it takes longer than
 * `ms` milliseconds.
 *
 * The timer is always cleared, so a fast promise does not keep the event loop
 * alive for the rest of the timeout. Pass `signal` to abort early, and note
 * that this stops *waiting* - it does not cancel the underlying work, which
 * needs its own `AbortSignal`.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = "Operation timed out",
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  const { signal } = options;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    if (signal) {
      onAbort = () => reject(abortError(signal));
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });

  // The race is settled by whichever side wins; the losers are already handled
  // by `race`, so their later rejection must not surface as an unhandled one.
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}

export interface RetryOptions {
  /** Total attempts including the first. Values below 1 are treated as 1. */
  maxAttempts?: number;
  /** Delay before the second attempt, in milliseconds. */
  delay?: number;
  /** Multiplier applied to the delay after each failure. */
  backoff?: number;
  /** Upper bound on any single delay, in milliseconds. */
  maxDelay?: number;
  /** Upper bound on the total time spent sleeping across all retries. */
  maxTotalDelay?: number;
  /** Randomizes each delay within `[delay / 2, delay]` to avoid thundering herds. */
  jitter?: boolean;
  /**
   * Obey a `Retry-After` instruction carried by the error, rather than retrying
   * on the local backoff schedule. Defaults to `true`: a server that says
   * "30 seconds" is reporting when it will be ready, and retrying sooner is
   * both pointless load and, on a rate limiter, a self-inflicted ban. The
   * instruction still respects `maxDelay` and `maxTotalDelay`.
   */
  respectRetryAfter?: boolean;
  /** Decide whether a given failure is worth retrying. Defaults to {@link isRetryable}. */
  shouldRetry?: (error: unknown) => boolean;
  /** Cancels pending retry sleeps and aborts the returned promise. */
  signal?: AbortSignal;
  /** Notified before each sleep, e.g. to emit a retry metric. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Calls `fn` until it succeeds, backing off between attempts.
 *
 * @throws the last error once attempts are exhausted or `shouldRetry` declines.
 * A non-finite or negative option is clamped rather than allowed to produce an
 * `undefined` rejection.
 */
export function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    delay = 1000,
    backoff = 2,
    maxDelay,
    maxTotalDelay,
    jitter = false,
    respectRetryAfter = true,
    shouldRetry = isRetryable,
    signal,
    onRetry,
  } = options;

  const attempts = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 1;
  const baseDelay = Number.isFinite(delay) && delay > 0 ? delay : 0;
  const factor = Number.isFinite(backoff) && backoff > 0 ? backoff : 1;
  const delayCap = typeof maxDelay === "number" && Number.isFinite(maxDelay) && maxDelay > 0
    ? maxDelay
    : Number.POSITIVE_INFINITY;
  const totalCap = typeof maxTotalDelay === "number" && Number.isFinite(maxTotalDelay) && maxTotalDelay > 0
    ? maxTotalDelay
    : Number.POSITIVE_INFINITY;

  return (async () => {
    let sleptTotal = 0;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      throwIfAborted(signal);

      try {
        return await fn();
      } catch (error: unknown) {
        if (attempt === attempts || !shouldRetry(error)) throw error;

        let waitTime = Math.min(baseDelay * Math.pow(factor, attempt - 1), delayCap);

        // A server's Retry-After is a floor, not a suggestion: take whichever of
        // the two asks for the longer wait, so a fast local backoff cannot
        // override an explicit "not for 30 seconds".
        if (respectRetryAfter) {
          const requested = getRetryAfter(error);
          if (requested !== undefined) waitTime = Math.max(waitTime, requested);
        }

        if (jitter && waitTime > 0) {
          waitTime = waitTime / 2 + Math.random() * (waitTime / 2);
        }

        // A Retry-After beyond the caller's own ceiling still counts against the
        // budget: giving up is the correct answer, not silently retrying early.
        if (waitTime > delayCap || sleptTotal + waitTime > totalCap) {
          throw new TimeoutError(
            `Retry budget exhausted after ${sleptTotal}ms of backoff; last error: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { attempts: attempt }
          );
        }

        sleptTotal += waitTime;
        onRetry?.(error, attempt, waitTime);

        if (waitTime > 0) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              signal?.removeEventListener("abort", onAbortSignal);
              resolve();
            }, waitTime);

            const onAbortSignal = () => {
              clearTimeout(timer);
              reject(signal ? abortError(signal) : new AbortError());
            };

            if (signal) {
              if (signal.aborted) {
                onAbortSignal();
                return;
              }
              signal.addEventListener("abort", onAbortSignal, { once: true });
            }
          });
        } else {
          throwIfAborted(signal);
        }
      }
    }

    throw new InternalError("withRetry exhausted without a result");
  })();
}