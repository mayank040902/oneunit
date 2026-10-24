import { Redis as IORedis } from "ioredis";
import type {
  RefreshRecord,
  RefreshStore,
  SessionStore,
  StateStore,
} from "@oneunit/auth";

export interface RedisStoreOptions {
  keyPrefix?: string;
  revokedSessionTtlSeconds?: number;
}

const DEFAULT_PREFIX = "oneunit:auth:";

function prefix(options?: RedisStoreOptions): string {
  return options?.keyPrefix ?? DEFAULT_PREFIX;
}

function refreshKey(prefixValue: string, id: string): string {
  return `${prefixValue}refresh:${id}`;
}

export function createRedisRefreshStore(
  redis: IORedis,
  options?: RedisStoreOptions,
): RefreshStore {
  const keyPrefix = prefix(options);

  const consumeScript = `
    local record = redis.call('GET', KEYS[1])
    if not record then return nil end
    local data = cjson.decode(record)
    if data.expiresAt and tonumber(data.expiresAt) <= tonumber(ARGV[1]) then
      redis.call('DEL', KEYS[1])
      return nil
    end
    redis.call('DEL', KEYS[1])
    return record
  `;

  return {
    async save(record: RefreshRecord) {
      const key = refreshKey(keyPrefix, record.id);
      const payload = JSON.stringify({
        id: record.id,
        userId: record.userId,
        tokenHash: record.tokenHash,
        expiresAt: record.expiresAt,
      });
      if (record.expiresAt) {
        const ttlSeconds = Math.ceil((record.expiresAt - Date.now()) / 1000);
        if (ttlSeconds > 0) {
          await redis.set(key, payload, "EX", ttlSeconds);
          return;
        }
      }
      await redis.set(key, payload);
    },
    async get(id: string) {
      const key = refreshKey(keyPrefix, id);
      const raw = await redis.get(key);
      if (!raw) return null;
      let data: { userId: unknown; tokenHash: string; expiresAt: number };
      try {
        data = JSON.parse(raw) as { userId: unknown; tokenHash: string; expiresAt: number };
      } catch {
        await redis.del(key);
        return null;
      }
      if (data.expiresAt && data.expiresAt <= Date.now()) {
        await redis.del(key);
        return null;
      }
      return {
        id,
        userId: data.userId as RefreshRecord["userId"],
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
      };
    },
    async consume(id: string) {
      const key = refreshKey(keyPrefix, id);
      const result = await redis.eval(
        consumeScript,
        1,
        key,
        String(Date.now()),
      );
      if (!result) return null;
      let data: { userId: unknown; tokenHash: string; expiresAt: number };
      try {
        data = JSON.parse(result as string) as { userId: unknown; tokenHash: string; expiresAt: number };
      } catch {
        return null;
      }
      return {
        id,
        userId: data.userId as RefreshRecord["userId"],
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
      };
    },
    async revoke(id: string) {
      await redis.del(refreshKey(keyPrefix, id));
    },
  };
}

export function createRedisSessionStore(
  redis: IORedis,
  options?: RedisStoreOptions,
): SessionStore {
  const keyPrefix = prefix(options);
  const revokedTtlSeconds = options?.revokedSessionTtlSeconds ?? 30 * 24 * 60 * 60;

  function versionKey(userId: string | number): string {
    return `${keyPrefix}session-version:${userId}`;
  }

  function revokedKey(sessionId: string): string {
    return `${keyPrefix}revoked-session:${sessionId}`;
  }

  return {
    async getVersion(userId: string | number) {
      const raw = await redis.get(versionKey(userId));
      if (!raw) return 0;
      const value = Number(raw);
      return Number.isFinite(value) ? value : 0;
    },
    async bumpVersion(userId: string | number) {
      return redis.incr(versionKey(userId));
    },
    async revokeSession(sessionId: string) {
      await redis.set(revokedKey(sessionId), "1", "EX", revokedTtlSeconds);
    },
    async isSessionRevoked(sessionId: string) {
      const value = await redis.get(revokedKey(sessionId));
      return value !== null;
    },
  };
}

export function createRedisStateStore(
  redis: IORedis,
  options?: RedisStoreOptions,
): StateStore {
  const keyPrefix = prefix(options);

  const consumeScript = `
    local record = redis.call('GET', KEYS[1])
    if not record then return nil end
    local data = cjson.decode(record)
    if data.expiresAt and tonumber(data.expiresAt) <= tonumber(ARGV[1]) then
      redis.call('DEL', KEYS[1])
      return nil
    end
    redis.call('DEL', KEYS[1])
    return record
  `;

  function key(id: string): string {
    return `${keyPrefix}state:${id}`;
  }

  return {
    async set(id, value, ttlSeconds = 600) {
      const payload = JSON.stringify({ value, expiresAt: Date.now() + ttlSeconds * 1000 });
      if (ttlSeconds > 0) {
        await redis.set(key(id), payload, "EX", ttlSeconds);
      } else {
        await redis.set(key(id), payload);
      }
    },
    async get(id) {
      const raw = await redis.get(key(id));
      if (!raw) return null;
      let data: { value: unknown; expiresAt: number };
      try {
        data = JSON.parse(raw) as { value: unknown; expiresAt: number };
      } catch {
        await redis.del(key(id));
        return null;
      }
      if (data.expiresAt && data.expiresAt <= Date.now()) {
        await redis.del(key(id));
        return null;
      }
      return data.value ?? null;
    },
    async delete(id) {
      await redis.del(key(id));
    },
    async consume(id) {
      const redisKey = key(id);
      const result = await redis.eval(consumeScript, 1, redisKey, String(Date.now()));
      if (!result) return null;
      let data: { value: unknown; expiresAt: number };
      try {
        data = JSON.parse(result as string) as { value: unknown; expiresAt: number };
      } catch {
        return null;
      }
      if (data.expiresAt && data.expiresAt <= Date.now()) {
        return null;
      }
      return data.value ?? null;
    },
  };
}

export interface RedisStores {
  refreshStore: RefreshStore;
  sessionStore: SessionStore;
  stateStore: StateStore;
}

export function createRedisStores(redis: IORedis, options?: RedisStoreOptions): RedisStores {
  return {
    refreshStore: createRedisRefreshStore(redis, options),
    sessionStore: createRedisSessionStore(redis, options),
    stateStore: createRedisStateStore(redis, options),
  };
}
