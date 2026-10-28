/* eslint-disable */
import { Redis } from "ioredis";
import { rateLimitKey } from "./internal/keys.js";
import { validatePositiveFinite } from "./internal/validation.js";
import { nextDailyBoundaryUtcMs, nextMonthlyBoundaryUtcMs } from "./internal/time.js";

export interface QuotaDecision {
  allowed: boolean;
  resource: string;
  quota: number;
  consumed: number;
  used: number;
  remaining: number;
  period: string;
  retryAfterMs: number | null;
  resetAt: number | null;
  reason: string | null;
  fallback: boolean;
}

export interface QuotaConfig {
  resource: string;
  quota: number;
  period: "daily" | "monthly" | "custom";
  customPeriodMs?: number;
  weight?: number;
  keyPrefix?: string;
  failurePolicy?: "fail-open" | "fail-closed";
  logger?: any;
}

const QUOTA_LUA = `
local key = KEYS[1]
local quota = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])
local current = redis.call('GET', key)
if not current then current = '0' end
current = tonumber(current)
if current + amount > quota then
  return {0, current}
end
current = current + amount
redis.call('SET', key, tostring(current), 'PX', ttlMs)
return {1, current}
`;

export class Quota {
  private readonly redis: Redis;
  private readonly config: QuotaConfig;

  constructor(redis: Redis, config: QuotaConfig) {
    if (!redis) throw new Error("Redis client is required");
    validatePositiveFinite(config.quota, "quota");
    if (config.period === "custom") {
      if (!config.customPeriodMs || config.customPeriodMs <= 0) throw new Error("customPeriodMs required");
    }
    this.redis = redis;
    this.config = config;
  }

  private key(resource: string): string {
    return rateLimitKey(this.config.keyPrefix ?? "quota", resource, "quota");
  }

  periodWindow(nowMs: number): { resetAt: number; ttlMs: number } {
    let resetAt: number;
    if (this.config.period === "daily") resetAt = nextDailyBoundaryUtcMs(nowMs);
    else if (this.config.period === "monthly") resetAt = nextMonthlyBoundaryUtcMs(nowMs);
    else resetAt = nowMs + (this.config.customPeriodMs as number);
    return { resetAt, ttlMs: Math.max(1, resetAt - nowMs) };
  }

  async consume(resource: string, amount: number = 1): Promise<QuotaDecision> {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be positive finite");
    const w = this.config.weight ?? 1;
    const now = Date.now();
    const { resetAt, ttlMs } = this.periodWindow(now);
    const key = this.key(resource);
    const failOpen = this.config.failurePolicy === "fail-open";
    try {
      const raw = await (this.redis as any).eval(QUOTA_LUA, 1, key, this.config.quota, amount * w, ttlMs);
      // fallback if eval not available (should not happen)
      if (!Array.isArray(raw)) throw new Error("Unexpected quota result");
      const allowed = Number(raw[0]) === 1;
      const used = Number(raw[1]);
      const remaining = Math.max(0, this.config.quota - used);
      return {
        allowed,
        resource,
        quota: this.config.quota,
        consumed: allowed ? amount * w : 0,
        used,
        remaining,
        period: this.config.period,
        retryAfterMs: allowed ? null : Math.max(0, resetAt - Date.now()),
        resetAt,
        reason: allowed ? null : "quota_exhausted",
        fallback: false,
      };
    } catch (error) {
      if (failOpen) {
        return {
          allowed: true,
          resource,
          quota: this.config.quota,
          consumed: 0,
          used: 0,
          remaining: this.config.quota,
          period: this.config.period,
          retryAfterMs: null,
          resetAt,
          reason: "fallback",
          fallback: true,
        };
      }
      throw error;
    }
  }
}

export function createQuota(redis: Redis, config: QuotaConfig): Quota {
  return new Quota(redis, config);
}
