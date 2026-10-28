/* eslint-disable @typescript-eslint/no-explicit-any */
import { Redis } from "ioredis";
import { normalizeLogger, type Logger } from "../logger.js";
import type { RateLimiterOptions, RateLimitDecision, RateLimitAlgorithm } from "./types.js";
import { runLua, FIXED_CONSUMER_LUA, SLIDING_CONSUMER_LUA, TOKEN_BUCKET_LUA, LEAKY_BUCKET_LUA } from "./scripts.js";
import { rateLimitKey } from "./internal/keys.js";
import { validatePositiveFinite, validateWeight } from "./internal/validation.js";
import { RateLimitConfigError } from "./errors.js";

const DEFAULT_KEY_PREFIX = "ratelimit";

function randomUniq(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class RateLimiter {
  private readonly redis: Redis;
  private readonly opts: RateLimiterOptions;
  private readonly logger: Logger | undefined;
  private readonly prefix: string;

  constructor(redis: Redis, options: RateLimiterOptions) {
    if (!redis) throw new RateLimitConfigError("Redis client is required", "redis");
    validatePositiveFinite(options.limit, "limit");
    validatePositiveFinite(options.intervalMs, "intervalMs");
    if (options.tokenBucket?.capacity !== undefined) validatePositiveFinite(options.tokenBucket.capacity, "tokenBucket.capacity");
    if (options.tokenBucket?.refillRatePerSecond !== undefined) validatePositiveFinite(options.tokenBucket.refillRatePerSecond, "tokenBucket.refillRatePerSecond");
    if (options.leakyBucket?.capacity !== undefined) validatePositiveFinite(options.leakyBucket.capacity, "leakyBucket.capacity");
    if (options.leakyBucket?.leakRatePerSecond !== undefined) validatePositiveFinite(options.leakyBucket.leakRatePerSecond, "leakyBucket.leakRatePerSecond");
    if (options.costUnit !== undefined) validatePositiveFinite(options.costUnit, "costUnit");
    const alg = options.algorithm;
    if (!["fixed-window", "sliding-window", "token-bucket", "leaky-bucket"].includes(alg)) {
      throw new RateLimitConfigError("Unsupported algorithm", "algorithm");
    }
    this.redis = redis;
    this.opts = options;
    this.logger = normalizeLogger(options.logger);
    this.prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  get algorithm(): RateLimitAlgorithm {
    return this.opts.algorithm;
  }

  private key(resource: string, suffix?: string): string {
    return rateLimitKey(this.prefix, resource, suffix ? `${this.opts.algorithm}:${suffix}` : this.opts.algorithm);
  }

  private tokenBucketConfig() {
    const cap = this.opts.tokenBucket?.capacity ?? this.opts.limit;
    const refill = this.opts.tokenBucket?.refillRatePerSecond ?? this.opts.limit / (this.opts.intervalMs / 1000);
    const initial = this.opts.tokenBucket?.initialTokens ?? cap;
    return { cap, refill, initial };
  }

  private leakyBucketConfig() {
    const cap = this.opts.leakyBucket?.capacity ?? this.opts.limit;
    const leak = this.opts.leakyBucket?.leakRatePerSecond ?? this.opts.limit / (this.opts.intervalMs / 1000);
    return { cap, leak };
  }

  async consume(resource: string, cost: number = 1, mode: "consume" | "check" = "consume"): Promise<RateLimitDecision> {
    validateWeight(cost);
    const failOpen = this.opts.failurePolicy === "fail-open";
    try {
      if (this.opts.algorithm === "fixed-window") {
        return await this.fixedWindow(resource, cost, mode);
      }
      if (this.opts.algorithm === "sliding-window") {
        return await this.slidingWindow(resource, cost, mode);
      }
      if (this.opts.algorithm === "token-bucket") {
        const { cap, refill, initial } = this.tokenBucketConfig();
        return await this.tokenBucket(resource, cost, mode, cap, refill, initial);
      }
      const { cap, leak } = this.leakyBucketConfig();
      return await this.leakyBucket(resource, cost, mode, cap, leak);
    } catch (error) {
      if (failOpen) {
        return {
          allowed: true,
          algorithm: this.opts.algorithm,
          limit: this.opts.limit,
          remaining: this.opts.limit,
          consumed: 0,
          retryAfterMs: null,
          resetAt: null,
          resetAfterMs: null,
          reason: "fallback",
          fallback: true,
          metadata: { error: String(error) },
        };
      }
      throw error;
    }
  }

  check(resource: string, cost: number = 1): Promise<RateLimitDecision> {
    return this.consume(resource, cost, "check");
  }

  async reset(resource: string): Promise<void> {
    await this.redis.del(this.key(resource));
  }

  private async fixedWindow(resource: string, cost: number, mode: "consume" | "check"): Promise<RateLimitDecision> {
    const key = this.key(resource);
    const raw = (await runLua(this.redis, FIXED_CONSUMER_LUA, [key], [this.opts.intervalMs, this.opts.limit, cost, mode])) as any[];
    if (!Array.isArray(raw)) throw new Error("Unexpected Lua result");
    const allowed = Number(raw[0]) === 1;
    const current = Number(raw[1]);
    const reset = Number(raw[2]);
    const ttl = Number(raw[3]);
    const reason = String(raw[4]);
    const remaining = Math.max(0, this.opts.limit - current);
    return {
      allowed,
      algorithm: "fixed-window",
      limit: this.opts.limit,
      remaining,
      consumed: allowed && mode === "consume" ? cost : 0,
      retryAfterMs: allowed ? null : Math.max(0, ttl),
      resetAt: reset,
      resetAfterMs: Math.max(0, ttl),
      reason: allowed ? null : reason,
      fallback: false,
      metadata: { current },
    };
  }

  private async slidingWindow(resource: string, cost: number, mode: "consume" | "check"): Promise<RateLimitDecision> {
    const key = this.key(resource);
    const uniq = randomUniq();
    const raw = (await runLua(this.redis, SLIDING_CONSUMER_LUA, [key], [this.opts.intervalMs, this.opts.limit, cost, mode, uniq])) as any[];
    if (!Array.isArray(raw)) throw new Error("Unexpected Lua result");
    const allowed = Number(raw[0]) === 1;
    const total = Number(raw[1]);
    const reset = Number(raw[2]);
    const retryAfter = Number(raw[3]);
    void reset;
    const reason = String(raw[4]);
    // remaining after consumption (Lua returns the post-commit total on consume, current total on check):
    const effectiveTotal = allowed && mode === "check" ? total + cost : total;
    const rem = Math.max(0, this.opts.limit - effectiveTotal);
    return {
      allowed,
      algorithm: "sliding-window",
      limit: this.opts.limit,
      remaining: rem,
      consumed: allowed && mode === "consume" ? cost : 0,
      retryAfterMs: allowed ? null : Math.max(0, retryAfter),
      resetAt: reset,
      resetAfterMs: Math.max(0, reset - Date.now()),
      reason: allowed ? null : reason,
      fallback: false,
      metadata: { approximate: false, current: total },
    };
  }

  private async tokenBucket(resource: string, cost: number, mode: "consume" | "check", cap: number, refillPerSec: number, initial: number): Promise<RateLimitDecision> {
    const key = this.key(resource);
    const refillPerMs = refillPerSec / 1000;
    const raw = (await runLua(this.redis, TOKEN_BUCKET_LUA, [key], [cap, refillPerMs, cost, mode, initial])) as any[];
    if (!Array.isArray(raw)) throw new Error("Unexpected Lua result");
    const allowed = Number(raw[0]) === 1;
    const remaining = Number(raw[1]);
    const reset = Number(raw[2]);
    const retryAfter = Number(raw[3]);
    void reset;
    const reason = String(raw[4]);
    return {
      allowed,
      algorithm: "token-bucket",
      limit: cap,
      remaining,
      consumed: allowed && mode === "consume" ? cost : 0,
      retryAfterMs: allowed ? null : Math.max(0, retryAfter),
      resetAt: null,
      resetAfterMs: null,
      reason: allowed ? null : reason,
      fallback: false,
      metadata: { resetHint: reset },
    };
  }

  private async leakyBucket(resource: string, cost: number, mode: "consume" | "check", cap: number, leakPerSec: number): Promise<RateLimitDecision> {
    const key = this.key(resource);
    const leakPerMs = leakPerSec / 1000;
    const raw = (await runLua(this.redis, LEAKY_BUCKET_LUA, [key], [cap, leakPerMs, cost, mode])) as any[];
    if (!Array.isArray(raw)) throw new Error("Unexpected Lua result");
    const allowed = Number(raw[0]) === 1;
    const remaining = Number(raw[1]);
    const reset = Number(raw[2]);
    const retryAfter = Number(raw[3]);
    void reset;
    const reason = String(raw[4]);
    return {
      allowed,
      algorithm: "leaky-bucket",
      limit: cap,
      remaining,
      consumed: allowed && mode === "consume" ? cost : 0,
      retryAfterMs: allowed ? null : Math.max(0, retryAfter),
      resetAt: null,
      resetAfterMs: null,
      reason: allowed ? null : reason,
      fallback: false,
      metadata: {},
    };
  }
}

export function createRateLimiter(redis: Redis, options: RateLimiterOptions): RateLimiter {
  return new RateLimiter(redis, options);
}

export * from "./types.js";
export * from "./errors.js";
