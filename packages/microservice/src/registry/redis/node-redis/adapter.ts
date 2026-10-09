import { RegistryStore, ServiceInstance, ServiceQuery } from '../../registry.js';
import { RedisAdapterConfig } from '../types.js';

export interface NodeRedisModule {
  createClient: (options: any) => NodeRedisClient;
}

export interface NodeRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<void>;
  del(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  quit(): Promise<void>;
  multi(): any;
  connect(): Promise<void>;
}

export async function createRedisStore(
  config: RedisAdapterConfig,
  nodeRedisModule: NodeRedisModule
): Promise<RegistryStore> {
  const client = nodeRedisModule.createClient({
    socket: {
      host: config.host,
      port: config.port,
      tls: config.tls,
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
      const keys = await client.keys(pattern);

      if (keys.length === 0) return [];

      const pipeline = client.multi();
      for (const key of keys) {
        pipeline.get(key);
      }

      const results = await pipeline.exec();
      const instances: ServiceInstance[] = [];

      for (const result of results) {
        if (result && result[1]) {
          const instance = JSON.parse(result[1] as string) as ServiceInstance;

          if (query.serviceId && instance.serviceId !== query.serviceId) continue;
          if (query.status && instance.status !== query.status) continue;
          if (query.capability && !instance.capabilities.includes(query.capability)) continue;
          if (instance.leaseExpiresAt < Date.now()) continue;

          instances.push(instance);
          if (query.limit && instances.length >= query.limit) break;
        }
      }

      return instances;
    },

    async expire(leaseId: string): Promise<void> {
      const key = getKey(leaseId);
      await client.del(key);
    },
  };
}