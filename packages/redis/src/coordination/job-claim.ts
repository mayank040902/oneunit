/* eslint-disable */
import { Redis } from "ioredis";
import { createCoordinationKeyBuilder, resolveCoordinationConfig } from "./utils.js";
import { generateOwnershipToken, validateResource, validateLeaseDuration, validateTimeout, validateRetryInterval, sleep, validateToken } from "./utils.js";
import type { Logger } from "../logger.js";
import type {
  JobClaimResult,
  JobClaimOptions,
  JobCompleteOptions,
  JobReleaseOptions,
  JobClaimStatus,
} from "./types.js";

const CLAIM_LUA = `
local key = KEYS[1]
local token = ARGV[1]
local leaseMs = tonumber(ARGV[2])
local claimantId = ARGV[3]
local now = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)
local status = redis.call('HGET', key, 'status')
local expires = redis.call('HGET', key, 'expires')
local curToken = redis.call('HGET', key, 'token')
-- if completed or failed, return status
if status == 'completed' then
  return {2, 'completed'}
end
if status == 'failed' then
  return {3, 'failed'}
end
if curToken and expires and tonumber(expires) > now then
  -- already claimed by someone else
  if curToken ~= token then
    return {0, 'claimed', curToken, tonumber(expires)}
  end
end
-- claim (or reclaim expired)
local fencing = redis.call('HGET', key, 'fencing')
if not fencing then fencing = '0' end
fencing = tonumber(fencing) + 1
redis.call('HSET', key, 'token', token, 'claimant', claimantId, 'expires', tostring(now + leaseMs), 'status', 'claimed', 'fencing', tostring(fencing))
redis.call('PEXPIRE', key, leaseMs + 1000)
return {1, token, fencing, leaseMs}
`;

const RENEW_LUA = `
local key = KEYS[1]
local token = ARGV[1]
local leaseMs = tonumber(ARGV[2])
local now = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)
local curToken = redis.call('HGET', key, 'token')
if curToken ~= token then return {0, 'ownership_lost'} end
local expires = redis.call('HGET', key, 'expires')
if not expires or tonumber(expires) <= now then return {0, 'expired'} end
local newExpires = now + leaseMs
redis.call('HSET', key, 'expires', tostring(newExpires))
redis.call('PEXPIRE', key, leaseMs + 1000)
local fencing = redis.call('HGET', key, 'fencing')
return {1, fencing, leaseMs}
`;

const RELEASE_LUA = `
local key = KEYS[1]
local token = ARGV[1]
local curToken = redis.call('HGET', key, 'token')
if curToken ~= token then return {0, curToken} end
redis.call('HSET', key, 'status', 'expired')
redis.call('HDEL', key, 'token', 'claimant', 'expires')
return {1}
`;

const COMPLETE_LUA = `
local key = KEYS[1]
local token = ARGV[1]
local result = ARGV[2]
local curToken = redis.call('HGET', key, 'token')
if curToken ~= token then return {0, 'ownership_lost'} end
redis.call('HSET', key, 'status', 'completed', 'result', result)
redis.call('PEXPIRE', key, 3600000)
return {1, redis.call('HGET', key, 'fencing')}
`;

export interface JobClaimManager {
  claim(opts: JobClaimOptions): Promise<JobClaimResult>;
  renew(opts: { jobId: string; token: string; leaseMs: number }): Promise<{ renewed: boolean; ttlMs?: number; error?: string }>;
  release(opts: JobReleaseOptions): Promise<{ released: boolean; error?: string }>;
  complete(opts: JobCompleteOptions): Promise<{ completed: boolean; error?: string }>;
  fail(opts: { jobId: string; token: string; error?: string }): Promise<{ failed: boolean; error?: string }>;
  getStatus(jobId: string): Promise<JobClaimStatus>;
}

export interface CreateJobClaimManagerOptions {
  client: Redis;
  keyBuilder: ReturnType<typeof createCoordinationKeyBuilder>;
  defaultTimeoutMs: number;
  defaultRetryIntervalMs: number;
  logger?: Logger;
}

function createJobClaimManagerImpl(opts: CreateJobClaimManagerOptions): JobClaimManager {
  const { client, keyBuilder, defaultTimeoutMs, defaultRetryIntervalMs } = opts;

  const manager: JobClaimManager = {
    async claim(o: JobClaimOptions): Promise<JobClaimResult> {
      validateResource(o.jobId);
      validateLeaseDuration(o.leaseMs);
      validateTimeout(o.timeoutMs);
      validateRetryInterval(o.retryIntervalMs);
      const timeoutMs = o.timeoutMs ?? defaultTimeoutMs;
      const retryIntervalMs = o.retryIntervalMs ?? defaultRetryIntervalMs;
      const token = o.claimantId ? generateOwnershipToken() : generateOwnershipToken();
      // token for claim ownership; claimantId stored separately
      const claimantId = o.claimantId ?? generateOwnershipToken();
      const actualToken = generateOwnershipToken();
      void token;
      const key = keyBuilder.jobClaim(o.jobId);
      const deadline = performance.now() + timeoutMs;
      while (true) {
        if (o.signal?.aborted) {
          return { claimed: false, error: "cancelled", status: "failed" };
        }
        const res = (await (client as any).eval(CLAIM_LUA, 1, key, actualToken, o.leaseMs, claimantId)) as any[];
        if (!Array.isArray(res)) {
          throw new Error("Unexpected result");
        }
        if (res[0] === 1) {
          return { claimed: true, token: String(res[1]), fencingToken: Number(res[2]), ttlMs: Number(res[3]) };
        }
        if (res[0] === 2) {
          return { claimed: false, status: "completed", error: "already completed" };
        }
        if (res[0] === 3) {
          return { claimed: false, status: "failed", error: "job failed" };
        }
        // claimed by other
        if (performance.now() >= deadline) {
          return { claimed: false, status: "claimed", error: "Job claim timed out" };
        }
        await sleep(Math.min(retryIntervalMs, Math.max(1, deadline - performance.now())), o.signal);
      }
    },
    async renew(o: { jobId: string; token: string; leaseMs: number }) {
      validateResource(o.jobId);
      validateToken(o.token);
      validateLeaseDuration(o.leaseMs);
      const key = keyBuilder.jobClaim(o.jobId);
      const res = (await (client as any).eval(RENEW_LUA, 1, key, o.token, o.leaseMs)) as any[];
      if (!Array.isArray(res) || res[0] === 0) {
        return { renewed: false, error: String(res?.[1] ?? "failed") };
      }
      return { renewed: true, ttlMs: Number(res[2]) };
    },
    async release(o: JobReleaseOptions) {
      validateResource(o.jobId);
      validateToken(o.token);
      const key = keyBuilder.jobClaim(o.jobId);
      const res = (await (client as any).eval(RELEASE_LUA, 1, key, o.token)) as any[];
      if (!Array.isArray(res) || res[0] === 0) {
        return { released: false, error: "ownership mismatch" };
      }
      return { released: true };
    },
    async complete(o: JobCompleteOptions) {
      validateResource(o.jobId);
      validateToken(o.token);
      const key = keyBuilder.jobClaim(o.jobId);
      const resultStr = o.result === undefined ? "" : JSON.stringify(o.result);
      const res = (await (client as any).eval(COMPLETE_LUA, 1, key, o.token, resultStr)) as any[];
      if (!Array.isArray(res) || res[0] === 0) {
        return { completed: false, error: "ownership lost" };
      }
      return { completed: true };
    },
    async fail(o: { jobId: string; token: string; error?: string }) {
      validateResource(o.jobId);
      validateToken(o.token);
      const key = keyBuilder.jobClaim(o.jobId);
      await (client as any).eval(
        `redis.call('HSET', KEYS[1], 'status', 'failed', 'error', ARGV[2]); redis.call('PEXPIRE', KEYS[1], 3600000); return 1`,
        1,
        key,
        o.token,
        o.error ?? "failed",
      );
      return { failed: true };
    },
    async getStatus(jobId: string): Promise<JobClaimStatus> {
      validateResource(jobId);
      const key = keyBuilder.jobClaim(jobId);
      const raw = (await client.hgetall(key)) as Record<string, string>;
      if (!raw || Object.keys(raw).length === 0) {
        return { jobId, status: "unclaimed" };
      }
      const now = Date.now();
      const expiresAt = raw.expires ? Number(raw.expires) : undefined;
      let status: JobClaimStatus["status"] = (raw.status as any) ?? "unclaimed";
      if (status === "claimed" && expiresAt && expiresAt <= now) status = "expired";
      return {
        jobId,
        status,
        claimant: raw.claimant ?? raw.token,
        expiresAt,
        fencingToken: raw.fencing ? Number(raw.fencing) : undefined,
        result: raw.result ? safeParse(raw.result) : undefined,
        error: raw.error,
      };
    },
  };

  return manager;
}

function safeParse(v: string): unknown {
  try { return JSON.parse(v); } catch { return v; }
}


function __toConfig(input: any, options?: any) { return (input && typeof input.eval === "function") ? { client: input, ...(options || {}) } : (options ? { ...input, ...options } : input); }
export function createJobClaimManager(input: any, options?: any) {
  const resolved = resolveCoordinationConfig(__toConfig(input, options));
  return createJobClaimManagerImpl({
    client: resolved.client,
    keyBuilder: resolved.keyBuilder,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });
}
