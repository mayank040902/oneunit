
export interface RetryPolicy {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  retryWhen?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export interface RetryResult<T> {
  value: T;
  attempts: number;
}

export async function retryOperation<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy = {},
): Promise<T> {
  const attempts = policy.attempts ?? 3;
  const baseDelayMs = policy.baseDelayMs ?? 100;
  const maxDelayMs = policy.maxDelayMs ?? 5000;
  const jitter = policy.jitter ?? true;

  if (!Number.isFinite(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive finite number");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      const retryable =
        policy.retryWhen !== undefined ? policy.retryWhen(error) : true;
      const classifiedRetryable =
        error &&
        typeof error === "object" &&
        "retryable" in error
          ? Boolean((error as { retryable: boolean }).retryable)
          : undefined;

      const shouldRetry =
        attempt < attempts &&
        retryable &&
        (classifiedRetryable === undefined || classifiedRetryable);

      if (!shouldRetry) {
        throw error;
      }

      let delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      if (jitter) {
        delay = Math.floor(delay * (0.5 + Math.random() * 0.5));
      }

      if (policy.onRetry) {
        policy.onRetry(attempt, error, delay);
      }

      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

export async function retryOperationWithResult<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy = {},
): Promise<RetryResult<T>> {
  let calls = 0;
  const value = await retryOperation(async () => {
    calls += 1;
    return operation();
  }, policy);

  return { value, attempts: calls };
}

export { classifyError as isRetryClassifiedError } from "./events.js";
