import type { Logger } from "../logger.js";

/** Stable lifecycle state of a buffered operation. */
export type OperationState =
  | "CREATED"
  | "QUEUED"
  | "REPLAYING"
  | "PERSISTED"
  | "EXPIRED"
  | "REJECTED"
  | "FAILED"
  | "AMBIGUOUS"
  | "CANCELLED";

/** Terminal outcome of an operation as reported to the caller. */
export type OperationOutcome =
  | "EXECUTED"
  | "BUFFERED"
  | "REJECTED"
  | "EXPIRED"
  | "FAILED"
  | "AMBIGUOUS";

/** Result of a local read during degraded mode. */
export type LocalReadResult = "HIT" | "MISS" | "UNKNOWN";

/** Connection state tracked by the connection manager. */
export type ConnectionState = "connected" | "degraded" | "recovering" | "stopped";

/** Overflow behaviour when the bounded store reaches capacity. */
export type OverflowPolicy = "reject" | "backpressure";

/** Default fallback policy per operation category. */
export type FallbackPolicy = "buffer" | "reject";

/** Classification of why an operation could not complete. */
export type FailureClassification =
  | "connection"
  | "timeout"
  | "command"
  | "auth"
  | "unknown";

/**
 * Supported Redis command names eligible for resilience buffering.
 * Unknown commands are rejected by default per the operation-aware fallback
 * policy.
 */
export type ResilienceCommand =
  | "get"
  | "set"
  | "setex"
  | "setnx"
  | "del"
  | "expire"
  | "ttl"
  | "exists"
  | "sadd"
  | "smembers"
  | "srem"
  | "hset"
  | "hget"
  | "hdel"
  | "incr"
  | "incrby"
  | "decr"
  | "decrby"
  | "getset";

/** Commands that read data and can be served from local state during outage. */
export type ReadCommand = "get" | "exists" | "ttl" | "hget" | "smembers";

/** Commands that mutate data and can be applied locally during outage. */
export type WriteCommand = "set" | "setex" | "setnx" | "del" | "expire" | "sadd" | "srem" | "hset" | "hdel" | "getset";

/** State of a local entry in the degraded-mode data store. */
export type LocalEntryState = "valid" | "expired" | "tombstone";

/**
 * A single entry in the local degraded-mode data store. Represents the
 * process-local view of a key's value during a Redis outage.
 */
export interface LocalEntry<T = unknown> {
  /** The stored value; null for tombstones or deleted entries. */
  value: T | null;
  /** Current lifecycle state of the entry. */
  state: LocalEntryState;
  /** Absolute expiration deadline, if any. Undefined means no TTL. */
  expiresAt?: number;
  /** Monotonically increasing version for conflict detection. */
  version: number;
  /** Id of the last mutating operation that produced this entry. */
  operationId: string;
  /** When the entry was last written locally. */
  updatedAt: number;
}

/**
 * Result of reading a key from the local store during degraded mode.
 */
export interface LocalRead<T = unknown> {
  /** Whether the key was found (HIT), known absent (MISS), or unknown (UNKNOWN). */
  result: LocalReadResult;
  /** The stored value, only present when result is HIT. */
  value: T | null;
  /** The operation that last mutated this key, if any. */
  operationId?: string;
  /** Remaining TTL in seconds, if the entry is time-bounded. */
  remainingTtlSeconds?: number;
}

/**
 * Configuration for the local degraded-mode data store.
 */
export interface LocalStoreOptions {
  /** Maximum number of local entries. */
  maxEntries?: number;
  /** Maximum estimated total memory usage in bytes. */
  maxPayloadBytes?: number;
  /** Maximum estimated size of a single entry value in bytes. */
  maxEntryBytes?: number;
  /** Optional logger for structured events. */
  logger?: Logger;
}

/** Aggregate metrics for local degraded-mode data management. */
export interface LocalStoreMetrics {
  /** Current number of entries in the local store. */
  entries: number;
  /** Estimated total memory usage in bytes. */
  estimatedPayloadBytes: number;
  /** Number of local reads served during degraded mode. */
  localReads: number;
  /** Number of local reads that hit a valid entry. */
  localReadHits: number;
  /** Number of local reads that found a known absence. */
  localReadMisses: number;
  /** Number of local reads that could not be answered (UNKNOWN). */
  localReadUnknown: number;
  /** Number of local writes applied during degraded mode. */
  localWrites: number;
  /** Number of local deletions applied during degraded mode. */
  localDeletions: number;
  /** Number of entries expired during degraded mode. */
  entriesExpired: number;
  /** Number of entries rejected due to capacity limits. */
  entriesRejected: number;
  /** Number of capacity overflow events. */
  overflowEvents: number;
}

/**
 * A single operation eligible for in-memory buffering when Redis is
 * unavailable. Callers supply the command and arguments exactly as they would
 * to ioredis; the engine preserves them for replay.
 */
export interface ResilienceOperation<T = unknown> {
  /** Stable, caller-supplied or engine-generated operation identifier. */
  id: string;
  /** Redis command to execute on recovery. */
  command: ResilienceCommand;
  /** Primary resource key, used for per-key ordering and dedup. */
  key: string;
  /** Command arguments excluding the key itself. */
  args: unknown[];
  /** Optional absolute TTL in seconds for time-bounded operations. */
  ttlSeconds?: number;
  /** Optional tags for cache invalidation grouping. */
  tags?: string[];
  /** Whether replaying this operation is idempotent (safe to retry). */
  idempotent?: boolean;
  /** Whether a newer write to the same key supersedes this one. */
  replaceable?: boolean;
  /** Override the default fallback policy for this operation. */
  policy?: FallbackPolicy;
  /** Payload to persist when the command is a write (set, hset, sadd, etc.). */
  payload?: T;
  /** Absolute deadline after which the operation must not be replayed. */
  expiresAt?: number;
  /** Idempotency key for deduplication across recovery cycles. */
  deduplicationKey?: string;
  /** Conflict resolution policy for this operation during recovery. */
  conflictPolicy?: ConflictPolicy;
}

/**
 * How to handle conflicts when Redis already has a newer value for a key
 * during recovery.
 */
export type ConflictPolicy = "overwrite" | "reject" | "abort";

/**
 * Internal record of a queued operation, with admission metadata. Not part of
 * the public surface.
 */
export interface QueuedOperation<T = unknown> extends ResilienceOperation<T> {
  state: OperationState;
  createdAt: number;
  acceptedAt: number;
  expiresAt: number;
  remainingTtlSeconds?: number;
  retries: number;
  lastError?: unknown;
  lastClassification?: FailureClassification;
  sequence: number;
  sizeBytes: number;
  deduplicationKey?: string;
  /** Redis-side version observed during recovery, for conflict detection. */
  redisVersion?: number;
  /** Whether a conflict was detected during recovery. */
  conflicted?: boolean;
}

/**
 * Result of executing or buffering an operation through the engine.
 */
export interface ResilienceResult<T = unknown> {
  outcome: OperationOutcome;
  value: T | null;
  operationId: string;
  state: OperationState;
  error?: Error;
  classification?: FailureClassification;
  bufferedAt?: number;
  recoveredAt?: number;
  remainingTtlSeconds?: number;
  reason?: string;
}

/**
 * Configuration for the resilience engine. All limits are validated at
 * construction and enforced at runtime.
 */
export interface ResilienceEngineOptions {
  /** Enable or disable fallback buffering entirely. Default true. */
  enabled?: boolean;
  /** Maximum number of pending operations in the bounded store. */
  maxOperations?: number;
  /** Maximum estimated total memory usage of buffered operations in bytes. */
  maxPayloadBytes?: number;
  /** Maximum estimated size of a single operation in bytes. */
  maxOperationBytes?: number;
  /** Maximum retry attempts for recoverable operations. */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff. */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds for exponential backoff. */
  maxDelayMs?: number;
  /** Apply jitter to retry delays. */
  jitter?: boolean;
  /** Maximum operations to process per recovery batch. */
  recoveryBatchSize?: number;
  /** Maximum concurrent recovery workers. */
  recoveryConcurrency?: number;
  /** Behaviour when the store reaches capacity. */
  overflow?: OverflowPolicy;
  /** Alias for the total memory limit of fallback state and journal. */
  maxBufferSize?: number;
  /** Alias for the maximum queued operations. */
  maxPendingOperations?: number;
  /** Maximum age, in milliseconds, before a pending operation becomes stale. */
  maxPendingAge?: number;
  /** Behaviour when a configured limit is reached; only "reject" is supported. */
  onLimitExceeded?: "reject";
  /** Optional logger for structured events. */
  logger?: Logger;
  /**
   * Whether to dedupe non-idempotent writes by operation id during recovery.
   * When true, the engine marks delivered operation ids and skips replay if
   * the id was already processed in a prior recovery cycle.
   */
  dedupeOnRecovery?: boolean;
  /** Conflict resolution policy when Redis has a newer value during recovery. */
  conflictPolicy?: ConflictPolicy;
  /** Whether the engine automatically starts recovery on reconnection. Default true. */
  autoRecover?: boolean;
}

/** Aggregate metrics for local degraded-mode data management. */
export interface LocalStoreMetrics {
  /** Current number of entries in the local store. */
  entries: number;
  /** Estimated total memory usage in bytes. */
  estimatedPayloadBytes: number;
  /** Number of local reads served during degraded mode. */
  localReads: number;
  /** Number of local reads that hit a valid entry. */
  localReadHits: number;
  /** Number of local reads that found a known absence. */
  localReadMisses: number;
  /** Number of local reads that could not be answered (UNKNOWN). */
  localReadUnknown: number;
  /** Number of local writes applied during degraded mode. */
  localWrites: number;
  /** Number of local deletions applied during degraded mode. */
  localDeletions: number;
  /** Number of entries expired during degraded mode. */
  entriesExpired: number;
  /** Number of entries rejected due to capacity limits. */
  entriesRejected: number;
  /** Number of capacity overflow events. */
  overflowEvents: number;
}

/** Aggregate metrics exposed by the engine. */
export interface ResilienceMetrics {
  connectionState: ConnectionState;
  pendingOperations: number;
  estimatedPayloadBytes: number;
  operationsBuffered: number;
  operationsPersisted: number;
  operationsExpired: number;
  operationsRejected: number;
  operationsFailed: number;
  operationsAmbiguous: number;
  retryAttempts: number;
  retryExhausted: number;
  overflowEvents: number;
  recoveryCycles: number;
  outageStartMs?: number;
  outageDurationMs?: number;
  oldestPendingAgeMs?: number;
  /** Number of conflicts detected during recovery. */
  conflictsDetected: number;
  /** Total time spent in recovery across all cycles, in ms. */
  recoveryDurationMs: number;
  /** Local degraded-mode data store metrics. */
  localStore: LocalStoreMetrics;
}

/**
 * Structured lifecycle event emitted by the engine. Sensitive payloads are
 * never included.
 */
export interface ResilienceEvent {
  type:
    | "redis.degraded"
    | "redis.reconnected"
    | "redis.recovery.started"
    | "redis.recovery.completed"
    | "redis.operation.buffered"
    | "redis.operation.persisted"
    | "redis.operation.expired"
    | "redis.operation.failed"
    | "redis.operation.ambiguous"
    | "redis.operation.rejected"
    | "redis.fallback.capacity_exceeded"
    | "redis.local.read.hit"
    | "redis.local.read.miss"
    | "redis.local.read.unknown"
    | "redis.local.write"
    | "redis.local.delete"
    | "redis.local.entry.expired"
    | "redis.recovery.conflict";
  timestamp: number;
  operationId?: string;
  command?: string;
  key?: string;
  state?: OperationState;
  outcome?: OperationOutcome;
  classification?: FailureClassification;
  error?: string;
  pendingCount?: number;
  durationMs?: number;
  reason?: string;
}

/** Callback for lifecycle events. */
export type ResilienceEventHandler = (event: ResilienceEvent) => void;
