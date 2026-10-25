import { Redis } from "ioredis";
import { attachEvents, attachErrorHandling } from "./events.js";
import { normalizeLogger, type Logger } from "../logger.js";
import type { RedisOptions } from "ioredis";
import { createResilientRedis, type ResilientRedisOptions } from "../resilient-redis.js";
import type { ResilientRedisFacade } from "../resilient-redis.js";
import { createJobAtLeastOnce, type JobAtLeastOnce, type JobAtLeastOnceOptions } from "../jobs/at-least-once.js";

export interface RedisClientOptions extends RedisOptions {
  url?: string;
  lazyConnect?: boolean;
  errorHandling?: import("./events.js").ErrorHandlingOptions;
  /** Optional embedded resilience configuration. When present, `createClient` returns a resilient client. */
  resilience?: ResilientRedisOptions;
  fallback?: ResilientRedisOptions["fallback"];
  recovery?: ResilientRedisOptions["recovery"];
  ownsClient?: boolean;
  shutdownClient?: boolean;
  maxBufferSize?: number;
  maxPendingOperations?: number;
  maxPendingAge?: number;
  onLimitExceeded?: "reject";
  maxOperations?: number;
  maxPayloadBytes?: number;
  maxOperationBytes?: number;
  enabled?: boolean;
  autoRecover?: boolean;
  overflow?: import("../resilience/types.js").OverflowPolicy;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  recoveryBatchSize?: number;
  recoveryConcurrency?: number;
  dedupeOnRecovery?: boolean;
  conflictPolicy?: import("../resilience/types.js").ConflictPolicy;
  jobAtLeastOnce?: JobAtLeastOnceOptions;
}

export function createClient(
  options: RedisClientOptions & {
    resilience?: ResilientRedisOptions;
    fallback?: ResilientRedisOptions["fallback"];
    recovery?: ResilientRedisOptions["recovery"];
  },
  logger?: Logger,
): Redis & ResilientRedisFacade;
export function createClient(
  options?: RedisClientOptions | string,
  logger?: Logger,
): Redis {

  // ioredis's own constructor accepts `new Redis("redis://host:port")`, so
  // that is the form people reach for first. Destructuring the string as an
  // options object produces no `url`, which leaves the client pointing at
  // localhost:6379: a silent connection to the wrong server, with no error
  // anywhere to notice it by.
  const resolved: RedisClientOptions =
    typeof options === "string" ? { url: options } : (options ?? {});

  const {
    url: explicitUrl,
    lazyConnect = true,
    errorHandling,
    // BullMQ throws unless this is null on the connections it drives, and
    // `createQueue`/`createWorker` take this same client instance.
    maxRetriesPerRequest = null,
    resilience: resilienceOption,
    fallback: fallbackOption,
    recovery: recoveryOption,
    ownsClient: ownsOption,
    shutdownClient: shutdownOption,
    // Direct resilience limit/configuration fields are hoisted so createClient
    // can configure resilience without a nested resilience object.
    maxBufferSize: maxBufferSizeOption,
    maxPendingOperations: maxPendingOperationsOption,
    maxPendingAge: maxPendingAgeOption,
    onLimitExceeded: onLimitExceededOption,
    maxOperations: maxOperationsOption,
    maxPayloadBytes: maxPayloadBytesOption,
    maxOperationBytes: maxOperationBytesOption,
    enabled: enabledOption,
    autoRecover: autoRecoverOption,
    overflow: overflowOption,
    maxRetries: maxRetriesOption,
    baseDelayMs: baseDelayMsOption,
    maxDelayMs: maxDelayMsOption,
    jitter: jitterOption,
    recoveryBatchSize: recoveryBatchSizeOption,
    recoveryConcurrency: recoveryConcurrencyOption,
    dedupeOnRecovery: dedupeOnRecoveryOption,
    conflictPolicy: conflictPolicyOption,
    jobAtLeastOnce: jobAtLeastOnceOption,
    ...restOptions
  } = resolved;

  const url = explicitUrl ?? process.env.REDIS_URL;

  if (typeof url !== "string" || url.trim() === "") {
    throw new Error("No Redis URL provided. Pass a URL or set REDIS_URL.");
  }

  if (restOptions.keyPrefix !== undefined) {
    throw new Error("keyPrefix is incompatible with BullMQ; use BullMQ prefix instead.");
  }


  // ioredis only reads `url` from the first positional argument; an options
  // object carrying `url` is silently ignored and connects to localhost.
  const client = url
    ? new Redis(url, { ...restOptions, lazyConnect, maxRetriesPerRequest })
    : new Redis({ ...restOptions, lazyConnect, maxRetriesPerRequest });

  // A caller-supplied logger may implement only some of the levels. Completing
  // it here keeps `attachEvents` from throwing mid-connection-event.
  attachEvents(client, normalizeLogger(logger));

  if (errorHandling?.enabled) {
    attachErrorHandling(client, { ...errorHandling, logger: errorHandling.logger ?? logger });
  }

  const directResilienceFields = {
    ...(maxBufferSizeOption !== undefined ? { maxBufferSize: maxBufferSizeOption } : {}),
    ...(maxPendingOperationsOption !== undefined ? { maxPendingOperations: maxPendingOperationsOption } : {}),
    ...(maxPendingAgeOption !== undefined ? { maxPendingAge: maxPendingAgeOption } : {}),
    ...(onLimitExceededOption !== undefined ? { onLimitExceeded: onLimitExceededOption } : {}),
    ...(maxOperationsOption !== undefined ? { maxOperations: maxOperationsOption } : {}),
    ...(maxPayloadBytesOption !== undefined ? { maxPayloadBytes: maxPayloadBytesOption } : {}),
    ...(maxOperationBytesOption !== undefined ? { maxOperationBytes: maxOperationBytesOption } : {}),
    ...(enabledOption !== undefined ? { enabled: enabledOption } : {}),
    ...(autoRecoverOption !== undefined ? { autoRecover: autoRecoverOption } : {}),
    ...(overflowOption !== undefined ? { overflow: overflowOption } : {}),
    ...(maxRetriesOption !== undefined ? { maxRetries: maxRetriesOption } : {}),
    ...(baseDelayMsOption !== undefined ? { baseDelayMs: baseDelayMsOption } : {}),
    ...(maxDelayMsOption !== undefined ? { maxDelayMs: maxDelayMsOption } : {}),
    ...(jitterOption !== undefined ? { jitter: jitterOption } : {}),
    ...(recoveryBatchSizeOption !== undefined ? { recoveryBatchSize: recoveryBatchSizeOption } : {}),
    ...(recoveryConcurrencyOption !== undefined ? { recoveryConcurrency: recoveryConcurrencyOption } : {}),
    ...(dedupeOnRecoveryOption !== undefined ? { dedupeOnRecovery: dedupeOnRecoveryOption } : {}),
    ...(conflictPolicyOption !== undefined ? { conflictPolicy: conflictPolicyOption } : {}),
  };

  const hasDirectResilienceConfig = Object.keys(directResilienceFields).length > 0;
  const jobFeature = createJobAtLeastOnce({
    ...jobAtLeastOnceOption,
    connection: client,
    ownsConnection: false,
    logger: jobAtLeastOnceOption?.logger ?? logger,
  });
  (client as unknown as { jobAtLeastOnce?: JobAtLeastOnce }).jobAtLeastOnce = jobFeature;

  const resilienceConfig =
    resilienceOption || fallbackOption || recoveryOption || hasDirectResilienceConfig
      ? {
          ...directResilienceFields,
          ...resilienceOption,
          fallback: {
            ...directResilienceFields,
            ...fallbackOption,
            ...(resilienceOption?.fallback ?? {}),
          },
          recovery: {
            ...recoveryOption,
            ...(resilienceOption?.recovery ?? {}),
          },
        }
      : undefined;

  if (resilienceConfig) {
    const wrapped = createResilientRedis(client, {
      ...resilienceConfig,
      logger: resilienceConfig.logger ?? logger,
      ownsClient: ownsOption ?? true,
      shutdownClient: shutdownOption ?? true,
    });
    return wrapped as unknown as Redis;
  }

  return client;
}

export type { Logger } from "../logger.js";
