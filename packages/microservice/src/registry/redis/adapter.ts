import { RegistryStore, ServiceInstance, ServiceQuery, LeaseRenewalResult } from '../registry.js';
import { RedisAdapterConfig, RedisDriver } from './types.js';
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
    const adapter = this.driverAdapter as { disconnect?: () => Promise<void>; close?: () => Promise<void> } | null;
    try {
      if (adapter?.disconnect) {
        await adapter.disconnect();
      } else if (adapter?.close) {
        await adapter.close();
      }
    } catch (err) {
      console.error('Redis cleanup failed', err);
    } finally {
      this.driverAdapter = null;
    }
  }

  async close(): Promise<void> {
    await this.disconnect();
  }

  isConnected(): boolean {
    return this.driverAdapter !== null;
  }

  async set(leaseId: string, instance: ServiceInstance): Promise<void> {
    if (!this.driverAdapter) {
      throw new Error('Redis store not connected');
    }
    return this.driverAdapter.set(leaseId, instance);
  }

  async setIfAbsent(leaseId: string, instance: ServiceInstance): Promise<boolean> {
    if (!this.driverAdapter) {
      throw new Error('Redis store not connected');
    }
    if (typeof this.driverAdapter.setIfAbsent === 'function') {
      return await this.driverAdapter.setIfAbsent(leaseId, instance);
    }
    const existing = await this.driverAdapter.get(leaseId);
    if (existing && existing.leaseExpiresAt > Date.now()) {
      return false;
    }
    await this.driverAdapter.set(leaseId, instance);
    return true;
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

  async renew(leaseId: string, ttlMs: number): Promise<LeaseRenewalResult> {
    if (!this.driverAdapter) {
      throw new Error('Redis store not connected');
    }
    return this.driverAdapter.renew(leaseId, ttlMs);
  }

  async updateInstanceHealth(
    serviceId: string,
    instanceId: string,
    status: ServiceInstance['status'],
    timestamp: number,
  ): Promise<boolean> {
    if (!this.driverAdapter) {
      throw new Error('Redis store not connected');
    }
    return this.driverAdapter.updateInstanceHealth(serviceId, instanceId, status, timestamp);
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