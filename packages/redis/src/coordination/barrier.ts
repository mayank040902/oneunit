/* eslint-disable */
import { Redis } from "ioredis";
import { createCoordinationKeyBuilder, resolveCoordinationConfig } from "./utils.js";
import { validateResource, validateRequiredCount, validateParticipantId, validateTimeout, validateGeneration, sleep } from "./utils.js";
import type { Logger } from "../logger.js";
import type {
  BarrierArrivalResult,
  BarrierArrivalOptions,
  BarrierStatus,
} from "./types.js";

const ARRIVE_LUA = `
local key = KEYS[1]
local required = tonumber(ARGV[1])
local generation = tonumber(ARGV[2])
local participant = ARGV[3]
local timeoutMs = tonumber(ARGV[4])
local now = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)
-- init if needed
if redis.call('EXISTS', key) == 0 then
  redis.call('HSET', key, 'required', tostring(required), 'generation', tostring(generation), 'count', '0', 'released', '0', 'fencing', '0', 'expires', tostring(now + timeoutMs))
end
-- validate generation
local curGen = tonumber(redis.call('HGET', key, 'generation'))
if curGen ~= generation then
  return {0, 'generation_mismatch', curGen}
end
-- check expiry
local expires = tonumber(redis.call('HGET', key, 'expires'))
if expires and expires <= now then
  return {0, 'expired', curGen}
end
-- duplicate arrival?
local partKey = 'p:' .. participant
if redis.call('HEXISTS', key, partKey) == 1 then
  -- already arrived; return current state, not counting again
  local count = tonumber(redis.call('HGET', key, 'count'))
  local released = tonumber(redis.call('HGET', key, 'released'))
  local fencing = tonumber(redis.call('HGET', key, 'fencing'))
  return {released, count, required, generation, fencing, 1}
end
-- register
redis.call('HSET', key, partKey, '1')
local count = tonumber(redis.call('HGET', key, 'count')) + 1
redis.call('HSET', key, 'count', tostring(count))
local fencing = tonumber(redis.call('HGET', key, 'fencing'))
local released = 0
if count >= required then
  released = 1
  fencing = fencing + 1
  redis.call('HSET', key, 'released', '1', 'fencing', tostring(fencing))
end
-- ttl
redis.call('PEXPIRE', key, timeoutMs + 1000)
return {released, count, required, generation, fencing, 0}
`;

export interface BarrierCoordinator {
  arrive(opts: BarrierArrivalOptions): Promise<BarrierArrivalResult>;
  getStatus(barrierId: string, generation: number): Promise<BarrierStatus>;
}

export interface CreateBarrierCoordinatorOptions {
  client: Redis;
  keyBuilder: ReturnType<typeof createCoordinationKeyBuilder>;
  logger?: Logger;
}

function createBarrierCoordinatorImpl(opts: CreateBarrierCoordinatorOptions): BarrierCoordinator {
  const { client, keyBuilder } = opts;
  return {
    async arrive(o: BarrierArrivalOptions): Promise<BarrierArrivalResult> {
      validateResource(o.barrierId);
      validateRequiredCount(o.requiredCount);
      validateParticipantId(o.participantId);
      validateTimeout(o.timeoutMs);
      validateGeneration(o.generation);
      const generation = o.generation ?? 1;
      const timeoutMs = o.timeoutMs ?? 10000;
      const requiredCount = o.requiredCount;
      const key = `${keyBuilder.barrier(o.barrierId)}:gen:${generation}`;
      const deadline = performance.now() + timeoutMs;
      // first call registers arrival
      let res = (await (client as any).eval(ARRIVE_LUA, 1, key, requiredCount, generation, o.participantId, timeoutMs)) as any[];
      if (!Array.isArray(res)) throw new Error("Unexpected result");
      if (res[1] === "generation_mismatch") {
        throw new Error(`Generation mismatch: expected ${generation}, got ${res[2]}`);
      }
      if (res[1] === "expired") {
        throw new Error("Barrier expired");
      }
      const duplicate = Number(res[5]) === 1;
      // wait for release if not released
      let released = Number(res[0]) === 1;
      let count = Number(res[1] === "generation_mismatch" ? 0 : res[1]);
      // careful: res[1] for success is count; but for mismatch we handled
      if (duplicate) {
        // res already count
      }
      // Poll if not released
      if (!released) {
        const retryMs = 50;
        while (performance.now() < deadline) {
          if (o.signal?.aborted) throw new Error("Cancelled");
          await sleep(Math.min(retryMs, Math.max(1, deadline - performance.now())), o.signal);
          const raw = (await client.hgetall(key)) as Record<string, string>;
          if (raw?.released === "1") {
            released = true;
            count = Number(raw.count ?? count);
            break;
          }
          if (!raw || Object.keys(raw).length === 0) {
            break;
          }
        }
      }
      const finalRaw = (await client.hgetall(key)) as Record<string, string>;
      const finalCount = Number(finalRaw?.count ?? count);
      const finalFencing = Number(finalRaw?.fencing ?? res[4] ?? 0);
      if (!released && performance.now() >= deadline) {
        // timeout
        throw new Error("Barrier timeout");
      }
      return {
        released: true,
        participantCount: finalCount,
        requiredCount,
        generation,
        fencingToken: finalFencing,
      };
    },
    async getStatus(barrierId: string, generation: number): Promise<BarrierStatus> {
      validateResource(barrierId);
      validateGeneration(generation);
      const g = generation ?? 1;
      const key = `${keyBuilder.barrier(barrierId)}:gen:${g}`;
      const raw = (await client.hgetall(key)) as Record<string, string>;
      const participants: string[] = [];
      for (const k of Object.keys(raw ?? {})) {
        if (k.startsWith("p:")) participants.push(k.slice(2));
      }
      return {
        barrierId,
        generation: g,
        requiredCount: Number(raw?.required ?? 0),
        participantCount: Number(raw?.count ?? 0),
        released: raw?.released === "1",
        participants,
      };
    },
  };
}


function __toConfig(input: any, options?: any) { return (input && typeof input.eval === "function") ? { client: input, ...(options || {}) } : (options ? { ...input, ...options } : input); }
export function createBarrierCoordinator(input: any, options?: any) {
  const resolved = resolveCoordinationConfig(__toConfig(input, options));
  return createBarrierCoordinatorImpl({
    client: resolved.client,
    keyBuilder: resolved.keyBuilder,
    logger: resolved.logger,
  });
}
