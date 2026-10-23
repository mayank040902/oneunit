import { RegistryStore, ServiceInstance, ServiceQuery, LeaseRenewalResult } from '../../registry.js';
import { RedisAdapterConfig, RedisPipeline, validateRedisTls } from '../types.js';

export interface NodeRedisClientOptions {
  socket: {
    host: string;
    port: number;
    tls?: boolean;
    ca?: string | string[];
    cert?: string | string[];
    key?: string;
    passphrase?: string;
    servername?: string;
    rejectUnauthorized?: boolean;
  };
  password?: string;
  database?: number;
}

export interface NodeRedisModule {
  createClient: (options: NodeRedisClientOptions) => NodeRedisClient;
}

export interface NodeRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<unknown>;
  del(key: string): Promise<void>;
  scan(cursor: number, options: { MATCH?: string; COUNT?: number }): Promise<{ cursor: number; keys: string[] }>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<string>;
  quit(): Promise<void>;
  multi(): RedisPipeline;
  connect(): Promise<void>;
}

// Cursor-paged key collection. SCAN is
// incremental and non-blocking; KEYS would
// block the Redis server for a full keyspace
// scan, which is unacceptable on a shared
// registry database.
async function collectKeys(
  client: NodeRedisClient,
  pattern: string,
  count = 100
): Promise<string[]> {
  const keys: string[] = [];
  let cursor = 0;
  do {
    const result = await client.scan(cursor, { MATCH: pattern, COUNT: count });
    keys.push(...result.keys);
    cursor = result.cursor;
  } while (cursor !== 0);
  return keys;
}

// Atomic lease renewal: the check-and-set runs server-side so
// concurrent renewals cannot interleave a stale read with a write.
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



// Atomic health update: status/timestamp are applied server-side so concurrent
// renewal or health writes cannot overwrite one another with stale values.
const UPDATE_HEALTH_SCRIPT = `
local data = redis.call('GET', KEYS[1])
if not data then
  return 0
end
local instance = cjson.decode(data)
if instance.serviceId ~= ARGV[1] or instance.instanceId ~= ARGV[2] then
  return 0
end
if tonumber(instance.leaseExpiresAt) < tonumber(ARGV[5]) then
  return 0
end
instance.status = ARGV[3]
instance.lastHeartbeat = tonumber(ARGV[4])
local ttl = math.max(math.ceil((tonumber(instance.leaseExpiresAt) - tonumber(ARGV[5])) / 1000), 1)
redis.call('SET', KEYS[1], cjson.encode(instance), 'EX', ttl)
return 1
`;

export async function createRedisStore(
  config: RedisAdapterConfig,
  nodeRedisModule: NodeRedisModule
): Promise<RegistryStore> {
  validateRedisTls(config.tls, true);

  const tlsOptions = config.tls === true ? { tls: true } :
    config.tls === false || config.tls === undefined ? {} :
      { tls: true, ...config.tls };

  const client = nodeRedisModule.createClient({
    socket: {
      host: config.host,
      port: config.port,
      ...tlsOptions,
    },
    password: config.password,
    database: config.db,
  });

  await client.connect();

  const keyPrefix = config.keyPrefix ?? 'microservice:registry:';

  function getKey(leaseId: string): string {
    return `${keyPrefix}${leaseId}`;
  }

  return {
    async set(leaseId: string, instance: ServiceInstance): Promise<void> {
      const key = getKey(leaseId);
      const ttl = Math.ceil((instance.leaseExpiresAt - Date.now()) / 1000);
      await client.set(key, JSON.stringify(instance), { EX: Math.max(ttl, 1) });
    },

    async setIfAbsent(leaseId: string, instance: ServiceInstance): Promise<boolean> {
      const key = getKey(leaseId);
      const ttl = Math.ceil((instance.leaseExpiresAt - Date.now()) / 1000);
      const result = await client.set(key, JSON.stringify(instance), { EX: Math.max(ttl, 1), NX: true } as never);
      return result === "OK";
    },

    async get(leaseId: string): Promise<ServiceInstance | null> {
      const key = getKey(leaseId);
      const data = await client.get(key);
      if (!data) return null;
      try {
        return JSON.parse(data) as ServiceInstance;
      } catch {
        throw new Error(`Malformed registry record for lease ${leaseId}`);
      }
    },

    async delete(leaseId: string): Promise<void> {
      const key = getKey(leaseId);
      await client.del(key);
    },

    async query(query: ServiceQuery): Promise<ServiceInstance[]> {
      const pattern = `${keyPrefix}*`;
      const instances: ServiceInstance[] = [];
      const count = 100;
      let cursor = 0;

      while (true) {
        const result = await client.scan(cursor, { MATCH: pattern, COUNT: count });
        cursor = result.cursor;

        if (result.keys.length > 0) {
          const pipeline = client.multi();
          for (const key of result.keys) {
            pipeline.get(key);
          }
          const results = await pipeline.exec();
          if (results) {
            for (const row of results) {
              if (row && row[1]) {
                let instance: ServiceInstance;
                try {
                  instance = JSON.parse(row[1] as string) as ServiceInstance;
                } catch {
                  continue;
                }

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

        if (cursor === 0) {
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
      const result = await client.eval(RENEW_SCRIPT, {
        keys: [key],
        arguments: [String(now), String(expiresAt), String(ttlSeconds)],
      });
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

      const now = Date.now();
      for (const key of keys) {
        const result = await client.eval(UPDATE_HEALTH_SCRIPT, {
          keys: [key],
          arguments: [serviceId, instanceId, status, String(timestamp), String(now)],
        });
        if (String(result) === '1') {
          return true;
        }
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
