import { Queue, type QueueOptions, type JobsOptions, type Job } from "bullmq";
import { type Redis as RedisClient } from "ioredis";

export interface QueueConfig {
  name: string;
  connection: RedisClient;
  prefix?: string;
  defaultJobOptions?: JobsOptions;
  settings?: QueueOptions["settings"];
}

export function createQueue(config: QueueConfig): Queue {
  const {
    name,
    connection,
    prefix = "queue",
    defaultJobOptions,
    settings,
    ...options
  } = config;

  const defaults: JobsOptions = {
    removeOnComplete: 100,
    removeOnFail: 1000,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  };

  const merged: Record<string, unknown> = { ...defaults };

  for (const [key, value] of Object.entries(defaultJobOptions ?? {})) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  const queueOptions: QueueOptions = {
    prefix,
    connection,
    defaultJobOptions: merged as JobsOptions,
    ...(settings === undefined ? {} : { settings }),
    ...options,
  };

  const queue = new Queue(name, queueOptions);

  return queue;
}

export async function addJob<TData = unknown>(
  queue: Queue,
  name: string,
  data: TData,
  opts?: JobsOptions
): Promise<Job> {
  return queue.add(name, data, opts) as Promise<Job>;
}

export async function addBulkJobs<TData = unknown>(
  queue: Queue,
  jobs: Array<{ name: string; data: TData; opts?: JobsOptions }>
): Promise<Job[]> {
  return queue.addBulk(jobs as Array<{ name: string; data: TData; opts?: JobsOptions }>) as Promise<Job[]>;
}

export async function scheduleJob<TData = unknown>(
  queue: Queue,
  name: string,
  data: TData,
  repeatOptions: { pattern: string; tz?: string; limit?: number; startDate?: Date | string; endDate?: Date | string },
  opts?: JobsOptions
): Promise<Job | undefined> {
  const jobScheduler = await queue.jobScheduler;
  return jobScheduler.upsertJobScheduler(
    name,
    { pattern: repeatOptions.pattern, tz: repeatOptions.tz, limit: repeatOptions.limit, startDate: repeatOptions.startDate, endDate: repeatOptions.endDate },
    name,
    data,
    (opts ?? {}) as Record<string, unknown>,
    { override: true }
  ) as Promise<Job | undefined>;
}

export async function removeJobScheduler(
  queue: Queue,
  schedulerId: string
): Promise<boolean> {
  return queue.removeJobScheduler(schedulerId);
}

export async function getJobSchedulers(
  queue: Queue,
  start?: number,
  end?: number,
  asc?: boolean
): Promise<ReturnType<Queue["getJobSchedulers"]>> {
  return queue.getJobSchedulers(start, end, asc);
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

export async function getQueueCounts(queue: Queue): Promise<Record<string, number>> {
  return queue.getJobCounts();
}

export async function drainQueue(queue: Queue, delayed = false): Promise<void> {
  await queue.drain(delayed);
}

export async function cleanQueue(
  queue: Queue,
  grace: number,
  limit: number,
  type?: 'completed' | 'wait' | 'waiting' | 'active' | 'paused' | 'prioritized' | 'delayed' | 'failed'
): Promise<string[]> {
  return queue.clean(grace, limit, type);
}

const CLOSED_QUEUES = new WeakSet<Queue>();

export async function closeQueue(queue: Queue): Promise<void> {
  if (CLOSED_QUEUES.has(queue)) {
    return;
  }

  CLOSED_QUEUES.add(queue);

  try {
    await queue.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/connection is closed/i.test(message)) {
      // BullMQ may already have closed its internal connection; treat that as
      // a successful repeated shutdown rather than propagating an unhandled
      // error from a connection that is no longer live.
      return;
    }

    throw error;
  }
}

export async function obliterateQueue(queue: Queue, force = false): Promise<void> {
  await queue.obliterate({ force });
}

export type { QueueOptions, JobsOptions } from "bullmq";
export { Queue } from "bullmq";
