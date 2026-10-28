import {
  ConnectionClosedError,
  QueueEvents,
  type QueueEventsOptions,
} from "bullmq";
import { Queue } from "bullmq";
import type { Logger } from "../logger.js";
import type { Redis } from "ioredis";
import { normalizeLogger } from "../logger.js";
import { redactError } from "../client/events.js";

export interface QueueEventsConfig {
  queue: Queue;
  logger?: Logger;
  prefix?: string;
  connection?: QueueEventsOptions["connection"];
  logJobData?: boolean;
  logPayloads?: boolean;
  payloadRedactor?: (value: unknown) => unknown;
}

/**
 * QueueEvents that can be closed after a failed startup.
 *
 * BullMQ's own `close()` awaits `this.client` before disconnecting, and that
 * getter resolves to the connection's `initializing` promise. When the
 * connection never became ready that promise has already rejected with
 * "Connection is closed.", so `close()` throws before it reaches
 * `connection.close()` and the duplicated ioredis client is left running its
 * reconnect loop. Nothing else in the process can stop it, because the caller
 * has no reference to the duplicate, so the process never exits.
 *
 * `Queue` does not have this problem: `RedisConnection.close()` handles
 * `status === "initializing"` itself.
 *
 * Disconnecting the duplicate first is safe in both directions. When the
 * connection is healthy, `disconnect()` ends it and the subsequent
 * `connection.close()` sees a client already at `end` and skips its own quit.
 */
class ManagedQueueEvents extends QueueEvents {
  override async close(): Promise<void> {
    const connection = this.connection as unknown as {
      _client?: Redis;
      close(force?: boolean): Promise<void>;
    };

    // A duplicate that is already gone does not need disconnecting, and
    // `disconnect()` is a no-op at `end`.
    const initializing = (connection as { initializing?: Promise<unknown> }).initializing;
    if (initializing) {
      await initializing.catch(() => undefined);
    }

    connection._client?.disconnect();

    try {
      await super.close();
    } catch (error) {
      // `super.close()` propagates the rejection from the failed startup
      // instead of reporting that the connection is now closed. The connection
      // itself does know how to close from `initializing`, so drive it directly
      // and only rethrow errors that are not about the connection being gone.
      await connection.close(true).catch(() => undefined);

      if (!isConnectionGone(error)) {
        throw error;
      }
    }
  }
}

/**
 * True for the "this connection is already gone" family of errors.
 *
 * `ConnectionClosedError` is checked first and structurally, because BullMQ
 * introduced it for exactly this reason — its own comment on the class says it
 * exists so `isNotConnectionError` can "do a structural `instanceof` check
 * rather than fragile message-substring matching". Matching the message cannot
 * work here: only some of BullMQ's construction sites pass ioredis's
 * `CONNECTION_CLOSED_ERROR_MSG`, and the others pass their own wording or no
 * message at all, in which case the class default (`"Connection is closed"`,
 * with no trailing period) applies. An exact string comparison therefore
 * rethrows precisely the failures this function exists to absorb, and the
 * caller gets an exception from teardown instead of a clean close.
 *
 * The string clauses stay as a fallback: they still cover a `bullmq` error that
 * predates the class, and an error forwarded from another adapter. `instanceof`
 * is identity-based, so a consumer with two copies of `bullmq` in one tree
 * would miss the class check — the fallbacks catch the ioredis wording, and
 * missing them is the safe direction to fail.
 */
function isConnectionGone(error: unknown): boolean {
  if (error instanceof ConnectionClosedError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message === "Connection is closed." ||
    error.message.includes("ECONNREFUSED") ||
    (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
  );
}

export function attachQueueEvents(config: QueueEventsConfig): QueueEvents {
  const { queue, connection } = config;

  // BullMQ swallows a throwing event listener and re-emits the failure as an
  // "error" event, which then throws again and lands on console.error. A logger
  // missing `info` would trigger that on every completed job.
  const logger = normalizeLogger(config.logger);

  // QueueEvents subscribes to a key derived from the prefix. Defaulting to a
  // literal "queue" here silently dropped every event for a queue created
  // with a custom prefix, so inherit the queue's own prefix instead.
  const prefix = config.prefix ?? queue.opts.prefix ?? "queue";

  const queueEvents = new ManagedQueueEvents(queue.name, {
    prefix,
    connection: connection ?? queue.opts.connection,
  });

  queueEvents.on(
    "completed",
    (
      args: { jobId: string; returnvalue: string; prev?: string },
      _id: string,
    ) => {
      logger?.info(`Job ${args.jobId} completed`);
    },
  );

  queueEvents.on(
    "failed",
    (
      args: { jobId: string; failedReason: string; prev?: string },
      _id: string,
    ) => {
      logger?.error(`Job ${args.jobId} failed`, { failedReason: redactError(args.failedReason) });
    },
  );

  const logJobData =
    config.logJobData === true || config.logPayloads === true;

  queueEvents.on(
    "progress",
    (args: { jobId: string; data: unknown }, _id: string) => {
      if (logJobData) {
        const redactor = config.payloadRedactor ?? ((value: unknown) => redactError(value));
        logger?.info(`Job ${args.jobId} progress`, redactor(args.data));
      } else {
        logger?.info(`Job ${args.jobId} progress`);
      }
    },
  );

  queueEvents.on("error", (error: Error) => {
    // QueueEvents duplicates the caller's client, so it authenticates with the
    // same password and BullMQ re-emits any AUTH failure here. ioredis attaches
    // the failing command to that error, and for AUTH its args are the password
    // in plaintext — logging it as-is would write the credential to the app's
    // log on every reconnect attempt against a misconfigured server.
    logger?.error(`Queue "${queue.name}" events error`, redactError(error));
  });

  return queueEvents;
}

export type { QueueEventsOptions } from "bullmq";
export { QueueEvents } from "bullmq";
