import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RedisRegistryStore } from '../../src/registry/redis/adapter.js';
import { RedisAdapterConfig } from '../../src/registry/redis/types.js';
import { RegistryStore, ServiceInstance } from '../../src/registry/registry.js';

function makeConfig(overrides: Partial<RedisAdapterConfig> = {}): RedisAdapterConfig {
  return {
    driver: 'ioredis',
    host: 'localhost',
    port: 6379,
    ...overrides,
  };
}

function makeInstance(overrides: Partial<ServiceInstance> = {}): ServiceInstance {
  return {
    serviceId: 'svc-1',
    instanceId: 'inst-1',
    endpoints: [{ protocol: 'tcp', host: 'localhost', port: 8080 }],
    status: 'healthy',
    lastHeartbeat: Date.now(),
    leaseExpiresAt: Date.now() + 30000,
    capabilities: ['test'],
    metadata: {},
    ...overrides,
  };
}

function createFakeStore(): RegistryStore {
  const store = new Map<string, ServiceInstance>();
  return {
    set: vi.fn(async (leaseId: string, instance: ServiceInstance) => {
      store.set(leaseId, instance);
    }),
    get: vi.fn(async (leaseId: string) => store.get(leaseId) ?? null),
    delete: vi.fn(async (leaseId: string) => {
      store.delete(leaseId);
    }),
    query: vi.fn(async () => Array.from(store.values())),
    expire: vi.fn(async (leaseId: string) => {
      store.delete(leaseId);
    }),
  };
}

describe('RedisRegistryStore construction', () => {
  it('should default resolved driver to node-redis', () => {
    const store = new RedisRegistryStore(makeConfig());
    expect(store.getResolvedDriver()).toBe('node-redis');
  });

  it('should not be connected initially', () => {
    const store = new RedisRegistryStore(makeConfig());
    expect((store as any).driverAdapter).toBeNull();
  });
});

describe('RedisRegistryStore before connect', () => {
  let store: RedisRegistryStore;

  beforeEach(() => {
    store = new RedisRegistryStore(makeConfig());
  });

  it('should reject set when not connected', async () => {
    await expect(store.set('lease-1', makeInstance())).rejects.toThrow(
      /Redis store not connected/,
    );
  });

  it('should reject get when not connected', async () => {
    await expect(store.get('lease-1')).rejects.toThrow(/Redis store not connected/);
  });

  it('should reject delete when not connected', async () => {
    await expect(store.delete('lease-1')).rejects.toThrow(/Redis store not connected/);
  });

  it('should reject query when not connected', async () => {
    await expect(store.query({})).rejects.toThrow(/Redis store not connected/);
  });

  it('should reject expire when not connected', async () => {
    await expect(store.expire('lease-1')).rejects.toThrow(/Redis store not connected/);
  });
});

describe('RedisRegistryStore delegation', () => {
  let store: RedisRegistryStore;
  let fakeStore: ReturnType<typeof createFakeStore>;

  beforeEach(() => {
    store = new RedisRegistryStore(makeConfig({ driver: 'ioredis' }));
    fakeStore = createFakeStore();
    (store as any).driverAdapter = fakeStore;
    (store as any).resolvedDriver = 'ioredis';
  });

  it('should delegate set to the driver adapter', async () => {
    const instance = makeInstance();
    await store.set('lease-1', instance);
    expect(fakeStore.set).toHaveBeenCalledWith('lease-1', instance);
  });

  it('should delegate get to the driver adapter', async () => {
    const instance = makeInstance();
    (fakeStore.get as any).mockResolvedValueOnce(instance);
    const result = await store.get('lease-1');
    expect(result).toBe(instance);
    expect(fakeStore.get).toHaveBeenCalledWith('lease-1');
  });

  it('should delegate delete to the driver adapter', async () => {
    await store.delete('lease-1');
    expect(fakeStore.delete).toHaveBeenCalledWith('lease-1');
  });

  it('should delegate query to the driver adapter', async () => {
    await store.query({ serviceId: 'svc-1' });
    expect(fakeStore.query).toHaveBeenCalledWith({ serviceId: 'svc-1' });
  });

  it('should delegate expire to the driver adapter', async () => {
    await store.expire('lease-1');
    expect(fakeStore.expire).toHaveBeenCalledWith('lease-1');
  });

  it('should report the resolved driver', () => {
    expect(store.getResolvedDriver()).toBe('ioredis');
  });
});

describe('RedisRegistryStore disconnect', () => {
  it('should clear the driver adapter on disconnect', async () => {
    const store = new RedisRegistryStore(makeConfig());
    (store as any).driverAdapter = createFakeStore();
    await store.disconnect();
    expect((store as any).driverAdapter).toBeNull();
  });

  it('should be safe to call disconnect before connect', async () => {
    const store = new RedisRegistryStore(makeConfig());
    await expect(store.disconnect()).resolves.toBeUndefined();
  });
});