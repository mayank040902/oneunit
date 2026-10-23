import { RegistryStore, ServiceInstance, ServiceQuery, LeaseRenewalResult } from '../../registry.js';
import { RedisAdapterConfig, RedisPipeline } from '../types.js';

export interface IORedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<string>;
  quit(): Promise<void>;
  multi(): RedisPipeline;
  connect(): Promise<void>;
}

export interface IORedisOptions {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  tls?: boolean;
  lazyConnect?: boolean;
  sentinels?: Array<{ host: string; port: number }>;
  name?: string;
  sentinelPassword?: string;
}

export type IORedisConstructor = new (options: IORedisOptions) => IORedisClient;

// Cursor-paged key collection. SCAN is
// incremental and non-blocking; KEYS would
// block the Redis server for a full keyspace
// scan, which is unacceptable on a shared
// registry database.
async function collectKeys(
  client: IORedisClient,
  pattern: string,
  count = 100
): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await client.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      count
    );
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== '0');
  return keys;
}

// Atomic lease renewal: GET the instance, reject when missing or expired,
// otherwise extend the lease and reset the key TTL in a single Redis
// evaluation. Running the check-and-set server-side makes concurrent
// renewals safe (no read-then-write race between two renewal callers).
const RENEW_SCRIPT = `
local data = redis.call('GET', KEYS[1])
if not data then
  return 'not-found'
end
local instance = cjson.decode(data)
if instance.leaseExpiresAt < tonumber(ARGV[1]) then
  return 'expired'
end
instance.lastHeartbeat = tonumber(ARGV[1])
instance.leaseExpiresAt = tonumber(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(instance), 'EX', tonumber(ARGV[3]))
return 'renewed'
`;

export async function createRedisStore(
  config: RedisAdapterConfig,
  Redis: IORedisConstructor
): Promise<RegistryStore> {
  const redisOptions: IORedisOptions = {
    host: config.host,
    port: config.port,
    password: config.password,
    db: config.db,
    tls: config.tls,
    lazyConnect: true,
  };

  if (config.sentinels && config.sentinelName) {
    redisOptions.sentinels = config.sentinels;
    redisOptions.name = config.sentinelName;
    redisOptions.sentinelPassword = config.sentinelPassword;
    delete redisOptions.host;
    delete redisOptions.port;
  }

  const client = new Redis(redisOptions);
  await client.connect();

  const keyPrefix = config.keyPrefix ?? 'microservice:registry:';

  function getKey(leaseId: string): string {
    return `${keyPrefix}${leaseId}`;
  }

  return {
    async set(leaseId: string, instance: ServiceInstance): Promise<void> {
      const key = getKey(leaseId);
      const ttl = Math.ceil((instance.leaseExpiresAt - Date.now()) / 1000);
      await client.set(key, JSON.stringify(instance), 'EX', Math.max(ttl, 1));
    },

    async get(leaseId: string): Promise<ServiceInstance | null> {
      const key = getKey(leaseId);
      const data = await client.get(key);
      if (!data) return null;
      return JSON.parse(data);
    },

    async delete(leaseId: string): Promise<void> {
      const key = getKey(leaseId);
      await client.del(key);
    },

    async query(query: ServiceQuery): Promise<ServiceInstance[]> {
      const pattern = `${keyPrefix}*`;
      const instances: ServiceInstance[] = [];
      const count = 100;
      let cursor = '0';

      while (true) {
        const [nextCursor, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
        cursor = nextCursor;

        if (batch.length > 0) {
          const pipeline = client.multi();
          for (const key of batch) {
            pipeline.get(key);
          }
          const results = await pipeline.exec();
          if (results) {
            for (const result of results) {
              if (result && result[1]) {
                const instance = JSON.parse(result[1] as string) as ServiceInstance;

                if (query.serviceId && instance.serviceId !== query.serviceId) continue;
                if (query.serviceName && instance.serviceName !== query.serviceName) continue;
                if (query.status && instance.status !== query.status) continue;
                if (query.capability && !instance.capabilities.includes(query.capability)) continue;
                if (instance.leaseExpiresAt < Date.now()) continue;

                instances.push(instance);
                if (query.limit && instances.length >= query.limit) {
                  return instances;
                }
              }
            }
          }
        }

        if (cursor === '0') {
          break;
        }
      }

      return instances;
    },

    async expire(leaseId: string): Promise<void> {
      const key = getKey(leaseId);
      await client.del(key);
    },

    async renew(leaseId: string, ttlMs: number): Promise<LeaseRenewalResult> {
      const key = getKey(leaseId);
      const now = Date.now();
      const expiresAt = now + ttlMs;
      const ttlSeconds = Math.max(Math.ceil(ttlMs / 1000), 1);
      const result = await client.eval(
        RENEW_SCRIPT,
        1,
        key,
        String(now),
        String(expiresAt),
        String(ttlSeconds),
      );
      return result as LeaseRenewalResult;
    },

    async updateInstanceHealth(
      serviceId: string,
      instanceId: string,
      status: ServiceInstance['status'],
      timestamp: number,
    ): Promise<boolean> {
      const pattern = `${keyPrefix}*`;
      const keys = await collectKeys(client, pattern);
      if (keys.length === 0) return false;

      const pipeline = client.multi();
      for (const key of keys) {
        pipeline.get(key);
      }
      const results = await pipeline.exec();
      if (!results) return false;

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key === undefined) continue;
        const result = results[i];
        if (!result || !result[1]) continue;

        const instance = JSON.parse(result[1] as string) as ServiceInstance;
        if (instance.serviceId !== serviceId || instance.instanceId !== instanceId) continue;
        if (instance.leaseExpiresAt < Date.now()) continue;

        const updated: ServiceInstance = { ...instance, status, lastHeartbeat: timestamp };
        const remainingTtl = Math.max(
          Math.ceil((updated.leaseExpiresAt - Date.now()) / 1000),
          1,
        );
        await client.set(key, JSON.stringify(updated), 'EX', remainingTtl);
        return true;
      }
      return false;
    },
    async disconnect() {
      try {
        await client.quit();
      } catch { void 0; }
    },
    async close() {
      try {
        await client.quit();
      } catch { void 0; }
    },
  };
}
