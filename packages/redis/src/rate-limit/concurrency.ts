 
import { Redis } from "ioredis";
import { createSemaphoreManager } from "../coordination/semaphore.js";
import { createCoordinationKeyBuilder } from "../coordination/utils.js";
import { validatePositiveFinite } from "./internal/validation.js";
import type { ConcurrencyLimiterOptions } from "./types.js";
import { ConcurrencyAcquisitionError, RateLimitConfigError } from "./errors.js";


export class ConcurrencyLimiter {
  private readonly semaphore: ReturnType<typeof createSemaphoreManager>;
  private readonly resource: string;
  private readonly permits: number;
  private readonly leaseMs: number;
  private readonly timeoutMs: number;
  private readonly retryIntervalMs: number;
  private readonly failurePolicy: "fail-open" | "fail-closed";

  constructor(redis: Redis, options: ConcurrencyLimiterOptions) {
    validatePositiveFinite(options.maxConcurrency, "maxConcurrency");
    validatePositiveFinite(options.leaseMs, "leaseMs");
    this.resource = options.resource;
    this.permits = Math.floor(options.maxConcurrency);
    this.leaseMs = options.leaseMs;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.retryIntervalMs = options.retryIntervalMs ?? 50;
    this.failurePolicy = options.failurePolicy ?? "fail-closed";
    this.semaphore = createSemaphoreManager({ client: redis, keyBuilder: createCoordinationKeyBuilder(options.keyPrefix ?? "ratelimit"), defaultTimeoutMs: this.timeoutMs, defaultRetryIntervalMs: this.retryIntervalMs });
    void RateLimitConfigError;
  }

  async acquire(ownerId?: string): Promise<{ acquired: boolean; token?: string; retryAfterMs?: number | null; error?: string; fallback?: boolean }> {
    try {
      const r = await this.semaphore.acquire({ resource: this.resource, permits: this.permits, leaseMs: this.leaseMs, timeoutMs: this.timeoutMs, retryIntervalMs: this.retryIntervalMs, ownerId });
      if (!r.acquired) return { acquired: false, error: r.error ?? "limited", retryAfterMs: null };
      return { acquired: true, token: r.token, retryAfterMs: null };
    } catch (error) {
      if (this.failurePolicy === "fail-open") {
        return { acquired: true, token: "fallback-" + Date.now().toString(36), retryAfterMs: null, fallback: true, error: String(error) };
      }
      throw error;
    }
  }

  async tryAcquire(ownerId?: string): Promise<{ acquired: boolean; token?: string; error?: string; fallback?: boolean }> {
    try {
      const r = await this.semaphore.tryAcquire({ resource: this.resource, permits: this.permits, leaseMs: this.leaseMs, ownerId });
      if (!r.acquired) return { acquired: false, error: r.error ?? "limited" };
      return { acquired: true, token: r.token };
    } catch (error) {
      if (this.failurePolicy === "fail-open") {
        return { acquired: true, token: "fallback-" + Date.now().toString(36), fallback: true, error: String(error) };
      }
      throw error;
    }
  }

  async release(token: string): Promise<{ released: boolean; error?: string }> {
    return this.semaphore.release({ resource: this.resource, token });
  }

  async run<T>(fn: () => Promise<T>, ownerId?: string): Promise<T> {
    const acq = await this.acquire(ownerId);
    if (!acq.acquired || !acq.token) throw new ConcurrencyAcquisitionError();
    try {
      return await fn();
    } finally {
      if (acq.token) await this.release(acq.token).catch(() => {});
    }
  }
}

export function createConcurrencyLimiter(redis: Redis, options: ConcurrencyLimiterOptions): ConcurrencyLimiter {
  return new ConcurrencyLimiter(redis, options);
}
