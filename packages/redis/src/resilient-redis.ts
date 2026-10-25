import { type Redis } from "ioredis";
import { normalizeLogger, type Logger } from "./logger.js";
import { createResilienceEngine } from "./resilience/index.js";
import type { ResilienceEngine } from "./resilience/index.js";
import type {
  ResilienceEngineOptions,
  ResilienceEventHandler,
  ResilienceMetrics,
  ResilienceOperation,
  ConnectionState,
} from "./resilience/types.js";
import { shutdown as shutdownClient } from "./client/shutdown.js";
import { classifyError } from "./client/events.js";
import { createJobAtLeastOnce, type JobAtLeastOnce, type JobAtLeastOnceOptions } from "./jobs/at-least-once.js";

const SUPPORTED_COMMANDS = new Set<string>([
  "get",
  "set",
  "setex",
  "setnx",
  "del",
  "expire",
  "ttl",
  "exists",
  "sadd",
  "smembers",
  "srem",
  "hset",
  "hget",
  "hdel",
  "incr",
  "incrby",
  "decr",
  "decrby",
  "getset",
]);

export interface ResilientRedisFallbackOptions {
  enabled?: boolean;
  strategy?: "memory" | "none";
  maxOperations?: number;
  maxPayloadBytes?: number;
  maxOperationBytes?: number;
  maxEntries?: number;
  maxEntryBytes?: number;
  maxBufferSize?: number;
  maxPendingOperations?: number;
  maxPendingAge?: number;
  onLimitExceeded?: "reject";
}

export interface ResilientRedisRecoveryOptions {
  enabled?: boolean;
  autoRecover?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  recoveryBatchSize?: number;
  recoveryConcurrency?: number;
  dedupeOnRecovery?: boolean;
  conflictPolicy?: ResilienceEngineOptions["conflictPolicy"];
}

export interface ResilientRedisOptions extends Partial<ResilienceEngineOptions> {
  fallback?: ResilientRedisFallbackOptions;
  recovery?: ResilientRedisRecoveryOptions;
  jobAtLeastOnce?: JobAtLeastOnceOptions;
  /** Whether this factory owns the supplied client and may close it on shutdown. */
  ownsClient?: boolean;
  /** Alias for ownsClient. */
  shutdownClient?: boolean;
  logger?: Logger;
}

export interface ResilientRedisFacade {
  readonly redis: Redis;
  readonly engine: ResilienceEngine;
  readonly state: ConnectionState;
  readonly isDegraded: boolean;
  metrics(): ResilienceMetrics;
  readonly jobAtLeastOnce: JobAtLeastOnce;
  on(handler: ResilienceEventHandler): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(handler: ResilienceEventHandler): void;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  recover(): Promise<number>;
  shutdown(): Promise<void>;
  quit(...args: unknown[]): Promise<unknown>;
}

let operationCounter = 0;

function toEngineOptions(options: ResilientRedisOptions): ResilienceEngineOptions {
  const fallback = options.fallback ?? {};
  const recovery = options.recovery ?? {};
  const strategy = fallback.strategy ?? "memory";
  const enabled =
    (fallback.enabled ?? options.enabled ?? true) && strategy !== "none";
  const autoRecover = recovery.enabled ?? recovery.autoRecover ?? options.autoRecover ?? true;

  const result: ResilienceEngineOptions = {
    enabled,
    autoRecover,
  };

  const maxOperations = fallback.maxPendingOperations ?? fallback.maxOperations ?? options.maxPendingOperations ?? options.maxOperations;
  if (maxOperations !== undefined) result.maxOperations = maxOperations;
  const maxPayloadBytes = fallback.maxBufferSize ?? fallback.maxPayloadBytes ?? options.maxBufferSize ?? options.maxPayloadBytes;
  if (maxPayloadBytes !== undefined) result.maxPayloadBytes = maxPayloadBytes;
  const maxOperationBytes = fallback.maxOperationBytes ?? options.maxOperationBytes;
  if (maxOperationBytes !== undefined) result.maxOperationBytes = maxOperationBytes;
  const maxPendingAge = fallback.maxPendingAge ?? options.maxPendingAge;
  if (maxPendingAge !== undefined) result.maxPendingAge = maxPendingAge;
  const maxRetries = recovery.maxRetries ?? options.maxRetries;
  if (maxRetries !== undefined) result.maxRetries = maxRetries;
  const baseDelayMs = recovery.baseDelayMs ?? options.baseDelayMs;
  if (baseDelayMs !== undefined) result.baseDelayMs = baseDelayMs;
  const maxDelayMs = recovery.maxDelayMs ?? options.maxDelayMs;
  if (maxDelayMs !== undefined) result.maxDelayMs = maxDelayMs;
  const jitter = recovery.jitter ?? options.jitter;
  if (jitter !== undefined) result.jitter = jitter;
  const recoveryBatchSize = recovery.recoveryBatchSize ?? options.recoveryBatchSize;
  if (recoveryBatchSize !== undefined) result.recoveryBatchSize = recoveryBatchSize;
  const recoveryConcurrency = recovery.recoveryConcurrency ?? options.recoveryConcurrency;
  if (recoveryConcurrency !== undefined) result.recoveryConcurrency = recoveryConcurrency;
  const dedupeOnRecovery = recovery.dedupeOnRecovery ?? options.dedupeOnRecovery;
  if (dedupeOnRecovery !== undefined) result.dedupeOnRecovery = dedupeOnRecovery;
  const conflictPolicy = recovery.conflictPolicy ?? options.conflictPolicy;
  if (conflictPolicy !== undefined) result.conflictPolicy = conflictPolicy;
  const logger = options.logger ?? options.logger;
  if (logger !== undefined) result.logger = normalizeLogger(logger);
  if (fallback.maxEntries !== undefined) {
    result.maxOperations = result.maxOperations ?? fallback.maxEntries;
  }
  if (fallback.maxEntryBytes !== undefined) {
    result.maxOperationBytes = result.maxOperationBytes ?? fallback.maxEntryBytes;
  }
  // Also allow engine-level properties from options passthrough.
  if (options.overflow !== undefined) result.overflow = options.overflow;
  if (fallback.onLimitExceeded !== undefined) result.onLimitExceeded = fallback.onLimitExceeded;
  if (options.onLimitExceeded !== undefined) result.onLimitExceeded = options.onLimitExceeded;

  return result;
}

function nextOperationId(command: string): string {
  operationCounter += 1;
  return `resilient:${command}:${operationCounter}`;
}

function makeOperation(command: string, args: unknown[]): ResilienceOperation {
  const key = String(args[0]);
  const rest = args.slice(1);
  const op: ResilienceOperation = {
    id: nextOperationId(command),
    command: command as ResilienceOperation["command"],
    key,
    args: rest,
  };

  if (command === "set") {
    const exIndex = rest.findIndex(
      (arg) => typeof arg === "string" && arg.toUpperCase() === "EX",
    );
    if (exIndex !== -1 && exIndex + 1 < rest.length) {
      const seconds = Number(rest[exIndex + 1]);
      if (Number.isFinite(seconds) && seconds > 0) {
        op.ttlSeconds = seconds;
      }
    }
    const pxIndex = rest.findIndex(
      (arg) => typeof arg === "string" && arg.toUpperCase() === "PX",
    );
    if (pxIndex !== -1 && pxIndex + 1 < rest.length) {
      const ms = Number(rest[pxIndex + 1]);
      if (Number.isFinite(ms) && ms > 0) {
        op.ttlSeconds = Math.ceil(ms / 1000);
      }
    }
  }

  if (command === "setex") {
    const seconds = Number(rest[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      op.ttlSeconds = seconds;
    }
  }

  return op;
}

function transformEngineResult(
  res: Awaited<ReturnType<ResilienceEngine["execute"]>>,
): unknown {
  if (res.outcome === "EXECUTED" || res.outcome === "BUFFERED") {
    return res.value;
  }
  throw new Error(res.reason ?? `Redis operation ${res.outcome}`);
}

export function createResilientRedis<C extends Redis = Redis>(
  client: C,
  options: ResilientRedisOptions = {},
): C & ResilientRedisFacade {
  const logger = normalizeLogger(options.logger);
  const engineOptions = toEngineOptions(options);
  const engine = createResilienceEngine(client as unknown as Redis, engineOptions);

  const jobFeature = createJobAtLeastOnce({
    ...options.jobAtLeastOnce,
    connection: client as unknown as Redis,
    ownsConnection: false,
    logger: options.logger,
  });

  const ownsClient = Boolean(options.ownsClient || options.shutdownClient);

  async function runSupportedCommand(command: string, args: unknown[]): Promise<unknown> {
    const op = makeOperation(command, args);

    if (engine.state === "connected" && !engine.isDegraded) {
      try {
        const raw = (client as unknown as Record<string, (...a: unknown[]) => unknown>)[command](
          ...args,
        );
        return await Promise.resolve(raw);
      } catch (error) {
        const classified = classifyError(error);
        if (classified.kind === "connection" || classified.kind === "timeout") {
          engine.markDegraded(classified.code ?? classified.kind);
        } else {
          throw error;
        }
      }
    }

    if (!SUPPORTED_COMMANDS.has(command)) {
      if (engine.state !== "connected") {
        throw new Error(`Redis unavailable and command "${command}" is not supported during an outage`);
      }
      const raw = (client as unknown as Record<string, (...a: unknown[]) => unknown>)[command](
        ...args,
      );
      return await Promise.resolve(raw);
    }

    const result = await engine.execute(op);
    return transformEngineResult(result);
  }

  const facadeState = {
    get redis() {
      return client as unknown as Redis;
    },
    get client() {
      return client as unknown as Redis;
    },
    get jobAtLeastOnce() {
      return jobFeature;
    },
    get engine() {
      return engine;
    },
    get state() {
      return engine.state;
    },
    get isDegraded() {
      return engine.isDegraded;
    },
    metrics() {
      return engine.metrics();
    },
    on(...args: unknown[]) {
      const handler = args[0];
      if (args.length === 1 && typeof handler === "function") {
        engine.on(handler as ResilienceEventHandler);
        return;
      }
      (client as unknown as { on: (...a: unknown[]) => unknown }).on(...args);
    },
    off(...args: unknown[]) {
      const handler = args[0];
      if (args.length === 1 && typeof handler === "function") {
        engine.off(handler as ResilienceEventHandler);
        return;
      }
      (client as unknown as { off: (...a: unknown[]) => unknown }).off(...args);
    },
    recover() {
      return engine.recover();
    },
    async shutdown() {
      await engine.shutdown();
      if (ownsClient) {
        try {
          await shutdownClient(client as unknown as Redis);
        } catch {
          // client may already be closed
        }
      }
    },
    async close() {
      return facadeState.shutdown();
    },
    async quit(...args: unknown[]) {
      await facadeState.shutdown();
      return (client as unknown as { quit: (...a: unknown[]) => unknown }).quit(...args);
    },
  };

  const proxy = new Proxy(client as unknown as Redis, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }
      const key = String(prop);
      if (Object.prototype.hasOwnProperty.call(facadeState, key)) {
        const value = (facadeState as Record<string, unknown>)[key];
        return typeof value === "function" ? value.bind(facadeState) : value;
      }
      if (SUPPORTED_COMMANDS.has(key)) {
        return (...args: unknown[]) => runSupportedCommand(key, args);
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });

  void logger;
  return proxy as unknown as C & ResilientRedisFacade;
}

export type ResilientRedis = ResilientRedisFacade;
