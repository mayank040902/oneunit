/* eslint-disable */
import { Redis } from "ioredis";
import type { Logger } from "../logger.js";
import { createCoordinationKeyBuilder } from "./utils.js";
import { generateOwnershipToken } from "./utils.js";

// Reuse utils exports
import {
  validateLeaseDuration,
  validateTimeout,
  validateRetryInterval,
  validateResource,
  sleep,
  isAbortError,
  validateToken,
} from "./utils.js";
import {
  LockContendedError,
  LockTimeoutError,
  LockOwnershipError,
  LockRenewalError,
  CoordinationCancelledError,
} from "./errors.js";
import type {
  LockAcquireResult,
  LockAcquireOptions,
  LockTryOptions,
  LockRenewOptions,
  LockReleaseOptions,
  LockStatus,
  LockRenewResult,
  LockReleaseResult,
} from "./types.js";
import { nowMsLua } from "./scripts.js";

// avoid duplicate import confusion

const ACQUIRE_LUA = `
local now = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)
local token = redis.call('HGET', KEYS[1], 'token')
local expires = redis.call('HGET', KEYS[1], 'expires')
if token and expires and tonumber(expires) > now then
  return {0, token}
end
local fencing = redis.call('HGET', KEYS[1], 'fencing')
if not fencing then fencing = '0' end
fencing = tonumber(fencing) + 1
redis.call('HSET', KEYS[1], 'token', ARGV[1], 'expires', tostring(now + tonumber(ARGV[2])), 'fencing', tostring(fencing))
return {1, ARGV[1], fencing, tonumber(ARGV[2])}
`;

const RENEW_LUA = `
local now = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)
local token = redis.call('HGET', KEYS[1], 'token')
if not token or token ~= ARGV[1] then
  return {0, 'ownership_lost'}
end
local expires = redis.call('HGET', KEYS[1], 'expires')
if not expires or tonumber(expires) <= now then
  return {0, 'expired'}
end
local newExpires = now + tonumber(ARGV[2])
redis.call('HSET', KEYS[1], 'expires', tostring(newExpires))
local fencing = redis.call('HGET', KEYS[1], 'fencing')
return {1, fencing, tonumber(ARGV[2])}
`;

const RELEASE_LUA = `
local token = redis.call('HGET', KEYS[1], 'token')
if not token then
  return {1}
end
if token ~= ARGV[1] then
  return {0, token}
end
redis.call('HDEL', KEYS[1], 'token', 'expires')
return {1}
`;

const STATUS_LUA = `
local token = redis.call('HGET', KEYS[1], 'token')
local expires = redis.call('HGET', KEYS[1], 'expires')
local fencing = redis.call('HGET', KEYS[1], 'fencing')
local now = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)
return {token, expires, fencing, now}
`;

export interface LeaseManager {
  acquire(opts: LockAcquireOptions): Promise<LockAcquireResult>;
  tryAcquire(opts: LockTryOptions): Promise<LockAcquireResult>;
  renew(opts: LockRenewOptions): Promise<LockRenewResult>;
  release(opts: LockReleaseOptions): Promise<LockReleaseResult>;
  getStatus(resource: string): Promise<LockStatus>;
}

export interface CreateLeaseManagerOptions {
  client: Redis;
  keyBuilder: ReturnType<typeof createCoordinationKeyBuilder>;
  defaultLeaseMs: number;
  defaultTimeoutMs: number;
  defaultRetryIntervalMs: number;
  keyFn?: (resource: string) => string;
  logger?: Logger;
}

export function createLeaseManager(opts: CreateLeaseManagerOptions): LeaseManager {
  const { client, keyBuilder, defaultTimeoutMs, defaultRetryIntervalMs, logger } = opts;
  const keyFn = opts.keyFn ?? ((resource: string) => keyBuilder.lock(resource));

  async function luaAcquire(key: string, token: string, leaseMs: number): Promise<LockAcquireResult> {
    const res = await (client as any).eval(ACQUIRE_LUA, 1, key, token, leaseMs) as any[];
    if (!Array.isArray(res)) {
      return { acquired: false, error: "Unexpected Lua result" };
    }
    if (res[0] === 0 || res[0] === false) {
      return { acquired: false, error: "contended", ... (res[1] ? { } : {}) };
    }
    return {
      acquired: true,
      token: String(res[1]),
      fencingToken: Number(res[2]),
      ttlMs: Number(res[3]),
    };
  }

  async function tryAcquireInternal(resource: string, leaseMs: number, token: string): Promise<LockAcquireResult> {
    validateResource(resource);
    validateLeaseDuration(leaseMs);
    const key = keyFn(resource);
    return luaAcquire(key, token, leaseMs);
  }

  async function acquire(resource: string, opts2: { leaseMs: number; timeoutMs?: number; retryIntervalMs?: number; signal?: AbortSignal; token?: string }) {
    validateResource(resource);
    validateLeaseDuration(opts2.leaseMs);
    validateTimeout(opts2.timeoutMs);
    validateRetryInterval(opts2.retryIntervalMs);
    const timeoutMs = opts2.timeoutMs ?? defaultTimeoutMs;
    const retryIntervalMs = opts2.retryIntervalMs ?? defaultRetryIntervalMs;
    const token = opts2.token ?? generateOwnershipToken();
    const key = keyFn(resource);
    const deadline = performance.now() + timeoutMs;

    while (true) {
      if (opts2.signal?.aborted) {
        throw new CoordinationCancelledError("Acquisition cancelled", resource);
      }
      const result = await luaAcquire(key, token, opts2.leaseMs);
      if (opts2.signal?.aborted && result.acquired) {
        await (client as any).eval(RELEASE_LUA, 1, key, token).catch(() => {});
        throw new CoordinationCancelledError("Acquisition cancelled", resource);
      }
      if (result.acquired) return result;
      // contention
      if (performance.now() >= deadline) {
        throw new LockTimeoutError("Lock acquisition timed out", resource, timeoutMs);
      }
      if (opts2.signal?.aborted) {
        // command may have succeeded already; resolve ownership
        const st = await getStatusNoThrow(resource);
        if (st.exists && st.owner === token) {
          // release silently
          await (client as any).eval(RELEASE_LUA, 1, key, token).catch(() => {});
          throw new CoordinationCancelledError("Acquisition cancelled", resource);
        }
        throw new CoordinationCancelledError("Acquisition cancelled", resource);
      }
      await sleep(Math.min(retryIntervalMs, Math.max(1, deadline - performance.now())), opts2.signal);
    }
  }

  async function getStatusNoThrow(resource: string): Promise<LockStatus> {
    try {
      return await getStatus(resource);
    } catch {
      return { exists: false, ttlMs: 0 };
    }
  }

  async function getStatus(resource: string): Promise<LockStatus> {
    validateResource(resource);
    const key = keyFn(resource);
    const res = (await (client as any).eval(STATUS_LUA, 1, key)) as any[];
    const token = res[0] === null ? undefined : (res[0] ? String(res[0]) : undefined);
    const expires = res[1] ? Number(res[1]) : undefined;
    const fencing = res[2] ? Number(res[2]) : undefined;
    const now = Number(res[3]);
    let ttlMs: number | undefined;
    if (expires !== undefined) ttlMs = Math.max(0, expires - now);
    const exists = !!(token && expires && expires > now);
    return { exists, owner: token, ttlMs, fencingToken: fencing };
  }

  const manager: LeaseManager = {
    async acquire(opts: LockAcquireOptions): Promise<LockAcquireResult> {
      try {
        return await acquire(opts.resource, {
          leaseMs: opts.leaseMs,
          timeoutMs: opts.timeoutMs,
          retryIntervalMs: opts.retryIntervalMs,
          signal: opts.signal,
          token: opts.ownerId ?? undefined,
        });
      } catch (err) {
        if (err instanceof LockTimeoutError) {
          return { acquired: false, error: err.message };
        }
        if (err instanceof CoordinationCancelledError) {
          return { acquired: false, error: "cancelled" };
        }
        throw err;
      }
    },
    async tryAcquire(opts: LockTryOptions): Promise<LockAcquireResult> {
      validateResource(opts.resource);
      validateLeaseDuration(opts.leaseMs);
      const token = opts.ownerId ?? generateOwnershipToken();
      const key = keyFn(opts.resource);
      return luaAcquire(key, token, opts.leaseMs);
    },
    async renew(opts: LockRenewOptions): Promise<LockRenewResult> {
      validateResource(opts.resource);
      validateLeaseDuration(opts.leaseMs);
      validateToken(opts.token);
      const key = keyFn(opts.resource);
      const res = (await (client as any).eval(RENEW_LUA, 1, key, opts.token, opts.leaseMs)) as any[];
      if (!Array.isArray(res) || res[0] === 0 || res[0] === false) {
        const reason = String(res?.[1] ?? "unknown");
        let r: "expired" | "ownership_lost" | "timeout" | "unknown" = "unknown";
        if (reason === "expired") r = "expired";
        else if (reason === "ownership_lost") r = "ownership_lost";
        return { renewed: false, error: reason };
      }
      return { renewed: true, ttlMs: Number(res[2]) };
    },
    async release(opts: LockReleaseOptions): Promise<LockReleaseResult> {
      validateResource(opts.resource);
      validateToken(opts.token);
      const key = keyFn(opts.resource);
      const res = (await (client as any).eval(RELEASE_LUA, 1, key, opts.token)) as any[];
      if (Array.isArray(res) && (res[0] === 0 || res[0] === false)) {
        return { released: false, error: "ownership mismatch" };
      }
      return { released: true };
    },
    async getStatus(resource: string): Promise<LockStatus> {
      return getStatus(resource);
    },
  };

  return manager;
}

export { createLeaseManager as createLockManagerInternal };
