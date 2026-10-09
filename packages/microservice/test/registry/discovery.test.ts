import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ServiceDiscovery,
  DiscoveryOptions,
  DiscoveryResult,
  createDiscovery,
} from '../../src/registry/discovery.js';
import { ServiceRegistry, ServiceInstance, ServiceQuery, InMemoryRegistryStore, ServiceRegistryImpl } from '../../src/registry/registry.js';

describe('ServiceDiscovery', () => {
  let store: InMemoryRegistryStore;
  let registry: ServiceRegistry;
  let discovery: ServiceDiscovery;

  beforeEach(() => {
    store = new InMemoryRegistryStore();
    registry = new ServiceRegistryImpl(store, 30000);
    discovery = createDiscovery(registry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create discovery with default options', () => {
    const d = createDiscovery(registry);
    expect(d).toBeInstanceOf(ServiceDiscovery);
    expect(d.getCacheStats().maxSize).toBe(100);
  });

  it('should create discovery with custom options', () => {
    const options: DiscoveryOptions = { cacheTtlMs: 10000, maxCacheSize: 50 };
    const d = createDiscovery(registry, options);
    expect(d.getCacheStats().maxSize).toBe(50);
  });

  it('should discover services and cache result', async () => {
    const instance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    await store.set('lease-1', instance);

    const result1 = await discovery.discover({ serviceId: 'svc-1' });
    expect(result1.instances).toHaveLength(1);
    expect(result1.fromCache).toBe(false);

    // Second call should use cache
    const result2 = await discovery.discover({ serviceId: 'svc-1' });
    expect(result2.fromCache).toBe(true);
    expect(result2.instances).toHaveLength(1);
  });

  it('should respect cache TTL', async () => {
    vi.useFakeTimers();

    const instance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    await store.set('lease-1', instance);

    const discoveryWithShortTtl = createDiscovery(registry, { cacheTtlMs: 1000, maxCacheSize: 100 });

    await discoveryWithShortTtl.discover({ serviceId: 'svc-1' });
    expect(discoveryWithShortTtl.getCacheStats().size).toBe(1);

    // Advance time past cache TTL
    vi.advanceTimersByTime(1500);

    const result = await discoveryWithShortTtl.discover({ serviceId: 'svc-1' });
    expect(result.fromCache).toBe(false);
  });

  it('should return different results for different queries', async () => {
    const instance1: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    const instance2: ServiceInstance = {
      serviceId: 'svc-2',
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

    const result1 = await discovery.discover({ serviceId: 'svc-1' });
    const result2 = await discovery.discover({ serviceId: 'svc-2' });

    expect(result1.instances[0].serviceId).toBe('svc-1');
    expect(result2.instances[0].serviceId).toBe('svc-2');
    expect(discovery.getCacheStats().size).toBe(2);
  });

  it('should get instance by serviceId and instanceId', async () => {
    const instance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    await store.set('lease-1', instance);

    const result = await discovery.getInstance('svc-1', 'inst-1');
    expect(result).not.toBeNull();
    expect(result!.instanceId).toBe('inst-1');
  });

  it('should return null for non-existent instance', async () => {
    const result = await discovery.getInstance('svc-1', 'non-existent');
    expect(result).toBeNull();
  });

  it('should get healthy instances', async () => {
    const healthyInstance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    const degradedInstance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-2',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8081 }],
      status: 'degraded',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    await store.set('lease-1', healthyInstance);
    await store.set('lease-2', degradedInstance);

    const results = await discovery.getHealthyInstances('svc-1');
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('healthy');
  });

  it('should invalidate cache for specific query', async () => {
    const instance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    await store.set('lease-1', instance);

    await discovery.discover({ serviceId: 'svc-1' });
    expect(discovery.getCacheStats().size).toBe(1);

    discovery.invalidateCache({ serviceId: 'svc-1' });
    expect(discovery.getCacheStats().size).toBe(0);
  });

  it('should invalidate all cache', async () => {
    const instance1: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    const instance2: ServiceInstance = {
      serviceId: 'svc-2',
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

    await discovery.discover({ serviceId: 'svc-1' });
    await discovery.discover({ serviceId: 'svc-2' });
    expect(discovery.getCacheStats().size).toBe(2);

    discovery.invalidateCache();
    expect(discovery.getCacheStats().size).toBe(0);
  });

  it('should return cache stats', async () => {
    const stats = discovery.getCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.maxSize).toBe(100);
  });
});

describe('ServiceDiscovery - Adversarial and Edge Case Tests', () => {
  let store: InMemoryRegistryStore;
  let registry: ServiceRegistry;
  let discovery: ServiceDiscovery;

  beforeEach(() => {
    store = new InMemoryRegistryStore();
    registry = new ServiceRegistryImpl(store, 30000);
    discovery = createDiscovery(registry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should handle concurrent discoveries', async () => {
    const instance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    await store.set('lease-1', instance);

    const results = await Promise.all([
      discovery.discover({ serviceId: 'svc-1' }),
      discovery.discover({ serviceId: 'svc-1' }),
      discovery.discover({ serviceId: 'svc-1' }),
    ]);

    expect(results).toHaveLength(3);
    results.forEach(r => expect(r.instances).toHaveLength(1));
  });

  it('should handle cache eviction when max size reached', async () => {
    const smallDiscovery = createDiscovery(registry, { cacheTtlMs: 60000, maxCacheSize: 2 });

    for (let i = 0; i < 3; i++) {
      const instance: ServiceInstance = {
        serviceId: `svc-${i}`,
        instanceId: `inst-${i}`,
        endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 + i }],
        status: 'healthy',
        lastHeartbeat: Date.now(),
        leaseExpiresAt: Date.now() + 30000,
        capabilities: ['api'],
        metadata: {},
      };
      await store.set(`lease-${i}`, instance);
      await smallDiscovery.discover({ serviceId: `svc-${i}` });
    }

    // Should only keep maxCacheSize (2) entries
    expect(smallDiscovery.getCacheStats().size).toBeLessThanOrEqual(2);
  });

  it('should handle empty query results', async () => {
    const result = await discovery.discover({ serviceId: 'unknown' });
    expect(result.instances).toHaveLength(0);
    expect(result.fromCache).toBe(false);
  });

  it('should handle query with limit', async () => {
    for (let i = 0; i < 5; i++) {
      const instance: ServiceInstance = {
        serviceId: 'svc-1',
        instanceId: `inst-${i}`,
        endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 + i }],
        status: 'healthy',
        lastHeartbeat: Date.now(),
        leaseExpiresAt: Date.now() + 30000,
        capabilities: ['api'],
        metadata: {},
      };
      await store.set(`lease-${i}`, instance);
    }

    const result = await discovery.discover({ serviceId: 'svc-1', limit: 3 });
    expect(result.instances).toHaveLength(3);
  });

  it('should handle cache with different query structures', async () => {
    const instance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    await store.set('lease-1', instance);

    // Query with different options should create separate cache entries
    await discovery.discover({ serviceId: 'svc-1' });
    await discovery.discover({ serviceId: 'svc-1', status: 'healthy' });
    await discovery.discover({ serviceId: 'svc-1', capability: 'api' });

    expect(discovery.getCacheStats().size).toBe(3);
  });

  it('should not cache results with non-serializable query', async () => {
    // This shouldn't happen in practice, but let's ensure it doesn't crash
    const queryWithFunction = { serviceId: 'svc-1', customFn: () => {} } as any;
    
    const result = await discovery.discover(queryWithFunction);
    expect(result).toBeDefined();
  });
});