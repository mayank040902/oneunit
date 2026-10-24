import { type Redis as RedisClient, type ChainableCommander } from "ioredis";
import { normalizeLogger, type Logger } from "../logger.js";
import { redactError } from "./events.js";

export interface TransactionStep {
  label: string;
  run: (transaction: ChainableCommander) => void;
}

export interface TransactionOptions {
  timeout?: number;
  logger?: Logger;
  throwOnError?: boolean;
  watch?: string[];
}

export interface TransactionStepResult {
  label: string;
  value: unknown;
  error?: Error;
}

export interface TransactionResult {
  executed: boolean;
  results: TransactionStepResult[];
  durationMs: number;
  failed: number;
}

export class TransactionTimeoutError extends Error {
  constructor(timeout: number, steps: number) {
    super(`Redis transaction of ${steps} command${steps === 1 ? "" : "s"} did not complete within ${timeout}ms`);
    this.name = "TransactionTimeoutError";
  }
}

export class TransactionStepError extends Error {
  readonly label: string;
  readonly queued: number;

  constructor(label: string, queued: number) {
    super(`Redis transaction step "${label}" queued ${queued} command${queued === 1 ? "" : "s"}, expected exactly 1`);
    this.name = "TransactionStepError";
    this.label = label;
    this.queued = queued;
  }
}

export class TransactionCommandError extends Error {
  readonly results: TransactionStepResult[];

  constructor(results: TransactionStepResult[]) {
    const failed = results.filter((result) => result.error);
    super(`Redis transaction: ${failed.length} of ${results.length} commands failed`);
    this.name = "TransactionCommandError";
    this.results = results;
  }
}

function isThenable(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

const DEFAULT_TIMEOUT_MS = 5000;

export async function runTransaction(
  client: RedisClient,
  steps: TransactionStep[],
  options: TransactionOptions = {},
): Promise<TransactionResult> {
  const logger = normalizeLogger(options.logger);
  const requested = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const timeout = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TIMEOUT_MS;

  if (steps.length === 0) {
    return { executed: true, results: [], durationMs: 0, failed: 0 };
  }

  if (options.watch && options.watch.length > 0) {
    await client.watch(...options.watch);
  }

  const transaction = client.multi();
  for (const step of steps) {
    const before = transaction.length;
    let returned: unknown;
    try {
      returned = step.run(transaction);
    } catch (error) {
      logger?.error(`Redis transaction step failed to queue: ${step.label}`, { err: redactError(error) });
      throw error;
    }

    const queued = transaction.length - before;
    if (isThenable(returned)) {
      void Promise.resolve(returned).catch(() => undefined);
      throw new TransactionStepError(step.label, queued);
    }
    if (queued !== 1) {
      logger?.error(`Redis transaction step queued ${queued} commands: ${step.label}`);
      throw new TransactionStepError(step.label, queued);
    }
  }

  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeout);
  });

  let raw: Array<[Error | null, unknown]> | null;
  try {
    const outcome = await Promise.race([transaction.exec(), expiry]);
    if (outcome === "timeout") {
      throw new TransactionTimeoutError(timeout, steps.length);
    }
    raw = outcome as Array<[Error | null, unknown]>;
  } catch (error) {
    if (error instanceof TransactionTimeoutError) {
      throw error;
    }
    throw redactError(error);
  } finally {
    clearTimeout(timer);
  }

  const executed = raw !== null;
  const results: TransactionStepResult[] = (raw ?? []).map(([error, value], index) => ({
    label: steps[index]?.label ?? `#${index}`,
    value,
    ...(error ? { error: redactError(error) as Error } : {}),
  }));

  const failed = results.filter((result) => result.error).length;
  const durationMs = Math.round(performance.now() - started);

  if (executed && failed > 0 && options.throwOnError) {
    throw new TransactionCommandError(results);
  }

  if (!executed) {
    return { executed: false, results: [], durationMs, failed: 0 };
  }

  return { executed, results, durationMs, failed };
}
