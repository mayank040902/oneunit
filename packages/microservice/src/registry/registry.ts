import { ServiceRegistration, ServiceInstance, HealthCheck, ServiceQuery } from '../contracts/schemas.js';
import { MicroserviceConfig } from '../config/schema.js';
import { RedisRegistryStore } from './redis/adapter.js';

export interface ServiceRegistry {
  register(registration: ServiceRegistration): Promise<ServiceLease>;
  renew(leaseId: string): Promise<void>;
  discover(query: ServiceQuery): Promise<ServiceInstance[]>;
  deregister(leaseId: string): Promise<void>;
  getInstance(leaseId: string): Promise<ServiceInstance | null>;
  updateHealth(health: HealthCheck): Promise<void>;
}

export interface ServiceLease {
  leaseId: string;
  serviceId: string;
  instanceId: string;
  expiresAt: number;
  ttlMs: number;
}

export type { ServiceInstance, ServiceQuery, ServiceRegistration, HealthCheck };

export type LeaseRenewalResult = 'renewed' | 'not-found' | 'expired' | 'conflict';

export interface RegistryStore {
  set(leaseId: string, instance: ServiceInstance): Promise<void>;
  setIfAbsent?(leaseId: string, instance: ServiceInstance): Promise<boolean>;
  get(leaseId: string): Promise<ServiceInstance | null>;
  delete(leaseId: string): Promise<void>;
  query(query: ServiceQuery): Promise<ServiceInstance[]>;
  expire(leaseId: string): Promise<void>;
  renew(leaseId: string, ttlMs: number): Promise<LeaseRenewalResult>;
  disconnect?(): Promise<void>;
  close?(): Promise<void>;
  updateInstanceHealth(
    serviceId: string,
    instanceId: string,
    status: ServiceInstance['status'],
    timestamp: number,
  ): Promise<boolean>;
}

export class InMemoryRegistryStore implements RegistryStore {
  private store: Map<string, ServiceInstance> = new Map();
  private expiries: Map<string, NodeJS.Timeout> = new Map();
  private expiryGenerations: Map<string, number> = new Map();

  async set(leaseId: string, instance: ServiceInstance): Promise<void> {
    this.store.set(leaseId, instance);
    this.scheduleExpiry(leaseId, instance.leaseExpiresAt);
  }

  async setIfAbsent(leaseId: string, instance: ServiceInstance): Promise<boolean> {
    const current = this.store.get(leaseId);
    if (current && current.leaseExpiresAt > Date.now()) {
      return false;
    }
    await this.set(leaseId, instance);
    return true;
  }

  async get(leaseId: string): Promise<ServiceInstance | null> {
    const instance = this.store.get(leaseId);
    if (!instance) return null;
    if (instance.leaseExpiresAt <= Date.now()) {
      await this.delete(leaseId);
      return null;
    }
    return instance;
  }

  async delete(leaseId: string): Promise<void> {
    this.clearExpiry(leaseId);
    this.expiryGenerations.delete(leaseId);
    this.store.delete(leaseId);
  }

  async query(query: ServiceQuery): Promise<ServiceInstance[]> {
    const results: ServiceInstance[] = [];
    
    for (const instance of this.store.values()) {
    if (query.serviceId && instance.serviceId !== query.serviceId) continue;
    if (query.serviceName && instance.serviceName !== query.serviceName) continue;
    if (query.status && instance.status !== query.status) continue;
      if (query.capability && !instance.capabilities.includes(query.capability)) continue;
      if (instance.leaseExpiresAt <= Date.now()) continue;
      
      results.push(instance);
      if (query.limit && results.length >= query.limit) break;
    }
    
    return results;
  }

  async expire(leaseId: string): Promise<void> {
    await this.delete(leaseId);
  }

  async renew(leaseId: string, ttlMs: number): Promise<LeaseRenewalResult> {
    const instance = this.store.get(leaseId);
    if (!instance) {
      return 'not-found';
    }

    const now = Date.now();
    if (instance.leaseExpiresAt <= now) {
      await this.delete(leaseId);
      return 'expired';
    }

    const renewed: ServiceInstance = {
      ...instance,
      lastHeartbeat: now,
      leaseExpiresAt: now + ttlMs,
    };
    this.store.set(leaseId, renewed);
    this.scheduleExpiry(leaseId, renewed.leaseExpiresAt);
    return 'renewed';
  }

  async updateInstanceHealth(
    serviceId: string,
    instanceId: string,
    status: ServiceInstance['status'],
    timestamp: number,
  ): Promise<boolean> {
    for (const [leaseId, instance] of this.store) {
      if (instance.serviceId !== serviceId || instance.instanceId !== instanceId) continue;
      if (instance.leaseExpiresAt <= Date.now()) continue;

      const updated: ServiceInstance = {
        ...instance,
        status,
        lastHeartbeat: timestamp,
      };
      this.store.set(leaseId, updated);
      this.scheduleExpiry(leaseId, updated.leaseExpiresAt);
      return true;
    }
    return false;
  }

  private scheduleExpiry(leaseId: string, expiresAt: number): void {
    this.clearExpiry(leaseId);
    const generation = (this.expiryGenerations.get(leaseId) ?? 0) + 1;
    this.expiryGenerations.set(leaseId, generation);
    const delay = expiresAt - Date.now();
    const callback = () => {
      const currentGeneration = this.expiryGenerations.get(leaseId);
      if (currentGeneration !== generation) {
        return;
      }
      const current = this.store.get(leaseId);
      if (!current || current.leaseExpiresAt !== expiresAt || current.leaseExpiresAt > Date.now()) {
        return;
      }
      this.expiryGenerations.delete(leaseId);
      this.expiries.delete(leaseId);
      this.store.delete(leaseId);
    };
    if (delay <= 0) {
      return;
    }
    const timer = setTimeout(callback, delay);
    this.expiries.set(leaseId, timer);
  }

  private clearExpiry(leaseId: string): void {
    const timer = this.expiries.get(leaseId);
    if (timer) {
      clearTimeout(timer);
      this.expiries.delete(leaseId);
    }
  }
}

export class ServiceRegistryImpl implements ServiceRegistry {
  private store: RegistryStore;
  private defaultTtlMs: number;
  private maxServices: number;
  private registrationLock: Promise<void> = Promise.resolve();

  constructor(store: RegistryStore, defaultTtlMs = 30000, maxServices = 1000) {
    this.store = store;
    this.defaultTtlMs = defaultTtlMs;
    this.maxServices = maxServices;
  }

  async register(registration: ServiceRegistration): Promise<ServiceLease> {
    const leaseId = `instance:${registration.serviceId}:${registration.instanceId}`;

    const execute = async (): Promise<ServiceLease> => {
      const now = Date.now();

      const existing = await this.store.get(leaseId);
      if (existing && existing.leaseExpiresAt > now) {
        return {
          leaseId,
          serviceId: existing.serviceId,
          instanceId: existing.instanceId,
          expiresAt: existing.leaseExpiresAt,
          ttlMs: this.defaultTtlMs,
        };
      }

      const active = await this.store.query({});
      if (active.length >= this.maxServices) {
        throw new Error(
          `Service registry capacity reached (maxServices=${this.maxServices}). Cannot register service ${registration.serviceId}.`,
        );
      }

      const expiresAt = now + this.defaultTtlMs;
      const instance: ServiceInstance = {
        serviceId: registration.serviceId,
        serviceName: registration.serviceName,
        instanceId: registration.instanceId,
        endpoints: registration.endpoints,
        status: 'healthy',
        lastHeartbeat: now,
        leaseExpiresAt: expiresAt,
        capabilities: registration.capabilities,
        metadata: registration.metadata,
      };

      let created = true;
      if (typeof this.store.setIfAbsent === 'function') {
        created = await this.store.setIfAbsent(leaseId, instance);
      } else {
        const concurrent = await this.store.get(leaseId);
        if (concurrent && concurrent.leaseExpiresAt > now) {
          created = false;
        } else {
          await this.store.set(leaseId, instance);
        }
      }

      if (!created) {
        const record = await this.store.get(leaseId);
        if (record) {
          return {
            leaseId,
            serviceId: record.serviceId,
            instanceId: record.instanceId,
            expiresAt: record.leaseExpiresAt,
            ttlMs: this.defaultTtlMs,
          };
        }
      }

      return {
        leaseId,
        serviceId: registration.serviceId,
        instanceId: registration.instanceId,
        expiresAt,
        ttlMs: this.defaultTtlMs,
      };
    };

    if (this.store instanceof InMemoryRegistryStore) {
      const previous = this.registrationLock;
      let release!: () => void;
      this.registrationLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await execute();
      } finally {
        release();
      }
    }

    return execute();
  }

  async renew(leaseId: string): Promise<void> {
    const result = await this.store.renew(leaseId, this.defaultTtlMs);

    if (result === 'not-found') {
      throw new Error(`Lease not found: ${leaseId}`);
    }
    if (result === 'expired') {
      throw new Error(`Lease expired: ${leaseId}`);
    }
    if (result === 'conflict') {
      throw new Error(`Lease renewal conflict: ${leaseId}`);
    }
  }

  async discover(query: ServiceQuery): Promise<ServiceInstance[]> {
    return this.store.query(query);
  }

  async deregister(leaseId: string): Promise<void> {
    await this.store.delete(leaseId);
  }

  async getInstance(leaseId: string): Promise<ServiceInstance | null> {
    return this.store.get(leaseId);
  }

  async updateHealth(health: HealthCheck): Promise<void> {
    await this.store.updateInstanceHealth(
      health.serviceId,
      health.instanceId,
      health.status,
      health.timestamp,
    );
  }
}

export function createRegistry(config: MicroserviceConfig['registry']): ServiceRegistry {
  let store: RegistryStore;
  
  if (config.backend === 'redis' && config.redis) {
    const redisStore = new RedisRegistryStore(config.redis);
    // Note: The store needs to be connected. We'll do lazy connection on first use.
    // For now, we'll wrap it to connect on first operation.
    store = new Proxy(redisStore, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          return async (...args: unknown[]) => {
            // Ensure connected before any operation
            if (!target.isConnected()) {
              await target.connect();
            }
            return value.apply(target, args);
          };
        }
        return value;
      }
    });
  } else {
    store = new InMemoryRegistryStore();
  }
  
  return new ServiceRegistryImpl(store, config.ttlMs, config.maxServices);
}