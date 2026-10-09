import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LeaseManager,
  DefaultLeaseManager,
  createLeaseManager,
} from '../../src/registry/leases.js';
import { ServiceRegistry, ServiceInstance, ServiceRegistration, InMemoryRegistryStore, ServiceRegistryImpl } from '../../src/registry/registry.js';

describe('DefaultLeaseManager', () => {
  let store: InMemoryRegistryStore;
  let registry: ServiceRegistry;
  let leaseManager: LeaseManager;

  beforeEach(() => {
    store = new InMemoryRegistryStore();
    registry = new ServiceRegistryImpl(store, 30000);
    leaseManager = createLeaseManager(registry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should acquire lease', async () => {
    const lease = await leaseManager.acquire({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
    });

    expect(lease).toBeDefined();
    expect(lease.leaseId).toBeDefined();
    expect(lease.serviceId).toBe('svc-1');
    expect(lease.instanceId).toBe('inst-1');
    expect(lease.expiresAt).toBeGreaterThan(Date.now());
    expect(lease.ttlMs).toBe(30000);
  });

  it('should renew lease', async () => {
    const lease = await leaseManager.acquire({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
    });

    const originalExpiry = lease.expiresAt;
    await new Promise(resolve => setTimeout(resolve, 10));

    await leaseManager.renew(lease.leaseId);

    const updatedLease = await leaseManager.getLease(lease.leaseId);
    expect(updatedLease!.expiresAt).toBeGreaterThan(originalExpiry);
  });

  it('should release lease', async () => {
    const lease = await leaseManager.acquire({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
    });

    await leaseManager.release(lease.leaseId);

    const releasedLease = await leaseManager.getLease(lease.leaseId);
    expect(releasedLease).toBeNull();
  });

  it('should get lease by ID', async () => {
    const lease = await leaseManager.acquire({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
    });

    const retrieved = await leaseManager.getLease(lease.leaseId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.serviceId).toBe('svc-1');
    expect(retrieved!.instanceId).toBe('inst-1');
  });

  it('should return null for non-existent lease', async () => {
    const retrieved = await leaseManager.getLease('non-existent');
    expect(retrieved).toBeNull();
  });

  it('should check if lease is expired', async () => {
    vi.useFakeTimers();

    const lease = await leaseManager.acquire({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
    });

    expect(await leaseManager.isExpired(lease.leaseId)).toBe(false);

    // Advance past TTL
    vi.advanceTimersByTime(40000);

    // Trigger cleanup
    await store.set('dummy', {
      serviceId: 'dummy',
      instanceId: 'dummy',
      endpoints: [],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 1000,
      capabilities: [],
      metadata: {},
    });
    await store.query({});

    expect(await leaseManager.isExpired(lease.leaseId)).toBe(true);
  });

  it('should return true for non-existent lease isExpired', async () => {
    expect(await leaseManager.isExpired('non-existent')).toBe(true);
  });
});

describe('createLeaseManager', () => {
  let store: InMemoryRegistryStore;
  let registry: ServiceRegistry;

  beforeEach(() => {
    store = new InMemoryRegistryStore();
    registry = new ServiceRegistryImpl(store, 30000);
  });

  it('should create lease manager', () => {
    const manager = createLeaseManager(registry);
    expect(manager).toBeInstanceOf(DefaultLeaseManager);
  });
});

describe('LeaseManager - Adversarial and Edge Case Tests', () => {
  let store: InMemoryRegistryStore;
  let registry: ServiceRegistry;
  let leaseManager: LeaseManager;

  beforeEach(() => {
    store = new InMemoryRegistryStore();
    registry = new ServiceRegistryImpl(store, 30000);
    leaseManager = createLeaseManager(registry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should handle concurrent acquisitions', async () => {
    const leases = await Promise.all([
      leaseManager.acquire({
        serviceId: 'svc-1',
        instanceId: 'inst-1',
        endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
        capabilities: ['api'],
        metadata: {},
      }),
      leaseManager.acquire({
        serviceId: 'svc-2',
        instanceId: 'inst-2',
        endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8081 }],
        capabilities: ['api'],
        metadata: {},
      }),
      leaseManager.acquire({
        serviceId: 'svc-3',
        instanceId: 'inst-3',
        endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8082 }],
        capabilities: ['api'],
        metadata: {},
      }),
    ]);

    expect(leases).toHaveLength(3);
    expect(new Set(leases.map(l => l.leaseId)).size).toBe(3);
  });

  it('should handle concurrent renewals', async () => {
    const lease = await leaseManager.acquire({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
    });

    await Promise.all([
      leaseManager.renew(lease.leaseId),
      leaseManager.renew(lease.leaseId),
      leaseManager.renew(lease.leaseId),
    ]);

    const updated = await leaseManager.getLease(lease.leaseId);
    expect(updated!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('should handle acquire and immediate release', async () => {
    const lease = await leaseManager.acquire({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
    });

    await leaseManager.release(lease.leaseId);
    expect(await leaseManager.getLease(lease.leaseId)).toBeNull();
  });

  it('should handle rapid acquire/release cycles', async () => {
    for (let i = 0; i < 50; i++) {
      const lease = await leaseManager.acquire({
        serviceId: 'svc-1',
        instanceId: `inst-${i}`,
        endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
        capabilities: ['api'],
        metadata: {},
      });
      await leaseManager.release(lease.leaseId);
    }

    const instances = await registry.discover({ serviceId: 'svc-1' });
    expect(instances).toHaveLength(0);
  });

  it('should handle large metadata in lease', async () => {
    const largeMetadata = {
      config: { settings: Array.from({ length: 100 }, (_, i) => i) },
      tags: Array.from({ length: 50 }, (_, i) => `tag-${i}`),
      description: 'x'.repeat(5000),
    };

    const lease = await leaseManager.acquire({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: largeMetadata,
    });

    const retrieved = await leaseManager.getLease(lease.leaseId);
    expect(retrieved).not.toBeNull();
  });

  it('should handle special characters in service/instance IDs', async () => {
    const lease = await leaseManager.acquire({
      serviceId: '550e8400-e29b-41d4-a716-446655440000',
      instanceId: '660e8400-e29b-41d4-a716-446655440001',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
    });

    expect(lease.serviceId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(lease.instanceId).toBe('660e8400-e29b-41d4-a716-446655440001');
  });

  it('should handle multiple endpoints', async () => {
    const lease = await leaseManager.acquire({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [
        { protocol: 'tcp', host: 'localhost', port: 8080 },
        { protocol: 'grpc', host: 'localhost', port: 9090 },
        { protocol: 'http', host: 'localhost', port: 3000 },
      ],
      capabilities: ['api', 'grpc'],
      metadata: {},
    });

    // getLease returns ServiceLease (not the full instance with endpoints)
    // To check endpoints, we need to query the registry
    const retrieved = await leaseManager.getLease(lease.leaseId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.serviceId).toBe('svc-1');
    expect(retrieved!.instanceId).toBe('inst-1');
    expect(retrieved!.ttlMs).toBeGreaterThan(0);
    expect(retrieved!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('should return correct TTL calculation', async () => {
    vi.useFakeTimers();

    const lease = await leaseManager.acquire({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      capabilities: ['api'],
      metadata: {},
    });

    const initialTtl = lease.ttlMs;
    expect(initialTtl).toBe(30000);

    vi.advanceTimersByTime(10000);

    const currentLease = await leaseManager.getLease(lease.leaseId);
    // TTL should be decreased by the advanced time
    expect(currentLease!.ttlMs).toBeLessThan(initialTtl);
    expect(currentLease!.ttlMs).toBeGreaterThan(0);
  });
});