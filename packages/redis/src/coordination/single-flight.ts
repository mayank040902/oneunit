/* eslint-disable */
import { Redis } from "ioredis";
import type { Logger } from "../logger.js";
import { createCoordinationKeyBuilder, resolveCoordinationConfig } from "./utils.js";
import { generateOwnershipToken, validateResource, validateLeaseDuration, sleep } from "./utils.js";
import type { SingleFlightResult, SingleFlightOptions } from "./types.js";

const ACQUIRE_OWNER_LUA = `
local key = KEYS[1]
local token = ARGV[1]
local leaseMs = tonumber(ARGV[2])
local now = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)
local expires = redis.call('HGET', key, 'expires')
local status = redis.call('HGET', key, 'status')
if expires and tonumber(expires) > now and status ~= 'completed' and status ~= 'failed' then
  -- owner active or result? if completed handle below
  local owner = redis.call('HGET', key, 'token')
  if owner and owner ~= token then
    return {0, 'owned', owner, status or 'pending', redis.call('HGET', key, 'result'), redis.call('HGET', key, 'error')}
  end
end
-- if completed and not expired, return result
if status == 'completed' and expires and tonumber(expires) > now then
  return {2, redis.call('HGET', key, 'result')}
end
if status == 'failed' and expires and tonumber(expires) > now then
  return {3, redis.call('HGET', key, 'error')}
end
-- acquire
local fencing = redis.call('HGET', key, 'fencing')
if not fencing then fencing = '0' end
fencing = tonumber(fencing) + 1
redis.call('HSET', key, 'token', token, 'expires', tostring(now + leaseMs), 'status', 'pending', 'fencing', tostring(fencing))
redis.call('PEXPIRE', key, leaseMs + 1000)
return {1, token, fencing}
`;

const PUBLISH_LUA = `
local key = KEYS[1]
local token = ARGV[1]
local status = ARGV[2]
local payload = ARGV[3]
local ttl = tonumber(ARGV[4])
local now = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)
local currentToken = redis.call('HGET', key, 'token')
if currentToken ~= token then
  return {0, 'token_mismatch'}
end
redis.call('HSET', key, 'status', status, 'result', status == 'completed' and payload or '', 'error', status == 'failed' and payload or '', 'expires', tostring(now + ttl))
redis.call('PEXPIRE', key, ttl + 1000)
return {1}
`;

export interface SingleFlightManager {
  execute<T>(opts: SingleFlightOptions<T>): Promise<SingleFlightResult<T>>;
}

export interface CreateSingleFlightManagerOptions {
  client: Redis;
  keyBuilder: ReturnType<typeof createCoordinationKeyBuilder>;
  defaultTimeoutMs: number;
  defaultRetryIntervalMs: number;
  logger?: Logger;
}

function createSingleFlightManagerImpl(opts: CreateSingleFlightManagerOptions): SingleFlightManager {
  const { client, keyBuilder, defaultTimeoutMs, defaultRetryIntervalMs } = opts;

  return {
    async execute<T>(options: SingleFlightOptions<T>): Promise<SingleFlightResult<T>> {
      validateResource(options.key);
      validateLeaseDuration(options.leaseMs);
      const key = keyBuilder.singleFlight(options.key);
      const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
      const retryIntervalMs = options.retryIntervalMs ?? defaultRetryIntervalMs ?? 50;
      const token = options.ownerId ?? generateOwnershipToken();
      const deadline = performance.now() + timeoutMs;
      const resultTtl = options.resultTtlMs ?? options.leaseMs;

      while (true) {
        if (options.signal?.aborted) throw new Error("Cancelled");
        const acq = (await (client as any).eval(ACQUIRE_OWNER_LUA, 1, key, token, options.leaseMs)) as any[];
        if (!Array.isArray(acq)) throw new Error("Unexpected result");
        if (acq[0] === 1) {
          // owner
          const fencingToken = Number(acq[2] ?? 0);
          const abortController = new AbortController();
          let result: T = undefined as T;
          let status: "completed" | "failed" = "completed";
          let payload = "";
          try {
            result = await options.execute();
            payload = JSON.stringify({ ok: true, value: result });
          } catch (e) {
            status = "failed";
            payload = JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
          }
          // publish
          await (client as any).eval(PUBLISH_LUA, 1, key, token, status, payload, resultTtl).catch(() => {});
          if (status === "failed") {
            const parsed = JSON.parse(payload);
            throw new Error(parsed.error);
          }
          return { value: result as T, isOwner: true, fencingToken };
        }
        if (acq[0] === 2) {
          // completed result
          const raw = acq[1];
          let parsed: any = null;
          try { parsed = JSON.parse(String(raw)); } catch { parsed = null; }
          if (parsed && parsed.ok) {
            return { value: parsed.value as T, isOwner: false, fencingToken: 0 };
          }
          throw new Error(parsed?.error ?? "single-flight result error");
        }
        if (acq[0] === 3) {
          throw new Error(String(acq[1] ?? "single-flight failed"));
        }
        // owned by other -> wait/poll
        if (performance.now() >= deadline) {
          throw new Error("Single-flight timed out");
        }
        await sleep(Math.min(retryIntervalMs, Math.max(1, deadline - performance.now())), options.signal);
      }
    },
  };
}


function __toConfig(input: any, options?: any) { return (input && typeof input.eval === "function") ? { client: input, ...(options || {}) } : (options ? { ...input, ...options } : input); }
export function createSingleFlightManager(input: any, options?: any) {
  const resolved = resolveCoordinationConfig(__toConfig(input, options));
  return createSingleFlightManagerImpl({
    client: resolved.client,
    keyBuilder: resolved.keyBuilder,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    defaultRetryIntervalMs: resolved.defaultRetryIntervalMs,
    logger: resolved.logger,
  });
}
