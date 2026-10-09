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

export interface RegistryStore {
  set(leaseId: string, instance: ServiceInstance): Promise<void>;
  get(leaseId: string): Promise<ServiceInstance | null>;
  delete(leaseId: string): Promise<void>;
  query(query: ServiceQuery): Promise<ServiceInstance[]>;
  expire(leaseId: string): Promise<void>;
}

export class InMemoryRegistryStore implements RegistryStore {
  private store: Map<string, ServiceInstance> = new Map();
  private expiries: Map<string, NodeJS.Timeout> = new Map();

  async set(leaseId: string, instance: ServiceInstance): Promise<void> {
    this.store.set(leaseId, instance);
    this.scheduleExpiry(leaseId, instance.leaseExpiresAt);
  }

  async get(leaseId: string): Promise<ServiceInstance | null> {
    return this.store.get(leaseId) ?? null;
  }

  async delete(leaseId: string): Promise<void> {
    this.clearExpiry(leaseId);
    this.store.delete(leaseId);
  }

  async query(query: ServiceQuery): Promise<ServiceInstance[]> {
    const results: ServiceInstance[] = [];
    
    for (const instance of this.store.values()) {
      if (query.serviceId && instance.serviceId !== query.serviceId) continue;
      if (query.serviceName) {
        const registration = instance as unknown as { serviceName?: string };
        if (registration.serviceName !== query.serviceName) continue;
      }
      if (query.status && instance.status !== query.status) continue;
      if (query.capability && !instance.capabilities.includes(query.capability)) continue;
      if (instance.leaseExpiresAt < Date.now()) continue;
      
      results.push(instance);
      if (query.limit && results.length >= query.limit) break;
    }
    
    return results;
  }

  async expire(leaseId: string): Promise<void> {
    await this.delete(leaseId);
  }

  private scheduleExpiry(leaseId: string, expiresAt: number): void {
    this.clearExpiry(leaseId);
    const delay = expiresAt - Date.now();
    if (delay > 0) {
      const timer = setTimeout(() => {
        this.expire(leaseId);
      }, delay);
      this.expiries.set(leaseId, timer);
    }
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

  constructor(store: RegistryStore, defaultTtlMs = 30000) {
    this.store = store;
    this.defaultTtlMs = defaultTtlMs;
  }

  async register(registration: ServiceRegistration): Promise<ServiceLease> {
    const leaseId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + this.defaultTtlMs;

    const instance: ServiceInstance = {
      serviceId: registration.serviceId,
      instanceId: registration.instanceId,
      endpoints: registration.endpoints,
      status: 'healthy',
      lastHeartbeat: now,
      leaseExpiresAt: expiresAt,
      capabilities: registration.capabilities,
      metadata: registration.metadata,
    };

    await this.store.set(leaseId, instance);

    return {
      leaseId,
      serviceId: registration.serviceId,
      instanceId: registration.instanceId,
      expiresAt,
      ttlMs: this.defaultTtlMs,
    };
  }

  async renew(leaseId: string): Promise<void> {
    const instance = await this.store.get(leaseId);
    if (!instance) {
      throw new Error(`Lease not found: ${leaseId}`);
    }

    if (instance.leaseExpiresAt < Date.now()) {
      throw new Error(`Lease expired: ${leaseId}`);
    }

    const now = Date.now();
    const expiresAt = now + this.defaultTtlMs;

    await this.store.set(leaseId, {
      ...instance,
      lastHeartbeat: now,
      leaseExpiresAt: expiresAt,
    });
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
    const instances = await this.store.query({ 
      serviceId: health.serviceId,
      limit: 100 
    });

    for (const instance of instances) {
      if (instance.instanceId === health.instanceId) {
        await this.store.set(`${instance.serviceId}:${instance.instanceId}`, {
          ...instance,
          status: health.status,
          lastHeartbeat: health.timestamp,
        });
        break;
      }
    }
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
          return async (...args: any[]) => {
            // Ensure connected before any operation
            if (!(target as any).driverAdapter) {
              await (target as any).connect();
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
  
  return new ServiceRegistryImpl(store, config.ttlMs);
}