import { Worker, type WorkerOptions, type Processor, type Job } from "bullmq";
import { type Redis as RedisClient } from "ioredis";

export interface JobMiddleware<TData = unknown, TResult = unknown> {
  (job: Job<TData, TResult>, token: string | undefined, signal: AbortSignal | undefined, next: () => Promise<TResult>): Promise<TResult>;
}

export interface WorkerConfig<TData = unknown, TResult = unknown> {
  name: string;
  processor: Processor<TData, TResult>;
  connection: RedisClient;
  prefix?: string;
  concurrency?: number;
  limiter?: WorkerOptions["limiter"];
  settings?: WorkerOptions["settings"];
  middleware?: JobMiddleware<TData, TResult>[];
}

export interface WorkerWithMiddleware<TData = unknown, TResult = unknown> extends Worker<TData, TResult> {
  use(middleware: JobMiddleware<TData, TResult>): WorkerWithMiddleware<TData, TResult>;
}

export function createWorker<TData = unknown, TResult = unknown>(
  config: WorkerConfig<TData, TResult>
): WorkerWithMiddleware<TData, TResult> {
  const {
    name,
    processor,
    connection,
    prefix = "queue",
    concurrency,
    limiter,
    settings,
    middleware = [],
    ...options
  } = config;

  const workerOptions: WorkerOptions = {
    prefix,
    connection,
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(limiter === undefined ? {} : { limiter }),
    ...(settings === undefined ? {} : { settings }),
    ...options,
  };

  const middlewares = [...middleware];

  const wrappedProcessor: Processor<TData, TResult> = async (job, token, signal) => {
    let index = 0;

    const next = async (): Promise<TResult> => {
      if (index >= middlewares.length) {
        return processor(job, token, signal);
      }

      const currentMiddleware = middlewares[index++];
      return currentMiddleware(job, token, signal, next);
    };

    return next();
  };

  const worker = new Worker<TData, TResult>(name, wrappedProcessor, workerOptions) as WorkerWithMiddleware<TData, TResult>;

  worker.use = (middleware: JobMiddleware<TData, TResult>) => {
    middlewares.push(middleware);
    return worker;
  };

  return worker;
}

export async function pauseWorker(worker: Worker): Promise<void> {
  await worker.pause(true);
}

export async function resumeWorker(worker: Worker): Promise<void> {
  worker.resume();
}

export function isWorkerPaused(worker: Worker): boolean {
  return worker.isPaused();
}

export function isWorkerRunning(worker: Worker): boolean {
  return worker.isRunning();
}

export async function closeWorker(worker: Worker, force = false): Promise<void> {
  const workerConnection = (worker as unknown as { connection?: { _client?: { disconnect?(): void }; initializing?: Promise<unknown> } }).connection;
  if (workerConnection?.initializing) {
    await workerConnection.initializing.catch(() => undefined);
  }
  try {
    workerConnection?._client?.disconnect?.();
  } catch {
    /* ignore */
  }
  await worker.close(force);
}

export async function cancelWorkerJob(worker: Worker, jobId: string, reason?: string): Promise<boolean> {
  return worker.cancelJob(jobId, reason);
}

export async function cancelAllWorkerJobs(worker: Worker, reason?: string): Promise<void> {
  worker.cancelAllJobs(reason);
}

export type { WorkerOptions, Job, Processor } from "bullmq";
export { Worker } from "bullmq";
