import { ServiceLease, ServiceInstance } from './registry.js';
import { ServiceRegistry } from './registry.js';

export interface LeaseManager {
  acquire(registration: { serviceId: string; instanceId: string; endpoints: ServiceInstance['endpoints']; capabilities: string[]; metadata: Record<string, unknown> }): Promise<ServiceLease>;
  renew(leaseId: string): Promise<void>;
  release(leaseId: string): Promise<void>;
  getLease(leaseId: string): Promise<ServiceLease | null>;
  isExpired(leaseId: string): Promise<boolean>;
}

export class DefaultLeaseManager implements LeaseManager {
  private registry: ServiceRegistry;

  constructor(registry: ServiceRegistry) {
    this.registry = registry;
  }

  async acquire(registration: { serviceId: string; instanceId: string; endpoints: ServiceInstance['endpoints']; capabilities: string[]; metadata: Record<string, unknown> }): Promise<ServiceLease> {
    return this.registry.register(registration as any);
  }

  async renew(leaseId: string): Promise<void> {
    return this.registry.renew(leaseId);
  }

  async release(leaseId: string): Promise<void> {
    return this.registry.deregister(leaseId);
  }

  async getLease(leaseId: string): Promise<ServiceLease | null> {
    const instance = await this.registry.getInstance(leaseId);
    if (!instance) return null;
    
    return {
      leaseId,
      serviceId: instance.serviceId,
      instanceId: instance.instanceId,
      expiresAt: instance.leaseExpiresAt,
      ttlMs: instance.leaseExpiresAt - Date.now(),
    };
  }

  async isExpired(leaseId: string): Promise<boolean> {
    const lease = await this.getLease(leaseId);
    if (!lease) return true;
    return lease.expiresAt < Date.now();
  }
}

export function createLeaseManager(registry: ServiceRegistry): LeaseManager {
  return new DefaultLeaseManager(registry);
}