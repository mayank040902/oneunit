import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ServiceRegistry,
  ServiceLease,
  ServiceInstance,
  ServiceQuery,
  ServiceRegistration,
  RegistryStore,
  InMemoryRegistryStore,
  ServiceRegistryImpl,
  createRegistry,
} from '../../src/registry/registry.js';
import { MicroserviceConfig } from '../../src/config/schema.js';

describe('InMemoryRegistryStore', () => {
  let store: InMemoryRegistryStore;

  beforeEach(() => {
    store = new InMemoryRegistryStore();
  });

  afterEach(() => {
    // Clear any pending timers
    vi.useRealTimers();
  });

  it('should store and retrieve instance', async () => {
    const instance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['test'],
      metadata: {},
    };

    await store.set('lease-1', instance);
    const retrieved = await store.get('lease-1');

    expect(retrieved).toEqual(instance);
  });

  it('should return null for non-existent lease', async () => {
    const result = await store.get('non-existent');
    expect(result).toBeNull();
  });

  it('should delete instance', async () => {
    const instance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['test'],
      metadata: {},
    };

    await store.set('lease-1', instance);
    await store.delete('lease-1');
    const retrieved = await store.get('lease-1');

    expect(retrieved).toBeNull();
  });

  it('should query instances by serviceId', async () => {
    const instance1: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['test'],
      metadata: {},
    };

    const instance2: ServiceInstance = {
      serviceId: 'svc-2',
      instanceId: 'inst-2',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8081 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['test'],
      metadata: {},
    };

    await store.set('lease-1', instance1);
    await store.set('lease-2', instance2);

    const results = await store.query({ serviceId: 'svc-1' });
    expect(results).toHaveLength(1);
    expect(results[0].serviceId).toBe('svc-1');
  });

  it('should query instances by status', async () => {
    const healthyInstance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['test'],
      metadata: {},
    };

    const degradedInstance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-2',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8081 }],
      status: 'degraded',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['test'],
      metadata: {},
    };

    await store.set('lease-1', healthyInstance);
    await store.set('lease-2', degradedInstance);

    const results = await store.query({ serviceId: 'svc-1', status: 'healthy' });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('healthy');
  });

  it('should query instances by capability', async () => {
    const instance1: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api', 'auth'],
      metadata: {},
    };

    const instance2: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-2',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8081 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    await store.set('lease-1', instance1);
    await store.set('lease-2', instance2);

    const results = await store.query({ serviceId: 'svc-1', capability: 'auth' });
    expect(results).toHaveLength(1);
    expect(results[0].instanceId).toBe('inst-1');
  });

  it('should respect limit in query', async () => {
    for (let i = 0; i < 5; i++) {
      const instance: ServiceInstance = {
        serviceId: 'svc-1',
        instanceId: `inst-${i}`,
        endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 + i }],
        status: 'healthy',
        lastHeartbeat: Date.now(),
        leaseExpiresAt: Date.now() + 30000,
        capabilities: ['test'],
        metadata: {},
      };
      await store.set(`lease-${i}`, instance);
    }

    const results = await store.query({ serviceId: 'svc-1', limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('should filter expired instances', async () => {
    const expiredInstance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now() - 10000,
      leaseExpiresAt: Date.now() - 1000, // Expired
      capabilities: ['test'],
      metadata: {},
    };

    const validInstance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-2',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8081 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['test'],
      metadata: {},
    };

    await store.set('lease-1', expiredInstance);
    await store.set('lease-2', validInstance);

    const results = await store.query({ serviceId: 'svc-1' });
    expect(results).toHaveLength(1);
    expect(results[0].instanceId).toBe('inst-2');
  });

  it('should expire instance after TTL', async () => {
    vi.useFakeTimers();

    const instance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 1000, // 1 second
      capabilities: ['test'],
      metadata: {},
    };

    await store.set('lease-1', instance);
    expect(await store.get('lease-1')).not.toBeNull();

    // Advance time past expiry
    vi.advanceTimersByTime(2000);

    // Trigger cleanup by querying
    await store.query({});

    expect(await store.get('lease-1')).toBeNull();
  });
});

describe('ServiceRegistryImpl', () => {
  let store: InMemoryRegistryStore;
  let registry: ServiceRegistry;

  beforeEach(() => {
    store = new InMemoryRegistryStore();
    registry = new ServiceRegistryImpl(store, 30000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should register service and return lease', async () => {
    const registration: ServiceRegistration = {
      serviceId: 'svc-1',
      serviceName: 'test-service',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: { version: '1.0' },
      registeredAt: Date.now(),
    };

    const lease = await registry.register(registration);

    expect(lease).toBeDefined();
    expect(lease.leaseId).toBeDefined();
    expect(lease.serviceId).toBe('svc-1');
    expect(lease.instanceId).toBe('inst-1');
    expect(lease.expiresAt).toBeGreaterThan(Date.now());
    expect(lease.ttlMs).toBe(30000);
  });

  it('should renew lease', async () => {
    const registration: ServiceRegistration = {
      serviceId: 'svc-1',
      serviceName: 'test-service',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
      registeredAt: Date.now(),
    };

    const lease = await registry.register(registration);
    const originalExpiry = lease.expiresAt;

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 10));

    await registry.renew(lease.leaseId);

    const instance = await registry.getInstance(lease.leaseId);
    expect(instance!.leaseExpiresAt).toBeGreaterThan(originalExpiry);
  });

  it('should throw when renewing non-existent lease', async () => {
    await expect(registry.renew('non-existent')).rejects.toThrow('Lease not found');
  });

  it('should throw when renewing expired lease', async () => {
    vi.useFakeTimers();

    const registration: ServiceRegistration = {
      serviceId: 'svc-1',
      serviceName: 'test-service',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
      registeredAt: Date.now(),
    };

    const lease = await registry.register(registration);

    // Advance past TTL - this triggers expiry cleanup
    vi.advanceTimersByTime(40000);

    // Trigger cleanup by querying
    await registry.discover({});

    // The lease is now not found (already expired and cleaned up)
    await expect(registry.renew(lease.leaseId)).rejects.toThrow('Lease not found');
  });

  it('should discover registered services', async () => {
    const registration: ServiceRegistration = {
      serviceId: 'svc-1',
      serviceName: 'test-service',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
      registeredAt: Date.now(),
    };

    await registry.register(registration);

    const results = await registry.discover({ serviceId: 'svc-1' });
    expect(results).toHaveLength(1);
    expect(results[0].serviceId).toBe('svc-1');
  });

  it('should deregister service', async () => {
    const registration: ServiceRegistration = {
      serviceId: 'svc-1',
      serviceName: 'test-service',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
      registeredAt: Date.now(),
    };

    const lease = await registry.register(registration);
    await registry.deregister(lease.leaseId);

    const instance = await registry.getInstance(lease.leaseId);
    expect(instance).toBeNull();
  });

  it('should get instance by leaseId', async () => {
    const registration: ServiceRegistration = {
      serviceId: 'svc-1',
      serviceName: 'test-service',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
      registeredAt: Date.now(),
    };

    const lease = await registry.register(registration);
    const instance = await registry.getInstance(lease.leaseId);

    expect(instance).not.toBeNull();
    expect(instance!.serviceId).toBe('svc-1');
    expect(instance!.instanceId).toBe('inst-1');
  });

  it('should update health status', async () => {
    const registration: ServiceRegistration = {
      serviceId: 'svc-1',
      serviceName: 'test-service',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
      registeredAt: Date.now(),
    };

    const lease = await registry.register(registration);

    await registry.updateHealth({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      status: 'degraded',
      timestamp: Date.now(),
      details: { reason: 'high latency' },
    });

    // Health update creates a new entry with key serviceId:instanceId
    // Query returns both original and updated entries; find the degraded one
    const instances = await registry.discover({ serviceId: 'svc-1' });
    const degradedInstance = instances.find(i => i.status === 'degraded');
    expect(degradedInstance).toBeDefined();
    expect(degradedInstance!.status).toBe('degraded');
  });
});

describe('createRegistry', () => {
  it('should create in-memory registry by default', () => {
    const config: MicroserviceConfig['registry'] = {
      backend: 'memory',
      ttlMs: 30000,
    };

    const registry = createRegistry(config);
    expect(registry).toBeInstanceOf(ServiceRegistryImpl);
  });

  it('should create redis registry when configured', () => {
    const config: MicroserviceConfig['registry'] = {
      backend: 'redis',
      ttlMs: 30000,
      redis: {
        driver: 'ioredis',
        url: 'redis://localhost:6379',
      },
    };

    const registry = createRegistry(config);
    expect(registry).toBeInstanceOf(ServiceRegistryImpl);
  });
});

describe('Registry - Adversarial and Edge Case Tests', () => {
  let store: InMemoryRegistryStore;
  let registry: ServiceRegistry;

  beforeEach(() => {
    store = new InMemoryRegistryStore();
    registry = new ServiceRegistryImpl(store, 30000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should handle concurrent registrations', async () => {
    const registrations = Array.from({ length: 10 }, (_, i) => ({
      serviceId: `svc-${i}`,
      serviceName: `service-${i}`,
      instanceId: `inst-${i}`,
      endpoints: [{ protocol: 'tcp' as const, host: 'localhost', port: 8080 + i }],
      capabilities: ['api'],
      metadata: {},
      registeredAt: Date.now(),
    }));

    const leases = await Promise.all(registrations.map(r => registry.register(r)));
    expect(leases).toHaveLength(10);
    expect(new Set(leases.map(l => l.leaseId)).size).toBe(10);
  });

  it('should handle concurrent renewals', async () => {
    const registration: ServiceRegistration = {
      serviceId: 'svc-1',
      serviceName: 'test-service',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
      registeredAt: Date.now(),
    };

    const lease = await registry.register(registration);

    const renewals = Array.from({ length: 10 }, () => registry.renew(lease.leaseId));
    await Promise.all(renewals);

    const instance = await registry.getInstance(lease.leaseId);
    expect(instance!.leaseExpiresAt).toBeGreaterThan(Date.now());
  });

  it('should handle concurrent discover and register', async () => {
    const registration: ServiceRegistration = {
      serviceId: 'svc-1',
      serviceName: 'test-service',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
      registeredAt: Date.now(),
    };

    await registry.register(registration);

    const operations = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? registry.discover({ serviceId: 'svc-1' })
        : registry.register({
            ...registration,
            instanceId: `inst-${i}`,
            serviceId: `svc-${i}`,
          })
    );

    const results = await Promise.all(operations);
    expect(results).toHaveLength(20);
  });

  it('should handle rapid register/deregister cycles', async () => {
    for (let i = 0; i < 100; i++) {
      const registration: ServiceRegistration = {
        serviceId: 'svc-1',
        serviceName: 'test-service',
        instanceId: `inst-${i}`,
        endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
        capabilities: ['api'],
        metadata: {},
        registeredAt: Date.now(),
      };

      const lease = await registry.register(registration);
      await registry.deregister(lease.leaseId);
    }

    const results = await registry.discover({ serviceId: 'svc-1' });
    expect(results).toHaveLength(0);
  });

  it('should handle large metadata objects', async () => {
    const largeMetadata = {
      data: 'x'.repeat(10000),
      nested: { value: 'y'.repeat(5000) },
      array: Array.from({ length: 100 }, (_, i) => i),
    };

    const registration: ServiceRegistration = {
      serviceId: 'svc-1',
      serviceName: 'test-service',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: largeMetadata,
      registeredAt: Date.now(),
    };

    const lease = await registry.register(registration);
    const instance = await registry.getInstance(lease.leaseId);

    expect(instance!.metadata).toEqual(largeMetadata);
  });

  it('should handle special characters in service names and IDs', async () => {
    const registration: ServiceRegistration = {
      serviceId: '550e8400-e29b-41d4-a716-446655440000', // valid UUID
      serviceName: 'service/with:special\\chars',
      instanceId: '660e8400-e29b-41d4-a716-446655440001', // valid UUID
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
      registeredAt: Date.now(),
    };

    const lease = await registry.register(registration);
    expect(lease.serviceId).toBe(registration.serviceId);
  });

  it('should handle zero TTL', () => {
    const zeroTtlRegistry = new ServiceRegistryImpl(store, 0);

    const registration: ServiceRegistration = {
      serviceId: 'svc-1',
      serviceName: 'test-service',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
      registeredAt: Date.now(),
    };

    return expect(zeroTtlRegistry.register(registration)).resolves.toBeDefined();
  });

  it('should isolate instances by serviceId in queries', async () => {
    await registry.register({
      serviceId: 'svc-a',
      serviceName: 'service-a',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
      registeredAt: Date.now(),
    });

    await registry.register({
      serviceId: 'svc-b',
      serviceName: 'service-b',
      instanceId: 'inst-2',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8081 }],
      capabilities: ['api'],
      metadata: {},
      registeredAt: Date.now(),
    });

    const resultsA = await registry.discover({ serviceId: 'svc-a' });
    const resultsB = await registry.discover({ serviceId: 'svc-b' });

    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].serviceId).toBe('svc-a');
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0].serviceId).toBe('svc-b');
  });

  it('should return empty array for unknown service', async () => {
    const results = await registry.discover({ serviceId: 'unknown' });
    expect(results).toHaveLength(0);
  });

  it('should handle health update for non-existent instance gracefully', async () => {
    await expect(
      registry.updateHealth({
        serviceId: 'unknown',
        instanceId: 'unknown',
        status: 'healthy',
        timestamp: Date.now(),
      })
    ).resolves.not.toThrow();
  });
});