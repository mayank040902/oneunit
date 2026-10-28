 
import type { Logger } from "../logger.js";
import { Redis } from "ioredis";

export type RateLimitAlgorithm = "fixed-window" | "sliding-window" | "token-bucket" | "leaky-bucket";

export interface RateLimitDecision {
  allowed: boolean;
  algorithm: RateLimitAlgorithm;
  limit: number;
  remaining: number;
  consumed: number;
  retryAfterMs: number | null;
  resetAt: number | null;
  resetAfterMs: number | null;
  reason: string | null;
  fallback: boolean;
  metadata?: Record<string, unknown>;
}

export interface RateLimiterOptions {
  algorithm: RateLimitAlgorithm;
  limit: number;
  intervalMs: number;
  keyPrefix?: string;
  logger?: Logger;
  failurePolicy?: "fail-open" | "fail-closed";
  redisClientOwner?: "caller" | "component";
  tokenBucket?: {
    capacity?: number;
    refillRatePerSecond?: number;
    initialTokens?: number;
  };
  leakyBucket?: {
    capacity?: number;
    leakRatePerSecond?: number;
  };
  costUnit?: number;
}

export interface QuotaOptions {
  resource: string;
  quota: number;
  period: "daily" | "monthly" | "custom";
  customPeriodMs?: number;
  timezone?: string;
  weight?: number;
  keyPrefix?: string;
  logger?: Logger;
  failurePolicy?: "fail-open" | "fail-closed";
}

export interface ConcurrencyLimiterOptions {
  resource: string;
  maxConcurrency: number;
  leaseMs: number;
  keyPrefix?: string;
  logger?: Logger;
  failurePolicy?: "fail-open" | "fail-closed";
  timeoutMs?: number;
  retryIntervalMs?: number;
}

export interface AdaptiveThrottlingOptions {
  minLimit: number;
  maxLimit: number;
  samplingIntervalMs?: number;
  maxAdjustmentPerStep?: number;
  hysteresis?: number;
  recoveryStep?: number;
}

export interface LoadSheddingOptions {
  maxInFlight: number;
  SheddingMode?: "priority" | "fifo";
  queueDepthThreshold?: number;
  maxQueueWaitMs?: number;
}

export interface BackpressureOptions {
  maxPending: number;
  maxWaitMs?: number;
  admissionTimeoutMs?: number;
}

export { Redis };
