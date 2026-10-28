 
import { RateLimiter } from "./limiter.js";
import type { RateLimitDecision } from "./types.js";

export class MultiRateLimiter {
  constructor(private readonly limiters: RateLimiter[]) {
    if (!limiters || limiters.length === 0) throw new Error("At least one limiter required");
  }
  async consume(resource: string, cost: number = 1): Promise<{ allowed: boolean; decisions: RateLimitDecision[]; retryAfterMs: number | null }> {
    const checks: RateLimitDecision[] = [];
    for (const limiter of this.limiters) {
      const d = await limiter.check(resource, cost);
      checks.push(d);
    }
    const anyDenied = checks.some((d) => !d.allowed);
    if (anyDenied) {
      let maxRetry: number | null = null;
      for (const dd of checks) {
        if (!dd.allowed && dd.retryAfterMs !== null && (maxRetry === null || dd.retryAfterMs > maxRetry)) maxRetry = dd.retryAfterMs;
      }
      return { allowed: false, decisions: checks, retryAfterMs: maxRetry };
    }
    const decisions: RateLimitDecision[] = [];
    let allAllowed = true;
    let maxRetry: number | null = null;
    for (const limiter of this.limiters) {
      const d = await limiter.consume(resource, cost);
      decisions.push(d);
      if (!d.allowed) {
        allAllowed = false;
        if (d.retryAfterMs !== null && (maxRetry === null || d.retryAfterMs > maxRetry)) maxRetry = d.retryAfterMs;
      }
    }
    return { allowed: allAllowed, decisions, retryAfterMs: maxRetry };
  }
  async check(resource: string, cost: number = 1): Promise<{ allowed: boolean; decisions: RateLimitDecision[]; retryAfterMs: number | null }> {
    const checks: RateLimitDecision[] = [];
    for (const limiter of this.limiters) {
      const d = await limiter.check(resource, cost);
      checks.push(d);
    }
    const anyDenied = checks.some((d) => !d.allowed);
    let maxRetry: number | null = null;
    for (const dd of checks) {
      if (!dd.allowed && dd.retryAfterMs !== null && (maxRetry === null || dd.retryAfterMs > maxRetry)) maxRetry = dd.retryAfterMs;
    }
    return { allowed: !anyDenied, decisions: checks, retryAfterMs: maxRetry };
  }
}

export function createMultiRateLimiter(limiters: RateLimiter[]): MultiRateLimiter {
  return new MultiRateLimiter(limiters);
}
