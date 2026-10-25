import { type Redis as RedisClient } from "ioredis";
import { normalizeLogger, type Logger } from "../logger.js";
import { classifyError, redactError } from "../client/events.js";
import {
  type ConnectionState,
  type FailureClassification,
  type LocalEntry,
  type ResilienceCommand,
  type ResilienceEngineOptions,
  type ResilienceEventHandler,
  type ResilienceMetrics,
  type ResilienceOperation,
  type ResilienceResult,
} from "./types.js";
import { ConnectionManager } from "./connection-manager.js";
import { ExpirationManager } from "./expiration-manager.js";
import { LocalStore } from "./local-store.js";
import { OperationStore } from "./operation-store.js";
import { RecoveryCoordinator } from "./recovery-coordinator.js";
import { ResilienceEventEmitter } from "./events.js";
import { classifyOperation, validateOperation } from "./policy.js";

const DEFAULT_MAX_OPERATIONS = 10000;
const DEFAULT_MAX_PAYLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_OPERATION_BYTES = 1024 * 1024;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 1;

/** Commands that read data and can be served from local state during outage. */
const READ_COMMANDS = new Set<ResilienceCommand>([
  "get",
  "exists",
  "ttl",
  "hget",
  "smembers",
]);

/** Commands that mutate data and can be applied locally during outage. */
const WRITE_COMMANDS = new Set<ResilienceCommand>([
  "set",
  "setex",
  "setnx",
  "del",
  "expire",
  "sadd",
  "srem",
  "hset",
  "hdel",
  "getset",
  "incr",
  "incrby",
  "decr",
  "decrby",
]);

/**
 * Result of executing an operation through the engine, including whether it
 * was executed directly, buffered locally, rejected, or expired.
 */
export type ExecuteResult<T = unknown> = ResilienceResult<T>;

/**
 * The Redis Resilience Engine buffers eligible operations in bounded server
 * memory during Redis outages and reconciles them when connectivity is
 * restored.
 *
 * During an outage, eligible reads are served from local memory and eligible
 * writes are applied locally and journaled for later reconciliation. The
 * native ioredis client remains available for direct use where fallback is
 * not desired.
 */
export interface ResilienceEngine {
  /** The wrapped native ioredis client. */
  readonly redis: RedisClient;
  /** Current connection state. */
  readonly state: ConnectionState;
  /** Whether the engine is in degraded mode. */
  readonly isDegraded: boolean;
  /** Operation store (pending journal) for inspection. */
  readonly store: OperationStore;
  /** Local degraded-mode data store for inspection. */
  readonly localStore: LocalStore;

  /**
   * Mark the connection degraded (internal/outage hint). Exposed for adapters
   * that detect an outage on a direct command failure.
   */
  markDegraded(reason?: string): void;

  /**
   * Execute a Redis operation through the resilience policy. When Redis is
   * healthy, the command runs directly. When Redis is unavailable, eligible
   * reads are served from local state and eligible writes are applied locally
   * and buffered for later reconciliation.
   */
  execute<T>(operation: ResilienceOperation): Promise<ExecuteResult<T>>;

  /**
   * Register a lifecycle event handler.
   */
  on(handler: ResilienceEventHandler): void;

  /**
   * Remove a lifecycle event handler.
   */
  off(handler: ResilienceEventHandler): void;

  /** Current aggregate metrics. */
  metrics(): ResilienceMetrics;

  /**
   * Trigger a manual recovery cycle. Normally recovery starts automatically
   * when Redis reconnects; this is useful for tests and explicit reconciliation.
   */
  recover(): Promise<number>;

  /** Stop the engine, halt recovery, and release resources. */
  shutdown(): Promise<void>;
}

/**
 * Create a resilience engine wrapping an existing ioredis client. The client
 * must already be constructed (e.g. via `createClient`); the engine does not
 * take ownership of it and will not close it on shutdown.
 */
export function createResilienceEngine(
  client: RedisClient,
  options: ResilienceEngineOptions = {},
): ResilienceEngine {
  if (options.enabled === false) {
    // Disabled engine: pass-through to Redis, no buffering.
    return createPassThroughEngine(client, options.logger);
  }

  const logger = normalizeLogger(options.logger);
  const autoRecover = options.autoRecover ?? true;

  // Configuration honesty: only the documented "reject" behaviour is implemented.
  if (options.overflow !== undefined && options.overflow !== "reject") {
    throw new Error('Unsupported overflow policy; only "reject" is supported');
  }
  if (options.onLimitExceeded !== undefined && options.onLimitExceeded !== "reject") {
    throw new Error('Unsupported onLimitExceeded policy; only "reject" is supported');
  }
  const emitter = new ResilienceEventEmitter();
  const connection = new ConnectionManager(client, { logger, emitter });
  const expiration = new ExpirationManager();
  const resolvedMaxOperations =
    options.maxPendingOperations ?? options.maxOperations ?? DEFAULT_MAX_OPERATIONS;
  const resolvedMaxPayloadBytes =
    options.maxBufferSize ?? options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const store = new OperationStore({
    maxOperations: resolvedMaxOperations,
    maxPayloadBytes: resolvedMaxPayloadBytes,
    maxOperationBytes: options.maxOperationBytes ?? DEFAULT_MAX_OPERATION_BYTES,
    maxPendingAge: options.maxPendingAge,
    logger,
  });
  const localStore = new LocalStore({
    maxEntries: resolvedMaxOperations,
    maxPayloadBytes: resolvedMaxPayloadBytes,
    maxEntryBytes: options.maxOperationBytes ?? DEFAULT_MAX_OPERATION_BYTES,
    logger,
  });
  const recovery = new RecoveryCoordinator({
    client,
    store,
    expiration,
    emitter,
    logger,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    batchSize: options.recoveryBatchSize ?? DEFAULT_BATCH_SIZE,
    concurrency: options.recoveryConcurrency ?? DEFAULT_CONCURRENCY,
    dedupeOnRecovery: options.dedupeOnRecovery,
    conflictPolicy: options.conflictPolicy,
  });

  connection.attach();

  // Counters for observable metrics.
  let operationsBuffered = 0;
  let operationsRejected = 0;
  let operationsPersisted = 0;
  let operationsExpired = 0;
  let operationsFailed = 0;
  let operationsAmbiguous = 0;
  const retryAttempts = 0;
  const retryExhausted = 0;
  let recoveryCycles = 0;
  let recoveryDurationMs = 0;
  let conflictsDetected = 0;

  let outageStartMs: number | undefined;

  // Auto-start recovery when the connection manager signals reconnected.
  if (autoRecover !== false) {
    emitter.on((event) => {
      if (event.type === "redis.reconnected") {
        void runRecovery();
      }
      if (event.type === "redis.degraded") {
        outageStartMs = event.timestamp;
      }
      if (event.type === "redis.recovery.completed") {
        outageStartMs = undefined;
      }
      // Update outcome counters from recovery events.
      if (event.type === "redis.operation.persisted") {
        operationsPersisted += 1;
      }
      if (event.type === "redis.operation.expired") {
        operationsExpired += 1;
      }
      if (event.type === "redis.operation.failed") {
        operationsFailed += 1;
      }
      if (event.type === "redis.operation.ambiguous") {
        operationsAmbiguous += 1;
      }
      if (event.type === "redis.recovery.conflict") {
        conflictsDetected += 1;
      }
    });
  } else {
    // Still track degraded markers without auto recovery.
    emitter.on((event) => {
      if (event.type === "redis.degraded") {
        outageStartMs = event.timestamp;
      }
      if (event.type === "redis.recovery.completed") {
        outageStartMs = undefined;
      }
      if (event.type === "redis.operation.persisted") {
        operationsPersisted += 1;
      }
      if (event.type === "redis.operation.expired") {
        operationsExpired += 1;
      }
      if (event.type === "redis.operation.failed") {
        operationsFailed += 1;
      }
      if (event.type === "redis.operation.ambiguous") {
        operationsAmbiguous += 1;
      }
      if (event.type === "redis.recovery.conflict") {
        conflictsDetected += 1;
      }
    });
  }

  let activeRecovery: Promise<number> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  const runRecovery = (): Promise<number> => {
    if (activeRecovery) {
      return activeRecovery;
    }
    activeRecovery = (async (): Promise<number> => {
      connection.beginRecovery();
      recoveryCycles += 1;
      const started = Date.now();
      try {
        const result = await recovery.recover();
        recoveryDurationMs += Date.now() - started;
        conflictsDetected += recovery.conflictsDetected;
        return result;
      } finally {
        connection.endRecovery();
        activeRecovery = null;
      }
    })();
    return activeRecovery;
  };

  /**
   * Buffer an operation into the in-memory journal and return a BUFFERED
   * result. Also applies the mutation to the local store for read-your-writes.
   */
  const bufferOperation = <T>(
    operation: ResilienceOperation,
    lastError: unknown,
    classification: FailureClassification | undefined,
    applyLocal: boolean = false,
  ): ExecuteResult<T> => {
    let localEntry: LocalEntry<T> | undefined;

    if (applyLocal) {
      try {
        localEntry = applyWriteToLocal(operation, localStore as LocalStore<T>, Date.now());
      } catch (error) {
        // Local store rejected (capacity/size). Do not buffer either.
        operationsRejected += 1;
        emitter.emit({
          type: "redis.fallback.capacity_exceeded",
          timestamp: Date.now(),
          operationId: operation.id,
          command: operation.command,
          key: operation.key,
          reason:
            error instanceof Error ? error.message : "local store rejected write",
        });
        return {
          outcome: "REJECTED",
          value: null,
          operationId: operation.id,
          state: "REJECTED",
          error:
            error instanceof Error ? (redactError(error) as Error) : undefined,
          classification,
          reason:
            error instanceof Error ? error.message : "local store rejected write",
        } as ExecuteResult<T>;
      }
    }

    const admitted = store.admit(operation);
    if (!admitted) {
      // Roll back the local write only if it is still the entry created by
      // this operation. This avoids clobbering a newer concurrent mutation.
      if (localEntry) {
        const current = localStore.get(operation.key);
        if (current?.operationId === operation.id) {
          localStore.remove(operation.key);
        }
      }
      operationsRejected += 1;
      emitter.emit({
        type: "redis.fallback.capacity_exceeded",
        timestamp: Date.now(),
        operationId: operation.id,
        command: operation.command,
        key: operation.key,
        reason: "fallback queue at capacity",
      });
      return {
        outcome: "REJECTED",
        value: null,
        operationId: operation.id,
        state: "REJECTED",
        error: lastError instanceof Error ? (redactError(lastError) as Error) : undefined,
        classification,
        reason: "fallback queue at capacity",
      };
    }

    operationsBuffered += 1;
    emitter.emit({
      type: "redis.operation.buffered",
      timestamp: Date.now(),
      operationId: operation.id,
      command: operation.command,
      key: operation.key,
      state: "QUEUED",
      outcome: "BUFFERED",
      classification,
      error: lastError instanceof Error ? (redactError(lastError) as Error)?.message : undefined,
    });

    if (localEntry) {
      emitter.emit({
        type: "redis.local.write",
        timestamp: Date.now(),
        operationId: operation.id,
        command: operation.command,
        key: operation.key,
        outcome: "BUFFERED",
      });
    }

    return {
      outcome: "BUFFERED",
      value: null,
      operationId: operation.id,
      state: "QUEUED",
      bufferedAt: Date.now(),
      reason: "Redis unavailable; operation applied locally and buffered for later recovery",
    } as ExecuteResult<T>;
  };

  /**
   * Serve a read command from the local store during degraded mode.
   */
  function serveLocalRead<T>(
    operation: ResilienceOperation,
    now: number,
  ): ExecuteResult<T> | null {
    if (!READ_COMMANDS.has(operation.command)) {
      return null;
    }

    const localRead = localStore.read(operation.key, now);

    switch (localRead.result) {
      case "HIT": {
        // Transform the raw stored value into the command-specific result.
        let resultValue: unknown = localRead.value;
        if (operation.command === "exists") {
          resultValue = 1;
        } else if (operation.command === "ttl") {
          resultValue =
            localRead.remainingTtlSeconds !== undefined
              ? localRead.remainingTtlSeconds
              : -1;
        } else if (operation.command === "hget") {
          const field = String(operation.args[0] ?? "");
          const hash = localRead.value as Record<string, unknown> | null;
          resultValue =
            hash && typeof hash === "object" && !Array.isArray(hash)
              ? hash[field]
              : null;
        } else if (operation.command === "smembers") {
          resultValue = Array.isArray(localRead.value) ? localRead.value : [];
        }

        emitter.emit({
          type: "redis.local.read.hit",
          timestamp: now,
          operationId: operation.id,
          command: operation.command,
          key: operation.key,
          outcome: "EXECUTED",
        });
        return {
          outcome: "EXECUTED",
          value: resultValue as T,
          operationId: operation.id,
          state: "PERSISTED",
          remainingTtlSeconds: localRead.remainingTtlSeconds,
        } as ExecuteResult<T>;
      }

      case "MISS": {
        // Known absence. Command-specific default values.
        let resultValue: unknown = null;
        if (operation.command === "exists") {
          resultValue = 0;
        } else if (operation.command === "ttl") {
          resultValue = -2;
        }

        emitter.emit({
          type: "redis.local.read.miss",
          timestamp: now,
          operationId: operation.id,
          command: operation.command,
          key: operation.key,
          outcome: "EXECUTED",
        });
        return {
          outcome: "EXECUTED",
          value: resultValue as T,
          operationId: operation.id,
          state: "PERSISTED",
        } as ExecuteResult<T>;
      }

      case "UNKNOWN":
        // No local information; cannot answer without Redis.
        emitter.emit({
          type: "redis.local.read.unknown",
          timestamp: now,
          operationId: operation.id,
          command: operation.command,
          key: operation.key,
          outcome: "REJECTED",
        });
        return {
          outcome: "REJECTED",
          value: null,
          operationId: operation.id,
          state: "REJECTED",
          reason: "No local data for key and Redis unavailable",
        } as ExecuteResult<T>;
    }

    return null;
  }

  return {
    get redis() {
      return client;
    },
    get state() {
      return connection.getState();
    },
    get isDegraded() {
      return connection.getState() === "degraded";
    },
    get store() {
      return store;
    },
    get localStore() {
      return localStore;
    },

    markDegraded(reason?: string): void {
      connection.markDegraded(reason ?? "command failure");
    },

    async execute<T>(operation: ResilienceOperation): Promise<ExecuteResult<T>> {
      validateOperation(operation);

      if (connection.getState() === "stopped") {
        throw new Error("Resilience engine has been shut down");
      }

      const policy = classifyOperation(operation);
      const isWrite = WRITE_COMMANDS.has(operation.command);
      const now = Date.now();

      // Route directly when Redis is ready.
      if (connection.isReady() && connection.getState() !== "recovering") {
        try {
          const value = await executeDirect(client, operation);
          return {
            outcome: "EXECUTED",
            value,
            operationId: operation.id,
            state: "PERSISTED",
            remainingTtlSeconds: operation.ttlSeconds,
          } as ExecuteResult<T>;
        } catch (error) {
          const classified = classifyError(error);
          const isConnectionFailure =
            classified.kind === "connection" ||
            classified.kind === "timeout";

          // Only connection-type failures may enter the degraded path. Ordinary
          // Redis command errors are definitive and must be reported to the caller.
          if (!isConnectionFailure) {
            throw error;
          }

          // Mark degraded so subsequent operations evaluate the fallback path.
          connection.markDegraded(classified.code ?? classified.kind);

          // Fall through to degraded handling below.
        }
      }

      // Redis is degraded or recovering.

      // Reads: serve from local store if we have information.
      if (!isWrite && policy.allowed) {
        const localResult = serveLocalRead<T>(operation, now);
        if (localResult) {
          return localResult;
        }
        // Read command not served locally (e.g. hget, smembers without local
        // state). Reject rather than fabricate.
        return {
          outcome: "REJECTED",
          value: null,
          operationId: operation.id,
          state: "REJECTED",
          reason:
            policy.reason ?? "Read not supported from local state during outage",
        } as ExecuteResult<T>;
      }

      // Writes: apply locally and buffer for reconciliation.
      if (isWrite && policy.allowed) {
        return bufferOperation(operation, undefined, undefined, true);
      }

      // Not eligible for fallback.
      return {
        outcome: "REJECTED",
        value: null,
        operationId: operation.id,
        state: "REJECTED",
        reason:
          policy.reason ?? "Redis unavailable and operation not eligible for fallback",
      } as ExecuteResult<T>;
    },

    on(handler: ResilienceEventHandler): void {
      emitter.on(handler);
    },

    off(handler: ResilienceEventHandler): void {
      emitter.off(handler);
    },

    metrics(): ResilienceMetrics {
      const state = connection.getState();
      const localMetrics = localStore.metrics();
      return {
        connectionState: state,
        pendingOperations: store.size,
        estimatedPayloadBytes: store.estimatedPayloadBytes,
        operationsBuffered,
        operationsPersisted,
        operationsExpired,
        operationsRejected,
        operationsFailed,
        operationsAmbiguous,
        retryAttempts,
        retryExhausted,
        overflowEvents: store.overflowCount + localStore.overflowCount,
        recoveryCycles,
        recoveryDurationMs,
        conflictsDetected,
        outageStartMs,
        outageDurationMs:
          outageStartMs !== undefined ? Date.now() - outageStartMs : undefined,
        oldestPendingAgeMs: store.oldestPendingAgeMs,
        localStore: {
          entries: localMetrics.entries,
          estimatedPayloadBytes: localMetrics.estimatedPayloadBytes,
          localReads: localMetrics.localReads,
          localReadHits: localMetrics.localReadHits,
          localReadMisses: localMetrics.localReadMisses,
          localReadUnknown: localMetrics.localReadUnknown,
          localWrites: localMetrics.localWrites,
          localDeletions: localMetrics.localDeletions,
          entriesExpired: localMetrics.entriesExpired,
          entriesRejected: localMetrics.entriesRejected,
          overflowEvents: localMetrics.overflowEvents,
        },
      };
    },

    async recover(): Promise<number> {
      if (connection.getState() === "stopped") {
        return 0;
      }
      return runRecovery();
    },

    async shutdown(): Promise<void> {
      if (shutdownPromise) {
        return shutdownPromise;
      }
      shutdownPromise = (async (): Promise<void> => {
        // Stop accepting new operations.
        connection.stop();
        // Wait for any in-flight recovery to finish before clearing state.
        if (activeRecovery) {
          try {
            await activeRecovery;
          } catch {
            // Ignore recovery errors during shutdown.
          }
        }
        // Report pending operations being discarded rather than silently
        // clearing local state. Pending journal operations and local entries
        // are lost on shutdown; this is documented process-local behavior.
        const pending = store.size;
        const localEntries = localStore.size;
        store.clear();
        localStore.clear();
        if (pending > 0 || localEntries > 0) {
          emitter.emit({
            type: "redis.recovery.completed",
            timestamp: Date.now(),
            reason: `shutdown discarded ${pending} pending operation(s) and ${localEntries} local entry(ies)`,
          });
        }
      })();
      return shutdownPromise;
    },
  };
}

/**
 * Apply a write command to the local store during degraded mode. Returns the
 * resulting local entry, or throws if the local store cannot accept the write.
 */
function applyWriteToLocal<T>(
  operation: ResilienceOperation,
  localStore: LocalStore<T>,
  now: number,
): LocalEntry<T> | undefined {
  const { command, key, args, ttlSeconds } = operation;

  switch (command) {
    case "set": {
      const [value] = args;
      return localStore.write(key, value as T, {
        ttlSeconds,
        operationId: operation.id,
        now,
      });
    }
    case "setex": {
      const [value] = args;
      const secondsArg = args[1];
      const seconds =
        typeof secondsArg === "number" ? secondsArg : Number(secondsArg);
      return localStore.write(key, value as T, {
        ttlSeconds: seconds,
        operationId: operation.id,
        now,
      });
    }
    case "setnx": {
      const [value] = args;
      const existing = localStore.get(key);
      if (existing && existing.state === "valid") {
        // Key already exists locally; setnx is a no-op locally.
        return undefined;
      }
      return localStore.write(key, value as T, {
        ttlSeconds,
        operationId: operation.id,
        now,
      });
    }
    case "del": {
      return localStore.del(key, { operationId: operation.id, now });
    }
    case "expire": {
      const [secondsArg] = args;
      const seconds =
        typeof secondsArg === "number" ? secondsArg : Number(secondsArg);
      const existing = localStore.get(key);
      if (existing && existing.state === "valid") {
        return localStore.write(key, existing.value as T, {
          ttlSeconds: seconds,
          operationId: operation.id,
          now,
        });
      }
      // No existing entry to expire; nothing to do locally.
      return undefined;
    }
    case "sadd": {
      const [member] = args;
      const existing = localStore.get(key);
      let members: unknown[] = [];
      if (existing && existing.state === "valid" && Array.isArray(existing.value)) {
        members = [...existing.value];
      }
      if (!members.includes(member)) {
        members.push(member);
      }
      return localStore.write(key, members as unknown as T, {
        ttlSeconds,
        operationId: operation.id,
        now,
      });
    }
    case "srem": {
      const [member] = args;
      const existing = localStore.get(key);
      if (existing && existing.state === "valid" && Array.isArray(existing.value)) {
        const members = (existing.value as unknown[]).filter((m) => m !== member);
        return localStore.write(key, members as unknown as T, {
          ttlSeconds,
          operationId: operation.id,
          now,
        });
      }
      return undefined;
    }
    case "hset": {
      const [field, value] = args;
      const existing = localStore.get(key);
      let hash: Record<string, unknown> = {};
      if (existing && existing.state === "valid" && typeof existing.value === "object" && !Array.isArray(existing.value)) {
        hash = { ...(existing.value as Record<string, unknown>) };
      }
      hash[String(field)] = value;
      return localStore.write(key, hash as unknown as T, {
        ttlSeconds,
        operationId: operation.id,
        now,
      });
    }
    case "hdel": {
      const [field] = args;
      const existing = localStore.get(key);
      if (existing && existing.state === "valid" && typeof existing.value === "object" && !Array.isArray(existing.value)) {
        const hash = { ...(existing.value as Record<string, unknown>) };
        delete hash[String(field)];
        return localStore.write(key, hash as unknown as T, {
          ttlSeconds,
          operationId: operation.id,
          now,
        });
      }
      return undefined;
    }
    case "getset": {
      const [value] = args;
      const entry = localStore.write(key, value as T, {
        ttlSeconds,
        operationId: operation.id,
        now,
      });
      return entry;
    }
    case "incr": {
      const existing = localStore.get(key);
      let current = 0;
      if (existing && existing.state === "valid") {
        if (typeof existing.value === "number") {
          current = existing.value as number;
        } else if (typeof existing.value === "string") {
          current = parseInt(existing.value as string, 10) || 0;
        }
      }
      return localStore.write(key, (current + 1) as T, {
        ttlSeconds,
        operationId: operation.id,
        now,
      });
    }
    case "incrby": {
      const [amount] = args;
      const inc = typeof amount === "number" ? amount : Number(amount) || 0;
      const existing = localStore.get(key);
      let current = 0;
      if (existing && existing.state === "valid") {
        if (typeof existing.value === "number") {
          current = existing.value as number;
        } else if (typeof existing.value === "string") {
          current = parseInt(existing.value as string, 10) || 0;
        }
      }
      return localStore.write(key, (current + inc) as T, {
        ttlSeconds,
        operationId: operation.id,
        now,
      });
    }
    case "decr": {
      const existing = localStore.get(key);
      let current = 0;
      if (existing && existing.state === "valid") {
        if (typeof existing.value === "number") {
          current = existing.value as number;
        } else if (typeof existing.value === "string") {
          current = parseInt(existing.value as string, 10) || 0;
        }
      }
      return localStore.write(key, (current - 1) as T, {
        ttlSeconds,
        operationId: operation.id,
        now,
      });
    }
    case "decrby": {
      const [amount] = args;
      const inc = typeof amount === "number" ? amount : Number(amount) || 0;
      const existing = localStore.get(key);
      let current = 0;
      if (existing && existing.state === "valid") {
        if (typeof existing.value === "number") {
          current = existing.value as number;
        } else if (typeof existing.value === "string") {
          current = parseInt(existing.value as string, 10) || 0;
        }
      }
      return localStore.write(key, (current - inc) as T, {
        ttlSeconds,
        operationId: operation.id,
        now,
      });
    }
    default:
      return undefined;
  }
}

/**
 * Execute an operation directly against the native client.
 */
async function executeDirect<T>(
  client: RedisClient,
  operation: ResilienceOperation,
): Promise<T> {
  const { command, key, args } = operation;

  switch (command) {
    case "get":
      return (await client.get(key)) as unknown as T;
    case "set": {
      const [value] = args;
      await client.set(key, String(value ?? ""));
      return undefined as unknown as T;
    }
    case "setex": {
      const [value, seconds] = args;
      await client.set(key, String(value ?? ""), "EX", Number(seconds));
      return undefined as unknown as T;
    }
    case "setnx": {
      const [value] = args;
      const result = await client.set(key, String(value ?? ""), "NX");
      return (result === "OK") as unknown as T;
    }
    case "del":
      return (await client.del(key)) as unknown as T;
    case "expire": {
      const [seconds] = args;
      return (await client.expire(key, Number(seconds))) as unknown as T;
    }
    case "ttl":
      return (await client.ttl(key)) as unknown as T;
    case "exists":
      return (await client.exists(key)) as unknown as T;
    case "sadd": {
      const [member] = args;
      return (await client.sadd(key, String(member ?? ""))) as unknown as T;
    }
    case "smembers":
      return (await client.smembers(key)) as unknown as T;
    case "srem": {
      const [member] = args;
      return (await client.srem(key, String(member ?? ""))) as unknown as T;
    }
    case "hset": {
      const [field, value] = args;
      return (await client.hset(key, String(field ?? ""), String(value ?? ""))) as unknown as T;
    }
    case "hget":
      return (await client.hget(key, String(args[0] ?? ""))) as unknown as T;
    case "hdel": {
      const [field] = args;
      return (await client.hdel(key, String(field ?? ""))) as unknown as T;
    }
    case "getset": {
      const [value] = args;
      return (await client.getset(key, String(value ?? ""))) as unknown as T;
    }
    case "incr":
      return (await client.incr(key)) as unknown as T;
    case "incrby": {
      const [amount] = args;
      return (await client.incrby(key, Number(amount))) as unknown as T;
    }
    case "decr":
      return (await client.decr(key)) as unknown as T;
    case "decrby": {
      const [amount] = args;
      return (await client.decrby(key, Number(amount))) as unknown as T;
    }
    default:
      throw new Error(`Unsupported command "${command}"`);
  }
}

function createPassThroughEngine(
  client: RedisClient,
  _logger?: Logger,
): ResilienceEngine {
  const emptyStore = {
    get size() {
      return 0;
    },
    get estimatedPayloadBytes() {
      return 0;
    },
    get overflowCount() {
      return 0;
    },
    get oldestPendingAgeMs() {
      return undefined;
    },
    get isEmpty() {
      return true;
    },
    list() {
      return [];
    },
    listForKey() {
      return [];
    },
    get() {
      return undefined;
    },
    admit() {
      return undefined;
    },
    transition() {
      return undefined;
    },
    startReplay() {
      return false;
    },
    expireStale() {
      return [];
    },
    selectEligible() {
      return [];
    },
  } as unknown as OperationStore;

  const emptyLocalStore = {
    get size() {
      return 0;
    },
    get estimatedPayloadBytes() {
      return 0;
    },
    get isEmpty() {
      return true;
    },
    get overflowCount() {
      return 0;
    },
    read() {
      return { result: "UNKNOWN" as const, value: null };
    },
    write() {
      throw new Error("local store disabled");
    },
    del() {
      throw new Error("local store disabled");
    },
    expireStale() {
      return [];
    },
    get() {
      return undefined;
    },
    list() {
      return [];
    },
    remove() {},
    clear() {},
    metrics() {
      return {
        entries: 0,
        estimatedPayloadBytes: 0,
        localReads: 0,
        localReadHits: 0,
        localReadMisses: 0,
        localReadUnknown: 0,
        localWrites: 0,
        localDeletions: 0,
        entriesExpired: 0,
        entriesRejected: 0,
        overflowEvents: 0,
      };
    },
  } as unknown as LocalStore;

  return {
    get redis() {
      return client;
    },
    get state() {
      return "connected" as ConnectionState;
    },
    get isDegraded() {
      return false;
    },
    get store() {
      return emptyStore;
    },
    get localStore() {
      return emptyLocalStore;
    },
    markDegraded(_reason?: string): void {
      // pass-through engine has no degraded state
    },

    async execute<T>(operation: ResilienceOperation): Promise<ExecuteResult<T>> {
      validateOperation(operation);
      const value = await executeDirect(client, operation);
      return {
        outcome: "EXECUTED",
        value,
        operationId: operation.id,
        state: "PERSISTED",
        remainingTtlSeconds: operation.ttlSeconds,
      } as ExecuteResult<T>;
    },
    on() {},
    off() {},
    metrics(): ResilienceMetrics {
      return {
        connectionState: "connected",
        pendingOperations: 0,
        estimatedPayloadBytes: 0,
        operationsBuffered: 0,
        operationsPersisted: 0,
        operationsExpired: 0,
        operationsRejected: 0,
        operationsFailed: 0,
        operationsAmbiguous: 0,
        retryAttempts: 0,
        retryExhausted: 0,
        overflowEvents: 0,
        recoveryCycles: 0,
        recoveryDurationMs: 0,
        conflictsDetected: 0,
        oldestPendingAgeMs: undefined,
        localStore: {
          entries: 0,
          estimatedPayloadBytes: 0,
          localReads: 0,
          localReadHits: 0,
          localReadMisses: 0,
          localReadUnknown: 0,
          localWrites: 0,
          localDeletions: 0,
          entriesExpired: 0,
          entriesRejected: 0,
          overflowEvents: 0,
        },
      };
    },
    recover(): Promise<number> {
      return Promise.resolve(0);
    },
    async shutdown(): Promise<void> {
      // no-op
    },
  };
}
