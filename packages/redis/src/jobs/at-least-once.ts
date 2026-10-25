import { Queue, Worker, QueueEvents, type Processor, type JobsOptions, type Job } from "bullmq";
import { type Redis } from "ioredis";
import { normalizeLogger, type Logger } from "../logger.js";
import { createQueue, createWorker, attachQueueEvents, pauseQueue, resumeQueue, isQueuePaused, getQueueCounts, closeQueue, drainQueue, obliterateQueue, addJob, addBulkJobs, scheduleJob, removeJobScheduler, getJobSchedulers } from "../queue/index.js";
import { createDlqQueue, moveToDlq, replayDlqJob, getDlqEntries, type DLQConfig, type DLQEntry } from "../queue/lifecycle.js";

export interface JobAtLeastOnceBackoff {
  type: "fixed" | "exponential";
  delay: number;
}

export interface JobAtLeastOnceOptions {
  enabled?: boolean;
  queueName?: string;
  prefix?: string;
  connection?: Redis;
  concurrency?: number;
  attempts?: number;
  backoff?: JobAtLeastOnceBackoff;
  removeOnComplete?: number | boolean;
  removeOnFail?: number | boolean;
  ownsConnection?: boolean;
  logger?: Logger;
  dlq?: DLQConfig;
  defaultJobOptions?: JobsOptions;
}

export interface JobAtLeastOnceStatus {
  enabled: boolean;
  queueName: string;
  isClosed: boolean;
}

export interface ScheduledJobInfo {
  id: string;
  name: string;
  nextRunAt: number;
  repeatOptions: Record<string, unknown>;
}

export interface JobAtLeastOnce {
  readonly enabled: boolean;
  readonly queueName: string;
  add<TData = unknown>(
    name: string,
    data: TData,
    options?: JobsOptions,
  ): Promise<Job<TData>>;
  addBulk<TData = unknown>(
    jobs: Array<{ name: string; data: TData; options?: JobsOptions }>
  ): Promise<Job<TData>[]>;
  schedule<TData = unknown>(
    name: string,
    data: TData,
    repeatOptions: { pattern: string; tz?: string; limit?: number; startDate?: Date | string; endDate?: Date | string },
    options?: JobsOptions
  ): Promise<Job<TData> | undefined>;
  removeSchedule(schedulerId: string): Promise<boolean>;
  getSchedules(start?: number, end?: number, asc?: boolean): Promise<ScheduledJobInfo[]>;
  createWorker<TData = unknown, TResult = unknown>(
    processor: Processor<TData, TResult>,
    options?: { concurrency?: number; middleware?: Array<(job: Job<TData, TResult>, token: string | undefined, signal: AbortSignal | undefined, next: () => Promise<TResult>) => Promise<TResult>> },
  ): Worker<TData, TResult>;
  getCounts(): Promise<Record<string, number>>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  isPaused(): Promise<boolean>;
  drain(delayed?: boolean): Promise<void>;
  obliterate(force?: boolean): Promise<void>;
  close(): Promise<void>;
  status(): JobAtLeastOnceStatus;
  getDlq(): { queue: Queue; entries: (start?: number, end?: number) => Promise<DLQEntry[]>; replay: (jobId: string) => Promise<Job | null> } | null;
}

const DEFAULT_QUEUE_NAME = "application-jobs";
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF: JobAtLeastOnceBackoff = {
  type: "exponential",
  delay: 1000,
};

function validateOptions(options: JobAtLeastOnceOptions): void {
  const queueName = options.queueName ?? DEFAULT_QUEUE_NAME;
  if (typeof queueName !== "string" || queueName.trim() === "") {
    throw new Error("queueName must be a non-empty string");
  }

  if (options.concurrency !== undefined) {
    if (!Number.isFinite(options.concurrency) || options.concurrency < 1) {
      throw new Error("concurrency must be a positive finite number");
    }
  }

  if (options.attempts !== undefined) {
    if (!Number.isFinite(options.attempts) || options.attempts < 1) {
      throw new Error("attempts must be a positive finite number");
    }
  }

  if (options.backoff !== undefined) {
    if (options.backoff.type !== "fixed" && options.backoff.type !== "exponential") {
      throw new Error('backoff.type must be "fixed" or "exponential"');
    }
    if (!Number.isFinite(options.backoff.delay) || options.backoff.delay < 0) {
      throw new Error("backoff.delay must be a non-negative finite number");
    }
  }
}

export class DisabledJobAtLeastOnce implements JobAtLeastOnce {
  readonly enabled = false;
  readonly queueName: string;

  constructor(queueName = DEFAULT_QUEUE_NAME) {
    this.queueName = queueName;
  }

  async add(): Promise<never> {
    throw new Error("At-least-once job processing is disabled");
  }

  async addBulk(): Promise<never> {
    throw new Error("At-least-once job processing is disabled");
  }

  async schedule(): Promise<never> {
    throw new Error("At-least-once job processing is disabled");
  }

  async removeSchedule(): Promise<never> {
    throw new Error("At-least-once job processing is disabled");
  }

  async getSchedules(): Promise<never> {
    throw new Error("At-least-once job processing is disabled");
  }

  createWorker(): never {
    throw new Error("At-least-once job processing is disabled");
  }

  async getCounts(): Promise<Record<string, number>> {
    throw new Error("At-least-once job processing is disabled");
  }

  async pause(): Promise<void> {
    throw new Error("At-least-once job processing is disabled");
  }

  async resume(): Promise<void> {
    throw new Error("At-least-once job processing is disabled");
  }

  async isPaused(): Promise<never> {
    throw new Error("At-least-once job processing is disabled");
  }

  async drain(): Promise<void> {
    throw new Error("At-least-once job processing is disabled");
  }

  async obliterate(): Promise<void> {
    throw new Error("At-least-once job processing is disabled");
  }

  async close(): Promise<void> {
  }

  status(): JobAtLeastOnceStatus {
    return { enabled: false, queueName: this.queueName, isClosed: true };
  }

  getDlq() {
    return null;
  }
}

export class JobAtLeastOnceImpl implements JobAtLeastOnce {
  readonly enabled = true;
  readonly queueName: string;

  private readonly logger: ReturnType<typeof normalizeLogger>;
  private readonly prefix: string;
  private readonly concurrency: number;
  private readonly attempts: number;
  private readonly backoff: JobAtLeastOnceBackoff;
  private readonly ownsConnection: boolean;
  private readonly removeOnComplete: number | boolean;
  private readonly removeOnFail: number | boolean;
  private readonly dlqConfig?: DLQConfig;

  private readonly queue: Queue;
  private readonly events: QueueEvents;
  private readonly connection: Redis;

  private readonly dlqQueue?: Queue;
  private workers: Worker[] = [];
  private closed = false;

  constructor(options: JobAtLeastOnceOptions) {
    validateOptions(options);

    this.logger = normalizeLogger(options.logger);
    this.queueName = options.queueName ?? DEFAULT_QUEUE_NAME;
    this.prefix = options.prefix ?? "queue";
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.attempts = options.attempts ?? DEFAULT_ATTEMPTS;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.ownsConnection = Boolean(options.ownsConnection);
    this.removeOnComplete = options.removeOnComplete ?? 100;
    this.removeOnFail = options.removeOnFail ?? 1000;
    this.dlqConfig = options.dlq;

    if (!options.connection) {
      throw new Error("A Redis connection is required for job processing");
    }
    this.connection = options.connection;

    this.queue = createQueue({
      name: this.queueName,
      connection: this.connection,
      prefix: this.prefix,
      defaultJobOptions: {
        attempts: this.attempts,
        backoff: this.backoff,
        removeOnComplete: this.removeOnComplete,
        removeOnFail: this.removeOnFail,
        ...options.defaultJobOptions,
      },
    });

    this.events = attachQueueEvents({
      queue: this.queue,
      logger: this.logger,
      prefix: this.prefix,
      connection: this.connection,
    });

    if (this.dlqConfig) {
      const { queueName: _, ...dlqConfigRest } = this.dlqConfig;
      this.dlqQueue = createDlqQueue(this.connection, {
        queueName: this.queueName,
        ...dlqConfigRest,
      });
    }

    this.logger?.info?.(`Job processing enabled for queue "${this.queueName}"`);
  }

  async add<TData = unknown>(
    name: string,
    data: TData,
    options?: JobsOptions,
  ): Promise<Job<TData>> {
    if (this.closed) {
      throw new Error("Job processing has been closed");
    }
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("Job name must be a non-empty string");
    }
    return addJob(this.queue, name, data, options);
  }

  async addBulk<TData = unknown>(
    jobs: Array<{ name: string; data: TData; options?: JobsOptions }>
  ): Promise<Job<TData>[]> {
    if (this.closed) {
      throw new Error("Job processing has been closed");
    }
    return addBulkJobs(this.queue, jobs as Array<{ name: string; data: TData; opts?: JobsOptions }>) as Promise<Job<TData>[]>;
  }

  async schedule<TData = unknown>(
    name: string,
    data: TData,
    repeatOptions: { pattern: string; tz?: string; limit?: number; startDate?: Date | string; endDate?: Date | string },
    options?: JobsOptions
  ): Promise<Job<TData> | undefined> {
    if (this.closed) {
      throw new Error("Job processing has been closed");
    }
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("Job name must be a non-empty string");
    }
    return scheduleJob(this.queue, name, data, repeatOptions, options);
  }

  async removeSchedule(schedulerId: string): Promise<boolean> {
    if (this.closed) {
      throw new Error("Job processing has been closed");
    }
    return removeJobScheduler(this.queue, schedulerId);
  }

  async getSchedules(start?: number, end?: number, asc?: boolean): Promise<ScheduledJobInfo[]> {
    if (this.closed) {
      throw new Error("Job processing has been closed");
    }
    const schedulers = await getJobSchedulers(this.queue, start, end, asc);
    return schedulers.map((s: { key: string; name: string; id?: string | null; next?: number; pattern?: string; template?: { opts?: Record<string, unknown> } }) => ({
      id: s.id ?? s.key,
      name: s.name,
      nextRunAt: s.next ?? 0,
      repeatOptions: s.template?.opts ?? { pattern: s.pattern },
    }));
  }

  createWorker<TData = unknown, TResult = unknown>(
    processor: Processor<TData, TResult>,
    options?: { concurrency?: number; middleware?: Array<(job: Job<TData, TResult>, token: string | undefined, signal: AbortSignal | undefined, next: () => Promise<TResult>) => Promise<TResult>> },
  ): Worker<TData, TResult> {
    if (this.closed) {
      throw new Error("Job processing has been closed");
    }
    const worker = createWorker<TData, TResult>({
      name: this.queueName,
      processor: async (job, token, signal) => {
        try {
          return await processor(job, token, signal);
        } catch (error) {
          if (this.dlqQueue && this.dlqConfig) {
            await moveToDlq(this.queue, this.dlqQueue, job.id!, this.dlqConfig).catch(() => undefined);
          }
          throw error;
        }
      },
      connection: this.connection,
      prefix: this.prefix,
      concurrency: options?.concurrency ?? this.concurrency,
      middleware: options?.middleware,
    });
    this.workers.push(worker as unknown as Worker);
    return worker;
  }

  async getCounts(): Promise<Record<string, number>> {
    if (this.closed) {
      throw new Error("Job processing has been closed");
    }
    return getQueueCounts(this.queue);
  }

  async pause(): Promise<void> {
    if (this.closed) {
      throw new Error("Job processing has been closed");
    }
    await pauseQueue(this.queue);
  }

  async resume(): Promise<void> {
    if (this.closed) {
      throw new Error("Job processing has been closed");
    }
    await resumeQueue(this.queue);
  }

  async isPaused(): Promise<boolean> {
    if (this.closed) {
      throw new Error("Job processing has been closed");
    }
    return isQueuePaused(this.queue);
  }

  async drain(delayed = false): Promise<void> {
    if (this.closed) {
      throw new Error("Job processing has been closed");
    }
    await drainQueue(this.queue, delayed);
  }

  async obliterate(force = false): Promise<void> {
    if (this.closed) {
      throw new Error("Job processing has been closed");
    }
    await obliterateQueue(this.queue, force);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    await Promise.all(this.workers.map((worker) => worker.close(true)));
    this.workers = [];

    await this.events.close().catch(() => undefined);
    await closeQueue(this.queue).catch(() => undefined);

    if (this.dlqQueue) {
      await closeQueue(this.dlqQueue).catch(() => undefined);
    }

    if (this.ownsConnection) {
      try {
        await this.connection.quit();
      } catch {
        this.connection.disconnect();
      }
    }
  }

  status(): JobAtLeastOnceStatus {
    return { enabled: true, queueName: this.queueName, isClosed: this.closed };
  }

  getDlq() {
    if (!this.dlqQueue) return null;
    return {
      queue: this.dlqQueue,
      entries: (start = 0, end = 100) => getDlqEntries(this.dlqQueue!, start, end),
      replay: (jobId: string) => replayDlqJob(this.dlqQueue!, this.queue, jobId),
    };
  }
}

export function createJobAtLeastOnce(options: JobAtLeastOnceOptions = {}): JobAtLeastOnce {
  const enabled = options.enabled ?? false;
  if (!enabled) {
    return new DisabledJobAtLeastOnce(options.queueName ?? DEFAULT_QUEUE_NAME);
  }
  return new JobAtLeastOnceImpl(options);
}

export type { Queue, Worker, Job } from "bullmq";
