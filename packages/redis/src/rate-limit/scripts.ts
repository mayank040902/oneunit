/* eslint-disable */
import { Redis } from "ioredis";

export async function runLua(client: Redis, script: string, keys: string[], args: Array<string | number>): Promise<unknown> {
  return (client as any).eval(script, keys.length, ...keys, ...args.map((a) => String(a)));
}

export const FIXED_CONSUMER_LUA = `
local nowSec, nowUsec = redis.call('TIME')[1], redis.call('TIME')[2]
local now = tonumber(nowSec) * 1000 + math.floor(tonumber(nowUsec) / 1000)
local interval = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local mode = ARGV[4]
local key = KEYS[1]
local window = math.floor(now / interval) * interval
local reset = window + interval
local ttl = reset - now
if ttl < 1 then ttl = 1 end
local current = redis.call('GET', key)
if not current then current = '0' end
current = tonumber(current)
if mode == 'check' then
  if current + cost > limit then
    return {0, current, reset, ttl, 'limited'}
  end
  return {1, current, reset, ttl, 'ok'}
end
if cost > limit then
  return {0, current, reset, ttl, 'cost_exceeds_limit'}
end
if current + cost > limit then
  return {0, current, reset, ttl, 'limited'}
end
current = current + cost
redis.call('SET', key, tostring(current), 'PX', ttl)
return {1, current, reset, ttl, 'ok'}
`;

export const SLIDING_CONSUMER_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local interval = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local mode = ARGV[4]
local uniq = ARGV[5]
local cutoff = now - interval
local key = KEYS[1]
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local members = redis.call('ZRANGE', key, 0, -1)
local total = 0
for i = 1, #members do
  local m = members[i]
  local c = m:match(':([^:]+)$')
  if c then total = total + (tonumber(c) or 0) end
end
local oldest = nil
for i = 1, #members do
  local sc = redis.call('ZSCORE', key, members[i])
  if sc then
    local ms = tonumber(sc)
    if not oldest or ms < oldest then oldest = ms end
  end
end
local reset = now + interval
if oldest then reset = oldest + interval end
local retryAfter = 0
if oldest then retryAfter = (oldest + interval) - now
  if retryAfter < 0 then retryAfter = 0 end
end
if cost > limit then
  return {0, total, reset, retryAfter, 'cost_exceeds_limit'}
end
if mode == 'check' then
  if total + cost > limit then
    return {0, total, reset, retryAfter, 'limited'}
  end
  return {1, total, reset, retryAfter, 'ok'}
end
if total + cost > limit then
  return {0, total, reset, retryAfter, 'limited'}
end
local member = now .. ':' .. uniq .. ':' .. cost
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, interval + 1000)
return {1, total + cost, reset, retryAfter, 'ok'}
`;

export const TOKEN_BUCKET_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local mode = ARGV[4]
local initial = tonumber(ARGV[5])
local key = KEYS[1]
local tokens = redis.call('HGET', key, 'tokens')
local last = redis.call('HGET', key, 'last')
if not tokens then tokens = initial end
if not last then last = now end
tokens = tonumber(tokens)
last = tonumber(last)
local elapsed = now - last
if elapsed < 0 then elapsed = 0 end
local refill = elapsed * refillPerMs
tokens = math.min(capacity, tokens + refill)
local allowed = 0
local reason = 'ok'
local remaining = tokens
if cost > capacity then
  allowed = 0
  reason = 'cost_exceeds_capacity'
elseif tokens >= cost then
  allowed = 1
  if mode ~= 'check' then tokens = tokens - cost end
  remaining = tokens
else
  allowed = 0
  reason = 'limited'
end
if mode ~= 'check' then
  redis.call('HSET', key, 'tokens', tostring(tokens), 'last', tostring(now), 'capacity', tostring(capacity))
  redis.call('EXPIRE', key, 86400)
end
local needed = (cost - tokens)
if needed < 0 then needed = 0 end
local retryAfter = 0
if allowed == 0 and refillPerMs > 0 then
  retryAfter = math.ceil(needed / refillPerMs)
end
return {allowed, remaining, now + (retryAfter), retryAfter, reason}
`;

export const LEAKY_BUCKET_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local capacity = tonumber(ARGV[1])
local leakPerMs = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local mode = ARGV[4]
local key = KEYS[1]
local water = redis.call('HGET', key, 'water')
local last = redis.call('HGET', key, 'last')
if not water then water = 0 end
if not last then last = now end
water = tonumber(water)
last = tonumber(last)
local elapsed = now - last
if elapsed < 0 then elapsed = 0 end
local leaked = elapsed * leakPerMs
water = water - leaked
if water < 0 then water = 0 end
local allowed = 0
local reason = 'ok'
local remaining = capacity - water
if cost > capacity then
  allowed = 0
  reason = 'cost_exceeds_capacity'
elseif water + cost <= capacity then
  allowed = 1
  if mode ~= 'check' then water = water + cost end
  remaining = capacity - water
else
  allowed = 0
  reason = 'limited'
  remaining = capacity - water
end
if mode ~= 'check' then
  redis.call('HSET', key, 'water', tostring(water), 'last', tostring(now), 'capacity', tostring(capacity))
  redis.call('EXPIRE', key, 86400)
end
local needed = (water + cost - capacity)
if needed < 0 then needed = 0 end
local retryAfter = 0
if allowed == 0 and leakPerMs > 0 then
  retryAfter = math.ceil(needed / leakPerMs)
end
return {allowed, remaining, now + retryAfter, retryAfter, reason}
`;
