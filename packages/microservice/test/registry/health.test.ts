import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HealthChecker,
  DefaultHealthChecker,
  createHealthChecker,
  HealthCheckResult,
} from '../../src/registry/health.js';
import { ServiceRegistry, ServiceInstance, InMemoryRegistryStore, ServiceRegistryImpl } from '../../src/registry/registry.js';

describe('DefaultHealthChecker', () => {
  let store: InMemoryRegistryStore;
  let registry: ServiceRegistry;
  let healthChecker: HealthChecker;

  beforeEach(() => {
    store = new InMemoryRegistryStore();
    registry = new ServiceRegistryImpl(store, 30000);
    healthChecker = createHealthChecker(registry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create health checker', () => {
    const checker = createHealthChecker(registry);
    expect(checker).toBeInstanceOf(DefaultHealthChecker);
  });

  it('should check instance health via heartbeat', async () => {
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

    const result = await healthChecker.check('svc-1', 'inst-1');

    expect(result).toBeDefined();
    expect(result.serviceId).toBe('svc-1');
    expect(result.instanceId).toBe('inst-1');
    expect(result.status).toBe('healthy');
    expect(result.checkedAt).toBeDefined();
    expect(result.details).toBeDefined();
    expect(result.details!.timeSinceHeartbeat).toBeLessThan(100);
  });

  it('should return degraded for stale heartbeat', async () => {
    vi.useFakeTimers();

    const instance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now() - 70000, // 70 seconds ago (more than 60s threshold)
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    await store.set('lease-1', instance);

    const result = await healthChecker.check('svc-1', 'inst-1');

    expect(result.status).toBe('degraded');
    expect(result.details!.timeSinceHeartbeat).toBeGreaterThan(60000);
  });

  it('should return unhealthy for non-existent instance', async () => {
    const result = await healthChecker.check('svc-1', 'non-existent');

    expect(result.status).toBe('unhealthy');
    expect(result.details!.error).toBe('Instance not found');
  });

  it('should use custom checker when registered', async () => {
    const customChecker = vi.fn().mockResolvedValue({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      status: 'healthy' as const,
      checkedAt: Date.now(),
      details: { custom: 'check' },
    });

    healthChecker.registerChecker('svc-1', customChecker);

    const result = await healthChecker.check('svc-1', 'inst-1');

    expect(customChecker).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('healthy');
    expect(result.details!.custom).toBe('check');
  });

  it('should check all registered services', async () => {
    const checker1 = vi.fn().mockResolvedValue({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      status: 'healthy' as const,
      checkedAt: Date.now(),
    });

    const checker2 = vi.fn().mockResolvedValue({
      serviceId: 'svc-2',
      instanceId: 'inst-2',
      status: 'degraded' as const,
      checkedAt: Date.now(),
    });

    healthChecker.registerChecker('svc-1', checker1);
    healthChecker.registerChecker('svc-2', checker2);

    const results = await healthChecker.checkAll();

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('healthy');
    expect(results[1].status).toBe('degraded');
  });

  it('should handle checker errors gracefully', async () => {
    const failingChecker = vi.fn().mockRejectedValue(new Error('Check failed'));

    healthChecker.registerChecker('svc-1', failingChecker);

    const results = await healthChecker.checkAll();

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('unhealthy');
    expect(results[0].details!.error).toBe('Check failed');
  });

  it('should handle empty checkers map', async () => {
    const results = await healthChecker.checkAll();
    expect(results).toHaveLength(0);
  });
});

describe('HealthChecker - Adversarial and Edge Case Tests', () => {
  let store: InMemoryRegistryStore;
  let registry: ServiceRegistry;
  let healthChecker: HealthChecker;

  beforeEach(() => {
    store = new InMemoryRegistryStore();
    registry = new ServiceRegistryImpl(store, 30000);
    healthChecker = createHealthChecker(registry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should handle concurrent health checks', async () => {
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
      healthChecker.check('svc-1', 'inst-1'),
      healthChecker.check('svc-1', 'inst-1'),
      healthChecker.check('svc-1', 'inst-1'),
    ]);

    expect(results).toHaveLength(3);
    results.forEach(r => expect(r.status).toBe('healthy'));
  });

  it('should handle multiple services with custom checkers', async () => {
    for (let i = 0; i < 5; i++) {
      const svcId = `svc-${i}`;
      healthChecker.registerChecker(svcId, vi.fn().mockResolvedValue({
        serviceId: svcId,
        instanceId: `inst-${i}`,
        status: 'healthy' as const,
        checkedAt: Date.now(),
      }));
    }

    const results = await healthChecker.checkAll();
    expect(results).toHaveLength(5);
  });

  it('should handle checker that returns unhealthy', async () => {
    const unhealthyChecker = vi.fn().mockResolvedValue({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      status: 'unhealthy' as const,
      checkedAt: Date.now(),
      details: { reason: 'disk full' },
    });

    healthChecker.registerChecker('svc-1', unhealthyChecker);

    const results = await healthChecker.checkAll();
    expect(results[0].status).toBe('unhealthy');
    expect(results[0].details!.reason).toBe('disk full');
  });

  it('should handle checker throwing synchronous error', async () => {
    const syncErrorChecker = vi.fn(() => {
      throw new Error('Sync error');
    });

    healthChecker.registerChecker('svc-1', syncErrorChecker);

    const results = await healthChecker.checkAll();
    expect(results[0].status).toBe('unhealthy');
    expect(results[0].details!.error).toBe('Sync error');
  });

  it('should handle very old heartbeat', async () => {
    vi.useFakeTimers();

    const instance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'healthy',
      lastHeartbeat: Date.now() - 86400000, // 24 hours ago
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    await store.set('lease-1', instance);

    const result = await healthChecker.check('svc-1', 'inst-1');
    expect(result.status).toBe('degraded');
    expect(result.details!.timeSinceHeartbeat).toBeGreaterThan(60000);
  });

  it('should return correct result structure', async () => {
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

    const result = await healthChecker.check('svc-1', 'inst-1');

    // Verify all required fields
    expect(result).toHaveProperty('serviceId');
    expect(result).toHaveProperty('instanceId');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('checkedAt');
    expect(result).toHaveProperty('details');
    expect(typeof result.serviceId).toBe('string');
    expect(typeof result.instanceId).toBe('string');
    expect(['healthy', 'degraded', 'unhealthy']).toContain(result.status);
    expect(typeof result.checkedAt).toBe('number');
    expect(typeof result.details).toBe('object');
  });

  it('should handle checker returning additional details', async () => {
    const detailedChecker = vi.fn().mockResolvedValue({
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      status: 'healthy' as const,
      checkedAt: Date.now(),
      details: { cpu: 45, memory: 60, disk: 30 },
    });

    healthChecker.registerChecker('svc-1', detailedChecker);

    const result = await healthChecker.check('svc-1', 'inst-1');
    expect(result.details!.cpu).toBe(45);
    expect(result.details!.memory).toBe(60);
    expect(result.details!.disk).toBe(30);
  });

  it('should handle instance with different status in registry', async () => {
    const instance: ServiceInstance = {
      serviceId: 'svc-1',
      instanceId: 'inst-1',
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
      status: 'degraded', // Already degraded in registry
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 30000,
      capabilities: ['api'],
      metadata: {},
    };

    await store.set('lease-1', instance);

    // The checker doesn't use the registry status, it uses heartbeat
    const result = await healthChecker.check('svc-1', 'inst-1');
    expect(result.status).toBe('healthy'); // Based on heartbeat, not registry status
  });
});