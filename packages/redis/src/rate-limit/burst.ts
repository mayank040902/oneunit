/* eslint-disable */
import { createRateLimiter } from "./limiter.js";
import { createConcurrencyLimiter } from "./concurrency.js";
import type { RateLimitDecision } from "./types.js";

export interface BurstProtectionOptions {
  sustainedLimit: number;
  sustainedIntervalMs: number;
  burstCapacity: number;
  burstIntervalMs: number;
  burstRefillRatePerSecond?: number;
  concurrencyLimit?: number;
  concurrencyLeaseMs?: number;
  keyPrefix?: string;
  failurePolicy?: "fail-open" | "fail-closed";
}

export interface BurstDecision {
  allowed: boolean;
  reason: string | null;
  retryAfterMs: number | null;
  metadata: Record<string, unknown>;
}

export class BurstProtector {
  private readonly sustained: ReturnType<typeof createRateLimiter>;
  private readonly burst: ReturnType<typeof createRateLimiter>;
  private readonly concurrency?: ReturnType<typeof createConcurrencyLimiter>;
  private readonly concurrencyResource: string;

  constructor(private readonly redis: any, options: BurstProtectionOptions) {
    const prefix = options.keyPrefix ?? "burst";
    this.sustained = createRateLimiter(redis, {
      algorithm: "fixed-window",
      limit: options.sustainedLimit,
      intervalMs: options.sustainedIntervalMs,
      keyPrefix: `${prefix}:sustained`,
      failurePolicy: options.failurePolicy,
    });
    this.burst = createRateLimiter(redis, {
      algorithm: "token-bucket",
      limit: options.burstCapacity,
      intervalMs: options.burstIntervalMs,
      keyPrefix: `${prefix}:burst`,
      tokenBucket: {
        capacity: options.burstCapacity,
        refillRatePerSecond: options.burstRefillRatePerSecond ?? options.burstCapacity / (options.burstIntervalMs / 1000),
        initialTokens: options.burstCapacity,
      },
      failurePolicy: options.failurePolicy,
    });
    if (options.concurrencyLimit !== undefined) {
      this.concurrencyResource = `${prefix}:concurrency`;
      this.concurrency = createConcurrencyLimiter(redis, {
        resource: this.concurrencyResource,
        maxConcurrency: options.concurrencyLimit,
        leaseMs: options.concurrencyLeaseMs ?? 5000,
        keyPrefix: prefix,
        failurePolicy: options.failurePolicy,
      });
    } else {
      this.concurrencyResource = "";
    }
  }

  async consume(resource: string, cost: number = 1, acquireConcurrency: boolean = false): Promise<BurstDecision & { concurrencyToken?: string }> {
    // Evaluate first to avoid partial consumption on denial.
    const sustainedCheck = await this.sustained.check(resource, cost);
    const burstCheck = await this.burst.check(resource, cost);
    // Don't pass ownerId - let semaphore generate unique token for each check
    const concurrencyCheck = this.concurrency ? await this.concurrency.tryAcquire() : { acquired: true, token: undefined };

    const decisions: Record<string, RateLimitDecision | { acquired: boolean; error?: string; token?: string }> = {
      sustained: sustainedCheck,
      burst: burstCheck,
      concurrency: concurrencyCheck as any,
    };

    let allowed = sustainedCheck.allowed && burstCheck.allowed && (this.concurrency ? concurrencyCheck.acquired : true);
    let reason: string | null = null;
    if (!sustainedCheck.allowed) reason = "sustained_limit";
    else if (!burstCheck.allowed) reason = "burst_limit";
    else if (this.concurrency && !concurrencyCheck.acquired) reason = "concurrency_limit";

    let retryAfterMs: number | null = null;
    for (const d of [sustainedCheck, burstCheck]) {
      if (d.retryAfterMs !== null && (retryAfterMs === null || d.retryAfterMs > retryAfterMs)) retryAfterMs = d.retryAfterMs;
    }

    // If allowed, commit consumption and reuse the already-acquired concurrency permit.
    let concurrencyToken: string | undefined;
    if (allowed) {
      await this.sustained.consume(resource, cost);
      await this.burst.consume(resource, cost);
      if (this.concurrency) {
        if (concurrencyCheck.token) concurrencyToken = concurrencyCheck.token;
        else {
          const acq = await this.concurrency.acquire();
          if (!acq.acquired) { allowed = false; reason = "concurrency_limit"; }
          else concurrencyToken = acq.token;
        }
      }
    } else if (concurrencyCheck.token && this.concurrency) {
      // release a permit acquired only for evaluation when a rate policy denied the request
      await this.concurrency.release(concurrencyCheck.token).catch(() => {});
    }

    return {
      allowed,
      reason,
      retryAfterMs,
      metadata: decisions,
      concurrencyToken,
    };
  }

  async releaseConcurrency(token: string): Promise<void> {
    if (!this.concurrency) return;
    await this.concurrency.release(token);
  }
}

export function createBurstProtector(redis: any, options: BurstProtectionOptions): BurstProtector {
  return new BurstProtector(redis, options);
}
