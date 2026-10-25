import {
  type FailureClassification,
  type OperationOutcome,
  type OperationState,
  type QueuedOperation,
} from "./types.js";

/**
 * Tracks absolute expiration deadlines for buffered operations. The deadline is
 * set at admission time and never extended on recovery: an operation accepted
 * with a 60-second TTL expires 60 seconds after acceptance, regardless of how
 * long Redis was unavailable.
 */
export class ExpirationManager {
  private readonly now: () => number;

  constructor(options?: { clock?: () => number }) {
    this.now = options?.clock ?? (() => Date.now());
  }

  /**
   * Compute the absolute expiry timestamp for an operation.
   *
   * - If `expiresAt` is supplied, it is used verbatim.
   * - Otherwise, `acceptedAt + ttlSeconds * 1000`.
   * - Operations without a TTL never expire.
   */
  computeExpiresAt(
    operation: {
      expiresAt?: number;
      ttlSeconds?: number;
      acceptedAt?: number;
    },
    now: number = this.now(),
  ): number | undefined {
    if (operation.expiresAt !== undefined) {
      return operation.expiresAt;
    }

    if (operation.ttlSeconds !== undefined) {
      const base = operation.acceptedAt ?? now;
      if (!Number.isFinite(operation.ttlSeconds) || operation.ttlSeconds <= 0) {
        throw new Error("ttlSeconds must be a positive finite number");
      }
      return base + operation.ttlSeconds * 1000;
    }

    return undefined;
  }

  /**
   * Whether an operation's absolute deadline has passed.
   */
  isExpired(operation: QueuedOperation, now: number = this.now()): boolean {
    return operation.expiresAt <= now;
  }

  /**
   * Remaining lifetime in seconds, or undefined for timeless operations.
   * Returns 0 or negative when already expired.
   */
  remainingTtlSeconds(
    operation: QueuedOperation,
    now: number = this.now(),
  ): number | undefined {
    if (operation.expiresAt === undefined || operation.expiresAt === 0) {
      return undefined;
    }
    return Math.max(0, Math.ceil((operation.expiresAt - now) / 1000));
  }

  /**
   * Transition an expired operation to the EXPIRED terminal state without
   * recreating its value in Redis.
   */
  expireOperation(
    _operation: QueuedOperation,
    _reason: string,
  ): {
    state: OperationState;
    outcome: OperationOutcome;
    classification: FailureClassification;
  } {
    return {
      state: "EXPIRED",
      outcome: "EXPIRED",
      classification: "unknown",
    };
  }

  /**
   * Determine the remaining TTL to apply when persisting a recovered
   * operation. If the remaining lifetime is zero or negative, the operation
   * must be treated as expired and not written.
   */
  ttlForPersistence(
    operation: QueuedOperation,
    now: number = this.now(),
  ): { ttlSeconds: number; expired: boolean } {
    const remaining = this.remainingTtlSeconds(operation, now);
    if (remaining === undefined) {
      // No TTL: preserve the original semantics (no expiry).
      return { ttlSeconds: -1, expired: false };
    }
    if (remaining <= 0) {
      return { ttlSeconds: 0, expired: true };
    }
    return { ttlSeconds: remaining, expired: false };
  }
}
