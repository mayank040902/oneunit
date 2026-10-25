import type { Logger } from "../logger.js";
import {
  type FailureClassification,
  type OperationOutcome,
  type OperationState,
  type QueuedOperation,
  type ResilienceOperation,
} from "./types.js";

const DEFAULT_MAX_OPERATIONS = 10000;
const DEFAULT_MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB
const DEFAULT_MAX_OPERATION_BYTES = 1024 * 1024; // 1 MiB

/**
 * Estimates the in-memory byte size of a queued operation record. This is a
 * conservative approximation used for memory-budget enforcement, not an exact
 * measurement.
 */
function estimateSize(op: ResilienceOperation): number {
  let size = 256; // fixed record overhead (metadata, timestamps, counters)
  size += Buffer.byteLength(op.id);
  size += Buffer.byteLength(op.command);
  size += Buffer.byteLength(op.key);
  size += op.args.reduce((sum: number, arg: unknown) => sum + estimateValueBytes(arg), 0);
  if (op.payload !== undefined) {
    size += estimateValueBytes(op.payload);
  }
  if (op.tags) {
    size += op.tags.reduce((sum: number, tag: string) => sum + Buffer.byteLength(tag), 0);
  }
  if (op.deduplicationKey) {
    size += Buffer.byteLength(op.deduplicationKey);
  }
  return size;
}

function estimateValueBytes(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "string") {
    return Buffer.byteLength(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return 8;
  }
  if (Buffer.isBuffer(value)) {
    return value.length;
  }
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 256;
  }
}

/**
 * Bounded in-memory store of pending operations awaiting Redis recovery.
 *
 * Enforces operation count, total memory, and per-operation size limits.
 * Operations are stored in insertion order and indexed by id for lookup and by
 * key for per-key ordering.
 */
export class OperationStore {
  private readonly maxOperations: number;
  private readonly maxPayloadBytes: number;
  private readonly maxOperationBytes: number;
  private readonly maxPendingAge: number | undefined;
  private readonly logger: Logger | undefined;

  private readonly operations = new Map<string, QueuedOperation>();
  private readonly byKey = new Map<string, string[]>(); // key -> operation ids in order
  private sequence = 0;
  private estimatedBytes = 0;
  private overflowEvents = 0;

  constructor(options: {
    maxOperations?: number;
    maxPayloadBytes?: number;
    maxOperationBytes?: number;
    maxPendingAge?: number;
    logger?: Logger;
  }) {
    this.maxOperations = options.maxOperations ?? DEFAULT_MAX_OPERATIONS;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.maxOperationBytes =
      options.maxOperationBytes ?? DEFAULT_MAX_OPERATION_BYTES;
    this.maxPendingAge = options.maxPendingAge;
    this.logger = options.logger;
  }

  /** Total pending operation count. */
  get size(): number {
    return this.operations.size;
  }

  /** Estimated total buffered payload bytes. */
  get estimatedPayloadBytes(): number {
    return this.estimatedBytes;
  }

  /** Total overflow (capacity rejection) events. */
  get overflowCount(): number {
    return this.overflowEvents;
  }

  /** Oldest pending operation age in milliseconds, or undefined when empty. */
  get oldestPendingAgeMs(): number | undefined {
    let oldest: number | undefined;
    for (const op of this.operations.values()) {
      const age = Date.now() - op.createdAt;
      if (oldest === undefined || age > oldest) {
        oldest = age;
      }
    }
    return oldest;
  }

  /** Whether the store has any pending operations. */
  get isEmpty(): boolean {
    return this.operations.size === 0;
  }

  /**
   * Look up an operation by id.
   */
  get(id: string): QueuedOperation | undefined {
    return this.operations.get(id);
  }

  /**
   * All pending operations in insertion order.
   */
  list(): QueuedOperation[] {
    return Array.from(this.operations.values());
  }

  /**
   * Pending operations for a specific key, in insertion order.
   */
  listForKey(key: string): QueuedOperation[] {
    const ids = this.byKey.get(key);
    if (!ids) {
      return [];
    }
    const result: QueuedOperation[] = [];
    for (const id of ids) {
      const op = this.operations.get(id);
      if (op) {
        result.push(op);
      }
    }
    return result;
  }

  /**
   * Admit a new operation into the store. Returns undefined when the operation
   * cannot be admitted due to capacity limits; the caller applies the overflow
   * policy.
   */
  admit(operation: ResilienceOperation): QueuedOperation | undefined {
    const sizeBytes = estimateSize(operation);

    if (sizeBytes > this.maxOperationBytes) {
      this.logger?.warn(
        "redis resilience: operation exceeds max size, rejecting",
        { operationId: operation.id, key: operation.key, sizeBytes },
      );
      return undefined;
    }

    // Would admitting this operation exceed capacity?
    const wouldExceedCount = this.operations.size + 1 > this.maxOperations;
    const wouldExceedBytes =
      this.estimatedBytes + sizeBytes > this.maxPayloadBytes;

    if (wouldExceedCount || wouldExceedBytes) {
      this.overflowEvents += 1;
      this.logger?.warn("redis resilience: fallback queue at capacity", {
        pending: this.operations.size,
        estimatedBytes: this.estimatedBytes,
        operationId: operation.id,
        key: operation.key,
      });
      return undefined;
    }

    const now = Date.now();
    let expiresAt =
      operation.expiresAt !== undefined
        ? operation.expiresAt
        : operation.ttlSeconds !== undefined
          ? now + operation.ttlSeconds * 1000
          : undefined;
    if (expiresAt === undefined && this.maxPendingAge !== undefined) {
      expiresAt = now + this.maxPendingAge;
    }
    if (expiresAt === undefined) {
      expiresAt = now + Number.MAX_SAFE_INTEGER;
    }

    const queued: QueuedOperation = {
      ...operation,
      state: "QUEUED",
      createdAt: now,
      acceptedAt: now,
      expiresAt,
      retries: 0,
      sequence: this.sequence += 1,
      sizeBytes,
    };

    this.operations.set(operation.id, queued);

    let keyIds = this.byKey.get(operation.key);
    if (!keyIds) {
      keyIds = [];
      this.byKey.set(operation.key, keyIds);
    }
    keyIds.push(operation.id);

    this.estimatedBytes += sizeBytes;

    return queued;
  }

  /**
   * Transition an operation to a new state and record the outcome. Returns the
   * previous record, or undefined if not found.
   */
  transition(
    id: string,
    state: OperationState,
    outcome: OperationOutcome,
    updates?: {
      error?: unknown;
      retries?: number;
    },
  ): QueuedOperation | undefined {
    const op = this.operations.get(id);
    if (!op) {
      return undefined;
    }

    const previous = { ...op };
    op.state = state;

    if (updates?.retries !== undefined) {
      op.retries = updates.retries;
    }
    if (updates?.error !== undefined) {
      op.lastError = updates.error;
      op.lastClassification = this.classifyError(updates.error);
    }

    // Terminal states release the operation from the store.
    if (
      state === "PERSISTED" ||
      state === "EXPIRED" ||
      state === "FAILED" ||
      state === "AMBIGUOUS" ||
      state === "REJECTED" ||
      state === "CANCELLED"
    ) {
      this.release(id);
    }

    return previous;
  }

  /**
   * Mark an operation as currently being replayed, so concurrent recovery
   * workers do not pick it up.
   */
  startReplay(id: string): boolean {
    const op = this.operations.get(id);
    if (!op || op.state !== "QUEUED") {
      return false;
    }
    op.state = "REPLAYING";
    return true;
  }

  /**
   * Remove all operations from the store and release memory accounting.
   */
  clear(): void {
    for (const id of this.operations.keys()) {
      this.release(id);
    }
  }

  /**
   * Remove an operation from the store and release memory accounting.
   */
  private release(id: string): void {
    const op = this.operations.get(id);
    if (!op) {
      return;
    }

    this.operations.delete(id);

    const keyIds = this.byKey.get(op.key);
    if (keyIds) {
      const index = keyIds.indexOf(id);
      if (index !== -1) {
        keyIds.splice(index, 1);
      }
      if (keyIds.length === 0) {
        this.byKey.delete(op.key);
      }
    }

    this.estimatedBytes -= op.sizeBytes;
    if (this.estimatedBytes < 0) {
      this.estimatedBytes = 0;
    }
  }

  /**
   * Expire all operations whose absolute deadline has passed. Returns the ids
   * of expired operations.
   */
  expireStale(now: number = Date.now()): string[] {
    const expired: string[] = [];
    for (const [id, op] of this.operations) {
      if (op.expiresAt <= now && op.state !== "REPLAYING") {
        expired.push(id);
      }
    }
    return expired;
  }

  /**
   * Select up to `limit` operations eligible for recovery, in insertion order,
   * skipping anything already replaying or expired.
   */
  selectEligible(
    limit: number,
    now: number = Date.now(),
  ): QueuedOperation[] {
    const eligible: QueuedOperation[] = [];
    for (const op of this.operations.values()) {
      if (eligible.length >= limit) {
        break;
      }
      if (op.state !== "QUEUED") {
        continue;
      }
      if (op.expiresAt <= now) {
        continue;
      }
      eligible.push(op);
    }
    return eligible;
  }

  /**
   * Deduplication: check whether an operation id has already been processed in
   * a prior recovery cycle. The engine is responsible for recording processed
   * ids; this helper exposes the lookup.
   */
  isProcessed(id: string): boolean {
    return this.operations.has(id);
  }

  private classifyError(error: unknown): FailureClassification {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : undefined;

    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket disconnected/i.test(message)
    ) {
      return "connection";
    }

    if (/WRONGPASS|NOAUTH/i.test(message)) {
      return "auth";
    }

    if (/READONLY|WRONGTYPE|ERR /i.test(message)) {
      return "command";
    }

    return "unknown";
  }
}
