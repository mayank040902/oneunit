/* eslint-disable */
import { Redis } from "ioredis";
import type { Logger } from "../logger.js";
import { createCoordinationKeyBuilder, resolveCoordinationConfig } from "./utils.js";
import {
  generateOwnershipToken,
  validateLeaseDuration,
  validateTimeout,
  validateRetryInterval,
  validateResource,
  validatePermits,
  sleep,
  validateToken,
} from "./utils.js";
import type {
  SemaphoreAcquireResult,
  SemaphoreAcquireOptions,
  SemaphoreTryOptions,
  SemaphoreRenewOptions,
  SemaphoreReleaseOptions,
  SemaphoreStatus,
  SemaphoreReleaseResult,
} from "./types.js";

const ACQUIRE_LUA = `
local key = KEYS[1]
local fencingKey = KEYS[2]
local permits = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])
local token = ARGV[3]
local now = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)
-- remove expired permits
local members = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
local i = 1
while i <= #members do
  local m = members[i]
  local score = tonumber(members[i+1])
  if score <= now then
    redis.call('ZREM', key, m)
  end
  i = i + 2
end
local count = redis.call('ZCARD', key)
if count >= permits then
  return {0, count, permits - count}
end
local expires = now + leaseMs
redis.call('ZADD', key, expires, token)
local fencing = redis.call('GET', fencingKey)
if not fencing then fencing = '0' end
fencing = tonumber(fencing) + 1
redis.call('SET', fencingKey, tostring(fencing))
redis.call('PEXPIRE', key, leaseMs + 1000)
redis.call('PEXPIRE', fencingKey, leaseMs + 1000)
return {1, token, fencing, expires - now, permits - count - 1}
`;

const RENEW_LUA = `
local key = KEYS[1]
local token = ARGV[1]
local leaseMs = tonumber(ARGV[2])
local now = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)
local score = redis.call('ZSCORE', key, token)
if not score or tonumber(score) <= now then
  return {0, 'expired_or_lost'}
end
local expires = now + leaseMs
redis.call('ZADD', key, expires, token)
redis.call('PEXPIRE', key, leaseMs + 1000)
return {1, expires - now}
`;

const RELEASE_LUA = `
local key = KEYS[1]
local token = ARGV[1]
local removed = redis.call('ZREM', key, token)
return {removed}
`;

export interface SemaphoreManager {
  acquire(opts: SemaphoreAcquireOptions): Promise<SemaphoreAcquireResult>;
  tryAcquire(opts: SemaphoreTryOptions): Promise<SemaphoreAcquireResult>;
  renew(opts: SemaphoreRenewOptions): Promise<{ renewed: boolean; ttlMs?: number; error?: string }>;
  release(opts: SemaphoreReleaseOptions): Promise<SemaphoreReleaseResult>;
  getStatus(resource: string, permits: number): Promise<SemaphoreStatus>;
}

export interface CreateSemaphoreManagerOptions {
  client: Redis;
  keyBuilder: ReturnType<typeof createCoordinationKeyBuilder>;
  defaultTimeoutMs: number;
  defaultRetryIntervalMs: number;
  logger?: Logger;
}

function createSemaphoreManagerImpl(opts: CreateSemaphoreManagerOptions): SemaphoreManager {
  const { client, keyBuilder, defaultTimeoutMs, defaultRetryIntervalMs } = opts;

  async function luaAcquire(resource: string, permits: number, leaseMs: number, token: string): Promise<SemaphoreAcquireResult> {
    validateResource(resource);
    validatePermits(permits);
    validateLeaseDuration(leaseMs);
    const key = keyBuilder.semaphore(resource);
    const fencingKey = keyBuilder.semaphoreFencing(resource);
    const res = (await (client as any).eval(ACQUIRE_LUA, 2, key, fencingKey, permits, leaseMs, token)) as any[];
    if (!Array.isArray(res)) return { acquired: false, error: "Unexpected result" };
    if (res[0] === 0 || res[0] === false) {
      const count = Number(res[1] ?? 0);
      return { acquired: false, availablePermits: permits - count, error: "exhausted" };
    }
    return {
      acquired: true,
      token: String(res[1]),
      fencingToken: Number(res[2]),
      ttlMs: Number(res[3]),
      availablePermits: Number(res[4]),
    };
  }

  const manager: SemaphoreManager = {
    async acquire(o: SemaphoreAcquireOptions): Promise<SemaphoreAcquireResult> {
      validateResource(o.resource);
      validatePermits(o.permits);
      validateLeaseDuration(o.leaseMs);
      validateTimeout(o.timeoutMs);
      validateRetryInterval(o.retryIntervalMs);
      const timeoutMs = o.timeoutMs ?? defaultTimeoutMs;
      const retryIntervalMs = o.retryIntervalMs ?? defaultRetryIntervalMs;
      const token = o.ownerId ?? generateOwnershipToken();
      const deadline = performance.now() + timeoutMs;
      while (true) {
        if (o.signal?.aborted) {
          return { acquired: false, error: "cancelled" };
        }
        const r = await luaAcquire(o.resource, o.permits, o.leaseMs, token);
        if (r.acquired) return r;
        if (performance.now() >= deadline) {
          throw new (await import("./errors.js")).SemaphoreTimeoutError("Semaphore acquisition timed out", o.resource, timeoutMs);
        }
        await sleep(Math.min(retryIntervalMs, Math.max(1, deadline - performance.now())), o.signal);
      }
    },
    async tryAcquire(o: SemaphoreTryOptions): Promise<SemaphoreAcquireResult> {
      validateResource(o.resource);
      validatePermits(o.permits);
      validateLeaseDuration(o.leaseMs);
      const token = o.ownerId ?? generateOwnershipToken();
      return luaAcquire(o.resource, o.permits, o.leaseMs, token);
    },
    async renew(o: SemaphoreRenewOptions): Promise<{ renewed: boolean; ttlMs?: number; error?: string }> {
      validateResource(o.resource);
      validateLeaseDuration(o.leaseMs);
      validateToken(o.token);
      const key = keyBuilder.semaphore(o.resource);
      const res = (await (client as any).eval(RENEW_LUA, 1, key, o.token, o.leaseMs)) as any[];
      if (!Array.isArray(res) || res[0] === 0) {
        return { renewed: false, error: String(res?.[1] ?? "failed") };
      }
      return { renewed: true, ttlMs: Number(res[1]) };
    },
    async release(o: SemaphoreReleaseOptions): Promise<SemaphoreReleaseResult> {
      validateResource(o.resource);
      validateToken(o.token);
      const key = keyBuilder.semaphore(o.resource);
      const res = (await (client as any).eval(RELEASE_LUA, 1, key, o.token)) as any[];
      const removed = Number(res?.[0] ?? 0) === 1;
      // count
      // cleanup expired not strictly; return available unknown? query zcard
      const card = await client.zcard(key).catch(() => 0);
      // total permits unknown here; available approximate by card? We don't know total. Return undefined permits maybe.
      return { released: removed, availablePermits: undefined };
    },
    async getStatus(resource: string, permits: number): Promise<SemaphoreStatus> {
      validateResource(resource);
      validatePermits(permits);
      const key = keyBuilder.semaphore(resource);
      const now = Date.now();
      // remove expired via Lua? Use client zremrangebyscore
      await client.zremrangebyscore(key, "-inf", now).catch(() => {});
      const members = await client.zrange(key, 0, -1, "WITHSCORES");
      const holders: any[] = [];
      for (let i = 0; i < members.length; i += 2) {
        holders.push({ token: members[i], expiresAt: Number(members[i + 1]) });
      }
      return {
        totalPermits: permits,
        availablePermits: Math.max(0, permits - holders.length),
        holders,
      };
    },
  };

  // ensure token import exists
  void generateOwnershipToken;

  return manager;
}


function __toConfig(input: any, options?: any) { return (input && typeof input.eval === "function") ? { client: input, ...(options || {}) } : (options ? { ...input, ...options } : input); }
export function createSemaphoreManager(input: any, options?: any) {
  const resolved = resolveCoordinationConfig(__toConfig(input, options));
  return createSemaphoreManagerImpl({
    client: resolved.client,
    keyBuilder: resolved.keyBuilder,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });
}
