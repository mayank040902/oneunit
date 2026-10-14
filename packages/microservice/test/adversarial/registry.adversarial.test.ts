import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryRegistryStore, ServiceRegistryImpl } from '../../src/registry/registry.js';

describe('Registry - Adversarial Concurrency Tests', () => {
  let store: InMemoryRegistryStore;
  
  beforeEach(() => {
    store = new InMemoryRegistryStore();
  });

  it('should handle concurrent renewals', async () => {
    const leaseId = 'lease-1';
    const instance = {
      serviceId: 'svc-1',
      serviceName: 'svc',
      instanceId: 'inst-1',
      endpoints: [],
      status: 'healthy' as const,
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 10000,
      capabilities: [],
      metadata: {},
    };
    await store.set(leaseId, instance);
    
    const results = await Promise.all(
      Array(10).fill(0).map(() => store.renew(leaseId, 5000))
    );
    expect(results.every(r => r === 'renewed')).toBe(true);
  });

  it('should return not-found for unknown lease', async () => {
    const result = await store.renew('unknown', 1000);
    expect(result).toBe('not-found');
  });

  it('should handle expiration correctly', async () => {
    const leaseId = 'lease-exp';
    const instance = {
      serviceId: 'svc-1',
      serviceName: 'svc',
      instanceId: 'inst-1',
      endpoints: [],
      status: 'healthy' as const,
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() - 1000,
      capabilities: [],
      metadata: {},
    };
    await store.set(leaseId, instance);
    const result = await store.renew(leaseId, 5000);
    expect(result).toBe('expired');
  });

  it('should update health for existing instance', async () => {
    const leaseId = 'lease-h';
    const instance = {
      serviceId: 'svc-1',
      serviceName: 'svc',
      instanceId: 'inst-1',
      endpoints: [],
      status: 'healthy' as const,
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 10000,
      capabilities: [],
      metadata: {},
    };
    await store.set(leaseId, instance);
    const updated = await store.updateInstanceHealth('svc-1', 'inst-1', 'unhealthy', Date.now());
    expect(updated).toBe(true);
    const retrieved = await store.get(leaseId);
    expect(retrieved?.status).toBe('unhealthy');
  });
});
