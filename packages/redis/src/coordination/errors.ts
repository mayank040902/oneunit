 
/** Base class for all coordination errors */
export class CoordinationError extends Error {
  code: string;
  constructor(
    message: string,
    code: string,
    cause?: Error,
  ) {
    super(message);
    this.name = "CoordinationError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** Error when lock acquisition fails due to contention */
export class LockContendedError extends CoordinationError {
  constructor(
    message: string = "Lock is held by another owner",
    public readonly resource: string,
    public readonly currentOwner?: string,
    cause?: Error,
  ) {
    super(message, "LOCK_CONTENDED", cause);
    this.name = "LockContendedError";
  }
}

/** Error when lock acquisition times out */
export class LockTimeoutError extends CoordinationError {
  constructor(
    message: string = "Lock acquisition timed out",
    public readonly resource: string,
    public readonly timeoutMs: number,
    cause?: Error,
  ) {
    super(message, "LOCK_TIMEOUT", cause);
    this.name = "LockTimeoutError";
  }
}

/** Error when lock release fails due to ownership mismatch */
export class LockOwnershipError extends CoordinationError {
  constructor(
    message: string = "Lock ownership mismatch; cannot release lock owned by another process",
    public readonly resource: string,
    public readonly expectedToken: string,
    public readonly actualToken?: string,
    cause?: Error,
  ) {
    super(message, "LOCK_OWNERSHIP_MISMATCH", cause);
    this.name = "LockOwnershipError";
  }
}

/** Error when lock renewal fails */
export class LockRenewalError extends CoordinationError {
  constructor(
    message: string = "Lock renewal failed",
    public readonly resource: string,
    public readonly reason: "expired" | "ownership_lost" | "timeout" | "unknown",
    cause?: Error,
  ) {
    super(message, "LOCK_RENEWAL_FAILED", cause);
    this.name = "LockRenewalError";
  }
}

/** Error when lock lease is lost during execution */
export class LockLeaseLostError extends CoordinationError {
  constructor(
    message: string = "Lock lease was lost during execution",
    public readonly resource: string,
    public readonly fencingToken: number,
    cause?: Error,
  ) {
    super(message, "LOCK_LEASE_LOST", cause);
    this.name = "LockLeaseLostError";
  }
}

/** Error when semaphore is exhausted */
export class SemaphoreExhaustedError extends CoordinationError {
  constructor(
    message: string = "Semaphore has no available permits",
    public readonly resource: string,
    public readonly totalPermits: number,
    public readonly availablePermits: number,
    cause?: Error,
  ) {
    super(message, "SEMAPHORE_EXHAUSTED", cause);
    this.name = "SemaphoreExhaustedError";
  }
}

/** Error when semaphore acquisition times out */
export class SemaphoreTimeoutError extends CoordinationError {
  constructor(
    message: string = "Semaphore acquisition timed out",
    public readonly resource: string,
    public readonly timeoutMs: number,
    cause?: Error,
  ) {
    super(message, "SEMAPHORE_TIMEOUT", cause);
    this.name = "SemaphoreTimeoutError";
  }
}

/** Error when semaphore permit release fails due to ownership mismatch */
export class SemaphoreOwnershipError extends CoordinationError {
  constructor(
    message: string = "Semaphore permit ownership mismatch",
    public readonly resource: string,
    public readonly expectedToken: string,
    public readonly actualToken?: string,
    cause?: Error,
  ) {
    super(message, "SEMAPHORE_OWNERSHIP_MISMATCH", cause);
    this.name = "SemaphoreOwnershipError";
  }
}

/** Error when single-flight execution fails */
export class SingleFlightError extends CoordinationError {
  constructor(
    message: string = "Single-flight execution failed",
    public readonly key: string,
    public readonly isOwner: boolean,
    cause?: Error,
  ) {
    super(message, "SINGLE_FLIGHT_FAILED", cause);
    this.name = "SingleFlightError";
  }
}

/** Error when single-flight times out waiting for result */
export class SingleFlightTimeoutError extends CoordinationError {
  constructor(
    message: string = "Single-flight timed out waiting for result",
    public readonly key: string,
    public readonly timeoutMs: number,
    cause?: Error,
  ) {
    super(message, "SINGLE_FLIGHT_TIMEOUT", cause);
    this.name = "SingleFlightTimeoutError";
  }
}

/** Error when leader election fails */
export class LeaderElectionError extends CoordinationError {
  constructor(
    message: string = "Leader election failed",
    public readonly resource: string,
    public readonly reason: "contended" | "renewal_failed" | "timeout" | "cancelled",
    cause?: Error,
  ) {
    super(message, "LEADER_ELECTION_FAILED", cause);
    this.name = "LeaderElectionError";
  }
}

/** Error when job claim fails */
export class JobClaimError extends CoordinationError {
  constructor(
    message: string = "Job claim failed",
    public readonly jobId: string,
    public readonly reason: "already_claimed" | "completed" | "expired" | "failed" | "timeout" | "ownership_lost",
    cause?: Error,
  ) {
    super(message, "JOB_CLAIM_FAILED", cause);
    this.name = "JobClaimError";
  }
}

/** Error when job completion fails */
export class JobCompletionError extends CoordinationError {
  constructor(
    message: string = "Job completion failed",
    public readonly jobId: string,
    public readonly reason: "ownership_lost" | "already_completed" | "expired" | "fencing_rejected",
    cause?: Error,
  ) {
    super(message, "JOB_COMPLETION_FAILED", cause);
    this.name = "JobCompletionError";
  }
}

/** Error when resource lease acquisition fails */
export class LeaseAcquisitionError extends CoordinationError {
  constructor(
    message: string = "Lease acquisition failed",
    public readonly resource: string,
    public readonly reason: "contended" | "timeout" | "cancelled",
    cause?: Error,
  ) {
    super(message, "LEASE_ACQUISITION_FAILED", cause);
    this.name = "LeaseAcquisitionError";
  }
}

/** Error when resource lease renewal fails */
export class LeaseRenewalError extends CoordinationError {
  constructor(
    message: string = "Lease renewal failed",
    public readonly resource: string,
    public readonly reason: "expired" | "ownership_lost" | "timeout",
    cause?: Error,
  ) {
    super(message, "LEASE_RENEWAL_FAILED", cause);
    this.name = "LeaseRenewalError";
  }
}

/** Error when resource lease release fails */
export class LeaseReleaseError extends CoordinationError {
  constructor(
    message: string = "Lease release failed",
    public readonly resource: string,
    public readonly reason: "ownership_lost" | "not_found",
    cause?: Error,
  ) {
    super(message, "LEASE_RELEASE_FAILED", cause);
    this.name = "LeaseReleaseError";
  }
}

/** Error when barrier operation fails */
export class BarrierError extends CoordinationError {
  constructor(
    message: string = "Barrier operation failed",
    public readonly barrierId: string,
    public readonly reason: "timeout" | "cancelled" | "generation_mismatch" | "duplicate_arrival",
    cause?: Error,
  ) {
    super(message, "BARRIER_FAILED", cause);
    this.name = "BarrierError";
  }
}

/** Error when fencing token validation fails */
export class FencingTokenError extends CoordinationError {
  constructor(
    message: string = "Fencing token validation failed",
    public readonly expectedToken: number,
    public readonly providedToken: number,
    public readonly resource: string,
    cause?: Error,
  ) {
    super(message, "FENCING_TOKEN_REJECTED", cause);
    this.name = "FencingTokenError";
  }
}

/** Error for invalid configuration */
export class CoordinationConfigError extends CoordinationError {
  constructor(
    message: string,
    public readonly parameter: string,
    cause?: Error,
  ) {
    super(message, "COORDINATION_CONFIG_ERROR", cause);
    this.name = "CoordinationConfigError";
  }
}

/** Error when operation is cancelled */
export class CoordinationCancelledError extends CoordinationError {
  constructor(
    message: string = "Operation was cancelled",
    public readonly operation: string,
    cause?: Error,
  ) {
    super(message, "COORDINATION_CANCELLED", cause);
    this.name = "CoordinationCancelledError";
  }
}

/** Error when Redis command outcome is ambiguous */
export class AmbiguousResultError extends CoordinationError {
  constructor(
    message: string = "Redis command outcome is ambiguous; operation may have executed",
    public readonly operation: string,
    public readonly resource: string,
    cause?: Error,
  ) {
    super(message, "AMBIGUOUS_RESULT", cause);
    this.name = "AmbiguousResultError";
  }
}

/** Type guard for coordination errors */
export function isCoordinationError(error: unknown): error is CoordinationError {
  return error instanceof CoordinationError;
}

/** Type guard for specific error types */
export function isLockContendedError(error: unknown): error is LockContendedError {
  return error instanceof LockContendedError;
}

export function isLockTimeoutError(error: unknown): error is LockTimeoutError {
  return error instanceof LockTimeoutError;
}

export function isLockOwnershipError(error: unknown): error is LockOwnershipError {
  return error instanceof LockOwnershipError;
}

export function isLockRenewalError(error: unknown): error is LockRenewalError {
  return error instanceof LockRenewalError;
}

export function isLockLeaseLostError(error: unknown): error is LockLeaseLostError {
  return error instanceof LockLeaseLostError;
}

export function isSemaphoreExhaustedError(error: unknown): error is SemaphoreExhaustedError {
  return error instanceof SemaphoreExhaustedError;
}

export function isSemaphoreTimeoutError(error: unknown): error is SemaphoreTimeoutError {
  return error instanceof SemaphoreTimeoutError;
}

export function isSemaphoreOwnershipError(error: unknown): error is SemaphoreOwnershipError {
  return error instanceof SemaphoreOwnershipError;
}

export function isSingleFlightError(error: unknown): error is SingleFlightError {
  return error instanceof SingleFlightError;
}

export function isSingleFlightTimeoutError(error: unknown): error is SingleFlightTimeoutError {
  return error instanceof SingleFlightTimeoutError;
}

export function isLeaderElectionError(error: unknown): error is LeaderElectionError {
  return error instanceof LeaderElectionError;
}

export function isJobClaimError(error: unknown): error is JobClaimError {
  return error instanceof JobClaimError;
}

export function isJobCompletionError(error: unknown): error is JobCompletionError {
  return error instanceof JobCompletionError;
}

export function isLeaseAcquisitionError(error: unknown): error is LeaseAcquisitionError {
  return error instanceof LeaseAcquisitionError;
}

export function isLeaseRenewalError(error: unknown): error is LeaseRenewalError {
  return error instanceof LeaseRenewalError;
}

export function isLeaseReleaseError(error: unknown): error is LeaseReleaseError {
  return error instanceof LeaseReleaseError;
}

export function isBarrierError(error: unknown): error is BarrierError {
  return error instanceof BarrierError;
}

export function isFencingTokenError(error: unknown): error is FencingTokenError {
  return error instanceof FencingTokenError;
}

export function isCoordinationConfigError(error: unknown): error is CoordinationConfigError {
  return error instanceof CoordinationConfigError;
}

export function isCoordinationCancelledError(error: unknown): error is CoordinationCancelledError {
  return error instanceof CoordinationCancelledError;
}

export function isAmbiguousResultError(error: unknown): error is AmbiguousResultError {
  return error instanceof AmbiguousResultError;
}