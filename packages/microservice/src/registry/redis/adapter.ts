import { RegistryStore, ServiceInstance, ServiceQuery } from '../registry.js';
import { RedisAdapterConfig, RedisDriver, ResolvedRedisDriver, RedisDriverModule } from './types.js';
import { resolveRedisDriver } from './driver-resolver.js';

export class RedisRegistryStore implements RegistryStore {
  private config: RedisAdapterConfig;
  private driverAdapter: RegistryStore | null = null;
  private resolvedDriver: RedisDriver = 'node-redis';

  constructor(config: RedisAdapterConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const resolved = await resolveRedisDriver(this.config);
    this.resolvedDriver = resolved.driver;
    this.driverAdapter = await resolved.module.createStore(this.config);
  }

  async disconnect(): Promise<void> {
    // The driver adapters don't need explicit disconnect if they handle it internally
    this.driverAdapter = null;
  }

  async set(leaseId: string, instance: ServiceInstance): Promise<void> {
    if (!this.driverAdapter) {
      throw new Error('Redis store not connected');
    }
    return this.driverAdapter.set(leaseId, instance);
  }

  async get(leaseId: string): Promise<ServiceInstance | null> {
    if (!this.driverAdapter) {
      throw new Error('Redis store not connected');
    }
    return this.driverAdapter.get(leaseId);
  }

  async delete(leaseId: string): Promise<void> {
    if (!this.driverAdapter) {
      throw new Error('Redis store not connected');
    }
    return this.driverAdapter.delete(leaseId);
  }

  async query(query: ServiceQuery): Promise<ServiceInstance[]> {
    if (!this.driverAdapter) {
      throw new Error('Redis store not connected');
    }
    return this.driverAdapter.query(query);
  }

  async expire(leaseId: string): Promise<void> {
    if (!this.driverAdapter) {
      throw new Error('Redis store not connected');
    }
    return this.driverAdapter.expire(leaseId);
  }

  getResolvedDriver(): RedisDriver {
    return this.resolvedDriver;
  }
}

export async function createRedisStore(config: RedisAdapterConfig): Promise<RedisRegistryStore> {
  const store = new RedisRegistryStore(config);
  await store.connect();
  return store;
}