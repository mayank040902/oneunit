import { Redis as IORedis } from "ioredis";
import type { SessionStore } from "@oneunit/auth";
import type { Logger } from "../logger.js";
import { createRedisSessionStore } from "./stores.js";
import { createQueue, createWorker, type Queue, type Worker } from "../queue/index.js";
import { normalizeLogger } from "../logger.js";

export interface ScheduledSessionRevocationConfig {
  connection: IORedis;
  redis?: IORedis;
  sessionStore?: SessionStore;
  queueName?: string;
  prefix?: string;
  concurrency?: number;
  logger?: Logger;
  storeOptions?: { keyPrefix?: string; revokedSessionTtlSeconds?: number };
}

export interface ScheduledSessionRevocation {
  queue: Queue;
  worker: Worker;
  schedule(sessionId: string, runAt: number | Date): Promise<string | undefined>;
  close(): Promise<void>;
}

export function createScheduledSessionRevocation(
  config: ScheduledSessionRevocationConfig,
): ScheduledSessionRevocation {
  if (!config || !config.connection) {
    throw new Error("A Redis connection is required");
  }
  if (config.concurrency !== undefined && (!Number.isFinite(config.concurrency) || config.concurrency < 1)) {
    throw new Error("concurrency must be a positive number");
  }

  const redis = config.redis ?? config.connection;
  const sessionStore =
    config.sessionStore ?? createRedisSessionStore(redis, config.storeOptions);

  const queueName = config.queueName ?? "scheduled-session-revocation";
  const logger = normalizeLogger(config.logger);

  let closed = false;
  let queue: Queue | null = null;
  let worker: Worker | null = null;

  function ensureStarted(): { queue: Queue; worker: Worker } {
    if (closed) {
      throw new Error("Scheduled session revocation is closed");
    }
    if (!queue || !worker) {
      queue = createQueue({
        name: queueName,
        connection: config.connection,
        prefix: config.prefix ?? "queue",
      });
      worker = createWorker({
        name: queueName,
        connection: config.connection,
        prefix: config.prefix ?? "queue",
        concurrency: config.concurrency ?? 1,
        processor: async (job) => {
          const sessionId = String((job.data as { sessionId?: unknown })?.sessionId ?? "");
          if (sessionId) {
            await sessionStore.revokeSession?.(sessionId);
          }
          return { revoked: !!sessionId };
        },
      });
    }
    return { queue, worker };
  }

  return {
    get queue() {
      return ensureStarted().queue;
    },
    get worker() {
      return ensureStarted().worker;
    },
    async schedule(sessionId, runAt) {
      if (closed) {
        throw new Error("Scheduled session revocation is closed");
      }

      const sessionIdText = String(sessionId ?? "").trim();
      if (!sessionIdText) {
        throw new Error("sessionId is required");
      }

      const timestamp = runAt instanceof Date ? runAt.getTime() : Number(runAt);
      if (!Number.isFinite(timestamp)) {
        throw new Error("runAt must be a finite time");
      }

      const started = ensureStarted();
      const delay = Math.max(0, timestamp - Date.now());
      const job = await started.queue.add(
        "revoke-session",
        { sessionId: sessionIdText },
        delay > 0 ? { delay } : undefined,
      );
      logger?.debug?.(`Scheduled revocation for ${sessionId} in ${delay}ms`);
      return job.id;
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      if (worker) {
        await worker.close(true).catch(() => undefined);
      }
    },
  };
}
