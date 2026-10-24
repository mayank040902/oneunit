import { performance } from "node:perf_hooks";
import { type Redis as RedisClient } from "ioredis";
import { redactError } from "./events.js";

export interface HealthResult {
  status: "up" | "down";
  latency: {
    value: number;
    unit: "ms";
  };
  error?: string;
}

export interface HealthOptions {
  /**
   * Milliseconds to wait for PING before reporting `down`. ioredis queues
   * commands while reconnecting, so without a bound a PING against an
   * unreachable server never settles and health checks hang forever.
   */
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 1000;

export async function health(
  client: RedisClient,
  options: HealthOptions = {},
): Promise<HealthResult> {
  const requested = options.timeout ?? DEFAULT_TIMEOUT_MS;
  // setTimeout coerces negatives to 1 and NaN to 1, and Node prints a
  // TimeoutNegativeWarning/TimeoutNaNWarning for each. Treat any invalid
  // budget as "no bound configured" rather than leaking warnings per call.
  const timeout =
    Number.isFinite(requested) && requested > 0
      ? requested
      : DEFAULT_TIMEOUT_MS;
  const start = performance.now();

  const elapsed = (): number => Math.round(performance.now() - start);

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Health check timed out after ${timeout}ms`));
    }, timeout);
  });

  try {
    await Promise.race([client.ping(), expiry]);

    return {
      status: "up",
      latency: {
        value: elapsed(),
        unit: "ms",
      },
    };
  } catch (error) {
    return {
      status: "down",
      latency: {
        value: elapsed(),
        unit: "ms",
      },
      error:
        redactError(error) instanceof Error
          ? (redactError(error) as Error).message
          : String(redactError(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}
