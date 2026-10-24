import { Redis } from "ioredis";
import { attachEvents, attachErrorHandling, type ErrorHandlingOptions } from "./events.js";
import { normalizeLogger, type Logger } from "../logger.js";

export interface SentinelConnection {
  host: string;
  port: number;
}

export interface SentinelClientConfig extends Record<string, unknown> {
  sentinels: SentinelConnection[];
  name: string;
  password?: string;
  sentinelPassword?: string;
  lazyConnect?: boolean;
  maxRetriesPerRequest?: number | null;
  errorHandling?: ErrorHandlingOptions;
}

/**
 * Creates a native ioredis client configured for Redis Sentinel.
 *
 * Sentinel monitoring is pass-through at the ioredis level; this wrapper only
 * applies the same safe defaults documented for the standalone client.
 */
export function createSentinelClient(
  config: SentinelClientConfig,
  logger?: Logger,
): Redis {
  if (!Array.isArray(config.sentinels) || config.sentinels.length === 0) {
    throw new Error("At least one Sentinel connection is required");
  }

  if (typeof config.name !== "string" || config.name.trim() === "") {
    throw new Error("A Sentinel master name is required");
  }

  const {
    sentinels,
    name,
    password,
    sentinelPassword,
    lazyConnect = true,
    maxRetriesPerRequest = null,
    errorHandling,
    ...rest
  } = config;

  const client = new Redis({
    sentinels,
    name,
    ...(password !== undefined ? { password } : {}),
    ...(sentinelPassword !== undefined ? { sentinelPassword } : {}),
    lazyConnect,
    maxRetriesPerRequest,
    ...rest,
  });

  attachEvents(client, normalizeLogger(logger));

  if (errorHandling?.enabled) {
    attachErrorHandling(client, { ...errorHandling, logger: errorHandling.logger ?? logger });
  }

  return client;
}
