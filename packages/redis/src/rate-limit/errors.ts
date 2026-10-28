 
export class RateLimitError extends Error {
  constructor(message: string, public readonly code: string, cause?: Error) {
    super(message);
    this.name = "RateLimitError";
    if (cause) this.cause = cause;
  }
}
export class RateLimitConfigError extends RateLimitError {
  constructor(message: string, public readonly parameter: string) {
    super(message, "RATE_LIMIT_CONFIG_ERROR");
    this.name = "RateLimitConfigError";
  }
}
export class ConcurrencyAcquisitionError extends RateLimitError {
  constructor(message: string = "Concurrency limit reached") {
    super(message, "CONCURRENCY_LIMIT");
    this.name = "ConcurrencyAcquisitionError";
  }
}
export class BackpressureError extends RateLimitError {
  constructor(message: string = "Backpressure limit reached") {
    super(message, "BACKPRESSURE");
    this.name = "BackpressureError";
  }
}
