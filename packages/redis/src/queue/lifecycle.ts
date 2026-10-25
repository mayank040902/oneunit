import { Queue, Worker, QueueEvents, Job, type JobsOptions, type QueueOptions, type FlowJob, type FlowOpts, type JobProgress, type RepeatOptions } from "bullmq";
import type { JobState as BullMQJobState } from "bullmq";
import { type Redis as RedisClient } from "ioredis";
import { normalizeLogger, type Logger } from "../logger.js";
import { redactError } from "../client/events.js";

export interface QueueLifecycleConfig {
  connection: RedisClient;
  prefix?: string;
  logger?: Logger;
}

export interface JobScheduleOptions {
  repeat?: RepeatOptions;
  jobId?: string;
}

export interface JobEnqueueOptions<T = unknown> {
  name: string;
  data: T;
  opts?: JobsOptions;
  schedule?: JobScheduleOptions;
}

export interface BulkEnqueueOptions<T = unknown> {
  jobs: Array<{ name: string; data: T; opts?: JobsOptions }>;
}

export interface JobCancellationResult {
  cancelled: boolean;
  reason?: string;
}

export interface JobProgressUpdate {
  jobId: string;
  progress: JobProgress;
}

export interface JobResult<T = unknown> {
  jobId: string;
  state: JobState;
  returnValue?: T;
  failedReason?: string;
  progress?: JobProgress;
  attemptsMade: number;
  finishedOn?: number;
  processedOn?: number;
}

export type JobState = BullMQJobState | "unknown";

export interface QueueHealthSnapshot {
  queueName: string;
  timestamp: number;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
    paused?: number;
    "waiting-children"?: number;
  };
  paused: boolean;
}

export interface WorkerHealthSnapshot {
  workerId: string;
  queueName: string;
  timestamp: number;
  isRunning: boolean;
  isPaused: boolean;
  concurrency: number;
  activeJobs: number;
}

export interface DLQConfig {
  queueName: string;
  maxRetries?: number;
  preservePayload?: boolean;
  sanitizeFields?: string[];
}

export interface DLQEntry<T = unknown> {
  id: string;
  originalQueueName: string;
  originalJobId: string;
  jobName: string;
  payload: T;
  failedReason: string;
  attemptsMade: number;
  failedAt: number;
  originalAttempts: number;
  correlationId?: string;
}

export interface JobMiddlewareContext<TData = unknown, TResult = unknown> {
  job: Job<TData, TResult>;
  queueName: string;
  attemptNumber: number;
  isRetry: boolean;
}

export type JobMiddleware<TData = unknown, TResult = unknown> = (
  context: JobMiddlewareContext<TData, TResult>,
  next: () => Promise<TResult>
) => Promise<TResult>;

export interface TypedJobRegistry {
  [jobName: string]: {
    data: unknown;
    result: unknown;
  };
}

export interface JobProcessor<TData = unknown, TResult = unknown> {
  (job: Job<TData, TResult>): Promise<TResult>;
}

export interface WorkerWithMiddleware<TData = unknown, TResult = unknown> extends Worker<TData, TResult> {
  use: (middleware: JobMiddleware<TData, TResult>) => WorkerWithMiddleware<TData, TResult>;
}

export interface QueuePolicy {
  defaultJobOptions?: JobsOptions;
  retry?: {
    attempts: number;
    backoff: { type: "fixed" | "exponential"; delay: number };
  };
  concurrency?: number;
  rateLimit?: { max: number; duration: number };
  retention?: { completed: number | boolean; failed: number | boolean };
  dlq?: DLQConfig;
  middleware?: JobMiddleware[];
  scheduling?: { defaultRepeatOptions?: Omit<RepeatOptions, "key"> };
}

export interface PerQueuePolicies {
  [queueName: string]: QueuePolicy;
}

export function createQueueWithPolicy(
  config: QueueConfig & { policy?: QueuePolicy }
): Queue {
  const { policy, ...queueConfig } = config;
  const mergedOptions = mergePolicyIntoQueueOptions(queueConfig, policy);
  return new Queue(mergedOptions.name, mergedOptions);
}

export function mergePolicyIntoQueueOptions(
  config: QueueConfig,
  policy?: QueuePolicy
): QueueOptions & { name: string; connection: RedisClient } {
  const { name, connection, prefix = "queue", defaultJobOptions, settings, ...options } = config;

  const baseDefaults: JobsOptions = {
    removeOnComplete: policy?.retention?.completed ?? 100,
    removeOnFail: policy?.retention?.failed ?? 1000,
    attempts: policy?.retry?.attempts ?? 3,
    backoff: policy?.retry?.backoff ?? { type: "exponential", delay: 1000 },
  };

  const merged: Record<string, unknown> = { ...baseDefaults };

  for (const [key, value] of Object.entries(defaultJobOptions ?? {})) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return {
    name,
    connection,
    prefix,
    defaultJobOptions: merged as JobsOptions,
    settings,
    ...options,
  };
}

export interface QueueConfig {
  name: string;
  connection: RedisClient;
  prefix?: string;
  defaultJobOptions?: JobsOptions;
  settings?: QueueOptions["settings"];
}

export async function enqueueJob<T = unknown>(
  queue: Queue,
  options: JobEnqueueOptions<T>
): Promise<Job<T> | undefined> {
  const { name, data, opts, schedule } = options;

  if (schedule?.repeat) {
    const jobScheduler = await queue.jobScheduler;
    const repeatOpts = { ...schedule.repeat, key: schedule.jobId ?? name };
    return jobScheduler.upsertJobScheduler(
      schedule.jobId ?? name,
      repeatOpts,
      name,
      data,
      (opts ?? {}) as Record<string, unknown>,
      { override: true }
    );
  }

  if (opts?.delay && opts.delay > 0) {
    return queue.add(name, data, { ...opts, delay: opts.delay });
  }

  return queue.add(name, data, opts);
}

export async function enqueueBulkJobs<T = unknown>(
  queue: Queue,
  options: BulkEnqueueOptions<T>
): Promise<Job<T>[]> {
  return queue.addBulk(options.jobs as Array<{ name: string; data: T; opts?: JobsOptions }>) as Promise<Job<T>[]>;
}

export async function cancelJob(
  queue: Queue,
  jobId: string,
  force = false
): Promise<JobCancellationResult> {
  try {
    const job = await Job.fromId(queue, jobId);
    if (!job) {
      return { cancelled: false, reason: "Job not found" };
    }

    const state = await job.getState();
    if (state === "active") {
      if (!force) {
        return { cancelled: false, reason: "Job is active; use force=true to attempt cancellation" };
      }
      const worker = await getWorkerForJob(queue, jobId);
      if (worker) {
        worker.cancelJob(jobId);
        return { cancelled: true, reason: "Cancellation signal sent to worker" };
      }
      return { cancelled: false, reason: "No worker found processing this job" };
    }

    await job.remove({ removeChildren: true });
    return { cancelled: true };
  } catch (error) {
    return { cancelled: false, reason: redactError(error) instanceof Error ? (redactError(error) as Error).message : String(redactError(error)) };
  }
}

export async function getJobProgress(queue: Queue, jobId: string): Promise<JobProgress | null> {
  const job = await Job.fromId(queue, jobId);
  if (!job) return null;
  return job.progress;
}

export async function getJobResult<T = unknown>(
  queue: Queue,
  jobId: string
): Promise<JobResult<T> | null> {
  const job = await Job.fromId(queue, jobId);
  if (!job) return null;

  const state = await job.getState();
  return {
    jobId: job.id!,
    state,
    returnValue: job.returnvalue as T,
    failedReason: job.failedReason,
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    finishedOn: job.finishedOn,
    processedOn: job.processedOn,
  };
}

export async function pauseQueue(queue: Queue): Promise<void> {
  await queue.pause();
}

export async function resumeQueue(queue: Queue): Promise<void> {
  await queue.resume();
}

export async function isQueuePaused(queue: Queue): Promise<boolean> {
  return queue.isPaused();
}

export async function getQueueHealth(queue: Queue): Promise<QueueHealthSnapshot> {
  const counts = await queue.getJobCounts();
  const paused = await queue.isPaused();

  return {
    queueName: queue.name,
    timestamp: Date.now(),
    counts: {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      paused: counts.paused ?? 0,
      "waiting-children": counts["waiting-children"] ?? 0,
    },
    paused,
  };
}

export async function getWorkerHealth(worker: Worker): Promise<WorkerHealthSnapshot> {
  return {
    workerId: worker.id,
    queueName: worker.name,
    timestamp: Date.now(),
    isRunning: worker.isRunning(),
    isPaused: worker.isPaused(),
    concurrency: worker.concurrency,
    activeJobs: 0,
  };
}

export async function gracefulDrainWorker(
  worker: Worker,
  timeoutMs = 30000
): Promise<void> {
  const startTime = Date.now();

  worker.pause(true);

  while (worker.isRunning() && Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await worker.close(true);
}

export async function closeQueueEvents(queueEvents: QueueEvents): Promise<void> {
  await queueEvents.close();
}

async function getWorkerForJob(_queue: Queue, _jobId: string): Promise<Worker | null> {
  return null;
}

export function createQueueEventsWrapper(
  queue: Queue,
  config: QueueEventsConfig
): QueueEvents {
  const { logger, prefix, connection, logJobData, logPayloads, payloadRedactor } = config;

  const resolvedLogger = normalizeLogger(logger);
  const resolvedPrefix = prefix ?? queue.opts.prefix ?? "queue";

  const queueEvents = new QueueEvents(queue.name, {
    prefix: resolvedPrefix,
    connection: connection ?? queue.opts.connection,
  });

  queueEvents.on("completed", (args: { jobId: string; returnvalue: string; prev?: string }) => {
    resolvedLogger?.info(`Job ${args.jobId} completed`);
  });

  queueEvents.on(
    "failed",
    (args: { jobId: string; failedReason: string; prev?: string }) => {
      resolvedLogger?.error(`Job ${args.jobId} failed`, {
        failedReason: redactError(args.failedReason),
      });
    }
  );

  const shouldLogData = logJobData === true || logPayloads === true;

  queueEvents.on("progress", (args: { jobId: string; data: unknown }, _id: string) => {
    if (shouldLogData) {
      const redactor = payloadRedactor ?? ((value: unknown) => redactError(value));
      resolvedLogger?.info(`Job ${args.jobId} progress`, redactor(args.data));
    } else {
      resolvedLogger?.info(`Job ${args.jobId} progress`);
    }
  });

  queueEvents.on("error", (error: Error) => {
    resolvedLogger?.error(`Queue "${queue.name}" events error`, redactError(error));
  });

  return queueEvents;
}

export interface QueueEventsConfig {
  queue: Queue;
  logger?: Logger;
  prefix?: string;
  connection?: RedisClient;
  logJobData?: boolean;
  logPayloads?: boolean;
  payloadRedactor?: (value: unknown) => unknown;
}

import { FlowProducer } from "bullmq";

export interface FlowProducerConfig {
  connection: RedisClient;
  prefix?: string;
}

export function createFlowProducer(config: FlowProducerConfig): FlowProducer {
  const { connection, prefix = "queue" } = config;
  return new FlowProducer({ prefix, connection });
}

export async function addFlow(
  flowProducer: FlowProducer,
  flow: FlowJob,
  opts?: FlowOpts
): Promise<ReturnType<FlowProducer["add"]>> {
  return flowProducer.add(flow, opts);
}

export async function addBulkFlows(
  flowProducer: FlowProducer,
  flows: FlowJob[]
): Promise<ReturnType<FlowProducer["addBulk"]>> {
  return flowProducer.addBulk(flows);
}

export function createJobRegistry<T extends TypedJobRegistry>(
  jobs: T
): TypedJobRegistry {
  return jobs;
}

export function validateJobData<T extends TypedJobRegistry, K extends keyof T>(
  registry: T,
  jobName: K,
  _data: unknown
): _data is T[K]["data"] {
  return jobName in registry;
}

export function validateJobResult<T extends TypedJobRegistry, K extends keyof T>(
  registry: T,
  jobName: K,
  _result: unknown
): _result is T[K]["result"] {
  return jobName in registry;
}

export function createErrorClassifier(
  customClassifier?: (error: Error) => { retryable: boolean; category: string }
) {
  return (error: Error): { retryable: boolean; category: string } => {
    if (customClassifier) {
      return customClassifier(error);
    }

    const message = error.message.toLowerCase();
    const name = error.name.toLowerCase();

    if (
      name.includes("validation") ||
      message.includes("validation") ||
      message.includes("invalid") ||
      name.includes("unauthorized") ||
      message.includes("unauthorized") ||
      message.includes("forbidden")
    ) {
      return { retryable: false, category: "validation" };
    }

    if (
      message.includes("rate limit") ||
      message.includes("too many requests") ||
      message.includes("429") ||
      name.includes("timeout") ||
      message.includes("timeout") ||
      message.includes("econnrefused") ||
      message.includes("etimedout") ||
      message.includes("econnreset")
    ) {
      return { retryable: true, category: "transient" };
    }

    return { retryable: true, category: "unknown" };
  };
}

export interface TracerInterface {
  startSpan?(name: string, options?: { attributes?: Record<string, unknown> }): SpanInterface | undefined;
}

export interface SpanInterface {
  setStatus?(status: { code: number; message?: string }): void;
  recordException?(error: Error): void;
  end?(): void;
}

export interface TracingConfig {
  enabled: boolean;
  serviceName?: string;
  tracer?: TracerInterface;
}

export function createTracingMiddleware(config: TracingConfig) {
  if (!config.enabled || !config.tracer) {
    return async <TData, TResult>(
      context: JobMiddlewareContext<TData, TResult>,
      next: () => Promise<TResult>
    ): Promise<TResult> => next();
  }

  return async <TData, TResult>(
    context: JobMiddlewareContext<TData, TResult>,
    next: () => Promise<TResult>
  ): Promise<TResult> => {
    const span = config.tracer?.startSpan?.(`job.${context.job.name}`, {
      attributes: {
        "job.queue": context.queueName,
        "job.id": context.job.id,
        "job.attempt": context.attemptNumber,
        "job.retry": context.isRetry,
      },
    });

    try {
      const result = await next();
      span?.setStatus?.({ code: 1 });
      return result;
    } catch (error) {
      span?.recordException?.(error as Error);
      span?.setStatus?.({ code: 2, message: (error as Error).message });
      throw error;
    } finally {
      span?.end?.();
    }
  };
}

export function createPerQueuePolicyRegistry(): PerQueuePolicies {
  return {};
}

export function registerQueuePolicy(
  registry: PerQueuePolicies,
  queueName: string,
  policy: QueuePolicy
): void {
  registry[queueName] = policy;
}

export function getQueuePolicy(
  registry: PerQueuePolicies,
  queueName: string
): QueuePolicy | undefined {
  return registry[queueName];
}

export function createDlqQueue(
  connection: RedisClient,
  config: DLQConfig
): Queue {
  const dlqName = `${config.queueName}-dlq`;
  return new Queue(dlqName, {
    connection,
    prefix: "queue",
    defaultJobOptions: {
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
}

export async function moveToDlq<T = unknown>(
  sourceQueue: Queue,
  dlqQueue: Queue,
  jobId: string,
  config: DLQConfig
): Promise<boolean> {
  try {
    const job = await Job.fromId(sourceQueue, jobId);
    if (!job) return false;

    const sanitizedPayload = config.preservePayload
      ? sanitizePayload(job.data as T, config.sanitizeFields)
      : ({} as T);

    await dlqQueue.add(
      "dead-letter",
      {
        originalQueueName: sourceQueue.name,
        originalJobId: job.id,
        jobName: job.name,
        payload: sanitizedPayload,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        failedAt: Date.now(),
        originalAttempts: job.opts.attempts,
      },
      { removeOnComplete: false, removeOnFail: false }
    );

    return true;
  } catch {
    return false;
  }
}

function sanitizePayload<T>(payload: T, fields?: string[]): T {
  if (!fields || fields.length === 0) return payload;

  const sanitized = { ...payload } as Record<string, unknown>;
  for (const field of fields) {
    if (field in sanitized) {
      sanitized[field] = "[redacted]";
    }
  }
  return sanitized as T;
}

export async function replayDlqJob(
  dlqQueue: Queue,
  targetQueue: Queue,
  dlqJobId: string
): Promise<Job | null> {
  const dlqJob = await Job.fromId(dlqQueue, dlqJobId);
  if (!dlqJob) return null;

  const data = dlqJob.data as DLQEntry;
  const job = await targetQueue.add(data.jobName, data.payload, {
    attempts: data.originalAttempts,
    jobId: data.originalJobId,
  });

  await dlqJob.remove();
  return job;
}

interface DLQJobData<T = unknown> {
  originalQueueName: string;
  originalJobId: string;
  jobName: string;
  payload: T;
  failedReason: string;
  attemptsMade: number;
  failedAt: number;
  originalAttempts: number;
  correlationId?: string;
}

export async function getDlqEntries<T = unknown>(
  dlqQueue: Queue,
  start = 0,
  end = 100
): Promise<DLQEntry<T>[]> {
  const jobs = await dlqQueue.getJobs(["waiting", "active", "failed"], start, end);
  return jobs.map((job) => {
    const data = job.data as DLQJobData<T>;
    return {
      id: job.id!,
      originalQueueName: data.originalQueueName,
      originalJobId: data.originalJobId,
      jobName: data.jobName,
      payload: data.payload,
      failedReason: data.failedReason,
      attemptsMade: data.attemptsMade,
      failedAt: data.failedAt,
      originalAttempts: data.originalAttempts,
      correlationId: data.correlationId,
    };
  });
}