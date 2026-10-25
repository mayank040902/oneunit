import { type Redis as RedisClient } from "ioredis";
import { type Logger } from "../logger.js";
import { redactError, classifyError } from "../client/events.js";
import {
  type ConflictPolicy,
  type FailureClassification,
  type OperationOutcome,
  type OperationState,
  type QueuedOperation,
  type ResilienceEvent,
  type ResilienceResult,
} from "./types.js";
import { ExpirationManager } from "./expiration-manager.js";
import { OperationStore } from "./operation-store.js";
import { ResilienceEventEmitter } from "./events.js";
import { isIdempotent } from "./policy.js";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5000;
const DEFAULT_RECOVERY_BATCH_SIZE = 50;
const DEFAULT_RECOVERY_CONCURRENCY = 1;
const DEFAULT_CONFLICT_POLICY: ConflictPolicy = "overwrite";

/**
 * Single-worker recovery coordinator. Processes eligible buffered operations
 * in insertion order when Redis is ready again, preserving per-key ordering
 * and absolute TTL deadlines.
 *
 * Only one coordinator may run at a time within a process instance. A
 * recovery lock (boolean flag) prevents duplicate workers.
 */
export class RecoveryCoordinator {
  private readonly client: RedisClient;
  private readonly logger: Logger | undefined;
  private readonly emitter: ResilienceEventEmitter;
  private readonly store: OperationStore;
  private readonly expiration: ExpirationManager;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly dedupeOnRecovery: boolean;
  private readonly conflictPolicy: ConflictPolicy;

  private running = false;
  private processedIds = new Set<string>();
  private _conflictsDetected = 0;
  private _totalRecoveryDurationMs = 0;

  constructor(options: {
    client: RedisClient;
    store: OperationStore;
    expiration: ExpirationManager;
    emitter: ResilienceEventEmitter;
    logger?: Logger;
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    batchSize?: number;
    concurrency?: number;
    dedupeOnRecovery?: boolean;
    conflictPolicy?: ConflictPolicy;
  }) {
    this.client = options.client;
    this.logger = options.logger;
    this.emitter = options.emitter;
    this.store = options.store;
    this.expiration = options.expiration;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.batchSize = options.batchSize ?? DEFAULT_RECOVERY_BATCH_SIZE;
    this.concurrency = options.concurrency ?? DEFAULT_RECOVERY_CONCURRENCY;
    this.dedupeOnRecovery = options.dedupeOnRecovery ?? true;
    this.conflictPolicy = options.conflictPolicy ?? DEFAULT_CONFLICT_POLICY;
  }

  /**
   * Whether a recovery cycle is currently in progress.
   */
  get isRunning(): boolean {
    return this.running;
  }

  /** Total conflicts detected across all recovery cycles. */
  get conflictsDetected(): number {
    return this._conflictsDetected;
  }

  /** Total time spent in recovery across all cycles, in ms. */
  get totalRecoveryDurationMs(): number {
    return this._totalRecoveryDurationMs;
  }

  /**
   * Run one recovery cycle: drain the backlog of eligible operations.
   * Returns the number of operations processed. Safe to call concurrently -
   * only the first caller actually runs recovery.
   */
  async recover(): Promise<number> {
    if (this.running) {
      this.logger?.debug("redis resilience: recovery already in progress");
      return 0;
    }

    this.running = true;
    const started = Date.now();
    let processed = 0;

    try {
      while (true) {
        const now = Date.now();

        // Expire anything whose deadline passed while Redis was down.
        const expiredIds = this.store.expireStale(now);
        for (const id of expiredIds) {
          const op = this.store.get(id);
          if (op) {
            this.finalize(op, "EXPIRED", "EXPIRED", undefined, undefined, undefined, "operation deadline passed");
            this.emit({
              type: "redis.operation.expired",
              timestamp: now,
              operationId: id,
              command: op.command,
              key: op.key,
              state: "EXPIRED",
              outcome: "EXPIRED",
              reason: "operation deadline passed before recovery",
            });
          }
        }

        const batch = this.store.selectEligible(this.batchSize, now);
        if (batch.length === 0) {
          break;
        }

        // Per-key ordering: group by key so writes to the same key replay in
        // admission order, while unrelated keys recover concurrently.
        const byKey = new Map<string, QueuedOperation[]>();
        for (const op of batch) {
          const group = byKey.get(op.key) ?? [];
          group.push(op);
          byKey.set(op.key, group);
        }

        const results = await Promise.all(
          Array.from(byKey.values()).map((group) =>
            this.replayKeyGroup(group),
          ),
        );

        for (const result of results) {
          processed += result.processed;
        }

        if (batch.length < this.batchSize) {
          break;
        }
      }

      const durationMs = Date.now() - started;
      this._totalRecoveryDurationMs += durationMs;
      this.logger?.info("redis resilience: recovery cycle completed", {
        processed,
        durationMs,
        conflictsDetected: this.conflictsDetected,
      });

      return processed;
    } finally {
      this.running = false;
    }
  }

  /**
   * Replay a group of operations for the same key in admission order.
   */
  private async replayKeyGroup(
    group: QueuedOperation[],
  ): Promise<{ processed: number }> {
    let processed = 0;
    for (const op of group) {
      if (!this.store.startReplay(op.id)) {
        continue; // another worker already took it
      }

      const result = await this.replayOne(op);
      processed += 1;

      this.emitOperationEvent(op, result);
    }

    return { processed };
  }

  /**
   * Replay a single operation against Redis with bounded retries.
   */
  private async replayOne(op: QueuedOperation): Promise<ResilienceResult> {
    const now = Date.now();
    const ttlCheck = this.expiration.ttlForPersistence(op, now);
    if (ttlCheck.expired) {
      return this.finalize(
        op,
        "EXPIRED",
        "EXPIRED",
        undefined,
        undefined,
        undefined,
        "operation deadline passed before execution",
      );
    }

    // Conflict detection: for write commands, check if Redis already has a
    // newer value for the key. If so, apply the configured conflict policy.
    if (this.isWriteCommand(op.command)) {
      const conflict = await this.checkConflict(op);
      if (conflict) {
        this._conflictsDetected += 1;
        switch (this.conflictPolicy) {
          case "reject":
            return this.finalize(
              op,
              "REJECTED",
              "REJECTED",
              undefined,
              undefined,
              undefined,
              "conflict: Redis has a newer value for this key",
            );
          case "abort":
            return this.finalize(
              op,
              "FAILED",
              "FAILED",
              undefined,
              undefined,
              undefined,
              "conflict: recovery aborted due to key conflict",
            );
          case "overwrite":
          default:
            // Proceed with overwrite; last write wins.
            break;
        }
      }
    }

    let lastError: unknown;
    let attempts = 0;

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      attempts = attempt;

      // Dedupe: if this id was already processed in a prior cycle, skip.
      if (this.dedupeOnRecovery && this.processedIds.has(op.id)) {
        return this.finalize(
          op,
          "PERSISTED",
          "EXECUTED",
          undefined,
          undefined,
          undefined,
          "already processed in prior recovery cycle",
        );
      }

      try {
        const value = await this.executeCommand(op, ttlCheck.ttlSeconds);
        this.processedIds.add(op.id);
        return this.finalize(
          op,
          "PERSISTED",
          "EXECUTED",
          undefined,
          undefined,
          value,
        );
      } catch (error) {
        lastError = error;
        const classification = classifyError(error);

        // Non-retryable classification -> permanent failure.
        if (classification.kind === "command" || classification.kind === "auth") {
          return this.finalize(
            op,
            "FAILED",
            "FAILED",
            error,
            classification.kind,
            undefined,
            `permanent failure: ${redactError(error) instanceof Error ? (redactError(error) as Error).message : String(redactError(error))}`,
          );
        }

        // Ambiguous: Redis may have executed. For idempotent commands, retry is
        // safe; for non-idempotent, report AMBIGUOUS rather than double-apply.
        // Note: classifyError maps ECONNREFUSED to "auth", so we also check
        // classification.code === "ECONNREFUSED" to catch connection refusals.
        if (
          classification.kind === "connection" ||
          classification.kind === "timeout" ||
          classification.code === "ECONNREFUSED"
        ) {
          if (!isIdempotent(op.command)) {
            return this.finalize(
              op,
              "AMBIGUOUS",
              "AMBIGUOUS",
              error,
              classification.kind,
              undefined,
              "non-idempotent command outcome ambiguous after connection failure",
            );
          }
        }

        // Retryable: backoff and retry unless this was the last attempt.
        if (attempt < this.maxRetries) {
          const delay = this.backoff(attempt);
          await this.sleep(delay);
          continue;
        }

        // All retries exhausted on a connection/timeout error. Redis may have
        // executed the command before the response was lost. Report AMBIGUOUS
        // rather than FAILED to avoid falsely claiming the operation did not
        // execute.
        if (
          classification.kind === "connection" ||
          classification.kind === "timeout" ||
          classification.code === "ECONNREFUSED"
        ) {
          return this.finalize(
            op,
            "AMBIGUOUS",
            "AMBIGUOUS",
            error,
            classification.kind,
            undefined,
            `retry exhausted after ${attempts} attempts; outcome ambiguous`,
          );
        }

        return this.finalize(
          op,
          "FAILED",
          "FAILED",
          error,
          classification.kind,
          undefined,
          `retry exhausted after ${attempts} attempts`,
        );
      }
    }

    return this.finalize(
      op,
      "FAILED",
      "FAILED",
      lastError,
      "unknown",
      undefined,
      "recovery failed",
    );
  }

  /**
   * Execute the preserved command against Redis with the remaining TTL.
   */
  private async executeCommand(
    op: QueuedOperation,
    ttlSeconds: number,
  ): Promise<unknown> {
    const { command, key, args } = op;

    switch (command) {
      case "set": {
        const [value] = args;
        if (ttlSeconds >= 0) {
          return this.client.set(key, String(value ?? ""), "EX", ttlSeconds);
        }
        return this.client.set(key, String(value ?? ""));
      }
      case "setex": {
        const [value] = args;
        return this.client.set(key, String(value ?? ""), "EX", ttlSeconds);
      }
      case "setnx": {
        const [value] = args;
        const result = await (this.client as unknown as {
          set(key: string, value: string, ...rest: unknown[]): Promise<unknown>;
        }).set(key, String(value ?? ""), "NX", "EX", ttlSeconds);
        return result === "OK";
      }
      case "del": {
        return this.client.del(key);
      }
      case "expire": {
        const [seconds] = args;
        return this.client.expire(key, Number(seconds));
      }
      case "exists": {
        return this.client.exists(key);
      }
      case "sadd": {
        const [member] = args;
        return this.client.sadd(key, String(member ?? ""));
      }
      case "smembers": {
        return this.client.smembers(key);
      }
      case "srem": {
        const [member] = args;
        return this.client.srem(key, String(member ?? ""));
      }
      case "hset": {
        const [field, value] = args;
        return this.client.hset(key, String(field ?? ""), String(value ?? ""));
      }
      case "hget": {
        const [field] = args;
        return this.client.hget(key, String(field ?? ""));
      }
      case "hdel": {
        const [field] = args;
        return this.client.hdel(key, String(field ?? ""));
      }
      case "getset": {
        const [value] = args;
        return this.client.getset(key, String(value ?? ""));
      }
      case "incr":
        return this.client.incr(key);
      case "incrby": {
        const [amount] = args;
        return this.client.incrby(key, Number(amount));
      }
      case "decr":
        return this.client.decr(key);
      case "decrby": {
        const [amount] = args;
        return this.client.decrby(key, Number(amount));
      }
      default: {
        throw new Error(`Unsupported command "${command}" during recovery`);
      }
    }
  }

  /**
   * Finalize an operation: transition state, release from store, record result.
   */
  private finalize(
    op: QueuedOperation,
    state: OperationState,
    outcome: OperationOutcome,
    error: unknown,
    classification: FailureClassification | undefined,
    value?: unknown,
    reason?: string,
  ): ResilienceResult {
    this.store.transition(op.id, state, outcome, {
      error,
      retries: op.retries + 1,
    });

    const result: ResilienceResult = {
      outcome,
      value: value !== undefined ? (value as unknown) : null,
      operationId: op.id,
      state,
      error:
        error instanceof Error
          ? (redactError(error) as Error)
          : error !== undefined
            ? new Error(String(error))
            : undefined,
      classification,
      reason,
    };

    if (state === "PERSISTED") {
      result.recoveredAt = Date.now();
      result.remainingTtlSeconds =
        op.ttlSeconds !== undefined ? this.expiration.remainingTtlSeconds(op) : undefined;
    }

    return result;
  }

  /**
   * Check whether Redis has a newer value for the operation's key, indicating
   * a potential conflict with another writer.
   */
  private async checkConflict(op: QueuedOperation): Promise<boolean> {
    try {
      const current = await this.client.get(op.key);
      if (current !== null) {
        op.redisVersion = (op.redisVersion ?? 0) + 1;
        op.conflicted = true;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Whether a command is a write that could conflict with another writer.
   */
  private isWriteCommand(command: string): boolean {
    const reads = new Set<string>(["get", "exists", "ttl", "hget", "smembers"]);
    return !reads.has(command);
  }

  private emitOperationEvent(op: QueuedOperation, result: ResilienceResult): void {
    const now = Date.now();
    let type: ResilienceEvent["type"];
    switch (result.outcome) {
      case "EXECUTED":
        type = "redis.operation.persisted";
        break;
      case "EXPIRED":
        type = "redis.operation.expired";
        break;
      case "FAILED":
        type = "redis.operation.failed";
        break;
      case "AMBIGUOUS":
        type = "redis.operation.ambiguous";
        break;
      default:
        type = "redis.operation.persisted";
    }

    if (op.conflicted) {
      this.emit({
        type: "redis.recovery.conflict",
        timestamp: now,
        operationId: op.id,
        command: op.command,
        key: op.key,
        state: result.state,
        outcome: result.outcome,
        classification: result.classification,
        error: result.error?.message,
        reason: result.reason,
      });
    }

    this.emit({
      type,
      timestamp: now,
      operationId: op.id,
      command: op.command,
      key: op.key,
      state: result.state,
      outcome: result.outcome,
      classification: result.classification,
      error: result.error?.message,
      reason: result.reason,
    });
  }

  private emit(event: ResilienceEvent): void {
    this.emitter.emit(event);
  }

  private backoff(attempt: number): number {
    let delay = Math.min(
      this.baseDelayMs * 2 ** (attempt - 1),
      this.maxDelayMs,
    );
    delay = Math.floor(delay * (0.5 + Math.random() * 0.5));
    return delay;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
