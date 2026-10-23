import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RedisAdapterConfig } from '@registry/redis/types.js';
import { RegistryStore, ServiceInstance } from '@registry/registry.js';

// Mock ioredis at the top level
const mockIORedisClient = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  scan: vi.fn().mockResolvedValue(['0', []]),
  eval: vi.fn().mockResolvedValue('renewed'),
  quit: vi.fn().mockResolvedValue('OK'),
  multi: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue([]),
  connect: vi.fn().mockResolvedValue(undefined),
};

vi.mock('ioredis', () => ({
  default: vi.fn(() => mockIORedisClient),
  Redis: vi.fn(() => mockIORedisClient),
}));

// Import after mocking
const { createRedisStore } = await import('@registry/redis/ioredis/adapter.js');

function makeConfig(overrides: Partial<RedisAdapterConfig> = {}): RedisAdapterConfig {
  return {
    driver: 'ioredis',
    host: 'localhost',
    port: 6379,
    keyPrefix: 'microservice:registry:',
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

describe('IORedis Driver Adapter', () => {
  let store: RegistryStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIORedisClient.get.mockResolvedValue(null);
    mockIORedisClient.set.mockResolvedValue('OK');
    mockIORedisClient.del.mockResolvedValue(1);
    mockIORedisClient.scan.mockResolvedValue(['0', []]);
    mockIORedisClient.eval.mockResolvedValue('renewed');
    mockIORedisClient.quit.mockResolvedValue('OK');
    mockIORedisClient.multi.mockReturnThis();
    mockIORedisClient.exec.mockResolvedValue([]);
    mockIORedisClient.connect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create store with ioredis client', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    expect(store).toBeDefined();
    expect(typeof store.set).toBe('function');
    expect(typeof store.get).toBe('function');
    expect(typeof store.delete).toBe('function');
    expect(typeof store.query).toBe('function');
    expect(typeof store.expire).toBe('function');
  });

  it('should connect to redis on creation', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    expect(mockIORedisClient.connect).toHaveBeenCalled();
  });

  it('should use custom key prefix', async () => {
    store = await createRedisStore(makeConfig({ keyPrefix: 'custom:' }), (await import('ioredis')).default);
    // The key prefix is used internally, verify by calling set
    await store.set('lease-1', makeInstance());
    expect(mockIORedisClient.set).toHaveBeenCalledWith('custom:lease-1', expect.any(String), 'EX', expect.any(Number));
  });

  it('should set instance with TTL', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    const instance = makeInstance({ leaseExpiresAt: Date.now() + 60000 });
    await store.set('lease-1', instance);

    expect(mockIORedisClient.set).toHaveBeenCalledWith(
      'microservice:registry:lease-1',
      JSON.stringify(instance),
      'EX',
      expect.any(Number)
    );
  });

  it('should get instance by leaseId', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    const instance = makeInstance();
    mockIORedisClient.get.mockResolvedValueOnce(JSON.stringify(instance));

    const result = await store.get('lease-1');

    expect(result).toEqual(instance);
    expect(mockIORedisClient.get).toHaveBeenCalledWith('microservice:registry:lease-1');
  });

  it('should return null for missing key', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    mockIORedisClient.get.mockResolvedValueOnce(null);

    const result = await store.get('missing-lease');

    expect(result).toBeNull();
  });

  it('should delete instance by leaseId', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    await store.delete('lease-1');

    expect(mockIORedisClient.del).toHaveBeenCalledWith('microservice:registry:lease-1');
  });

  it('should query instances with filters', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    
    const instance1 = makeInstance({ serviceId: 'svc-1', instanceId: 'inst-1' });
    const instance2 = makeInstance({ serviceId: 'svc-2', instanceId: 'inst-2' });
    
    mockIORedisClient.scan.mockResolvedValueOnce(['0', ['microservice:registry:lease-1', 'microservice:registry:lease-2']]);
    mockIORedisClient.multi.mockReturnThis();
    mockIORedisClient.get.mockReturnThis();
    mockIORedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({});

    expect(results).toHaveLength(2);
    expect(mockIORedisClient.scan).toHaveBeenCalledWith('0', 'MATCH', 'microservice:registry:*', 'COUNT', 100);
  });

  it('should page through SCAN cursors until the cursor returns to 0', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);

    const instance1 = makeInstance({ serviceId: 'svc-1', instanceId: 'inst-1' });
    const instance2 = makeInstance({ serviceId: 'svc-2', instanceId: 'inst-2' });

    // First page returns a non-zero cursor; the
    // collection loop must continue paging.
    mockIORedisClient.scan
      .mockResolvedValueOnce(['cursor-page-2', ['microservice:registry:lease-1']])
      .mockResolvedValueOnce(['0', ['microservice:registry:lease-2']]);
    mockIORedisClient.multi.mockReturnThis();
    mockIORedisClient.get.mockReturnThis();
    mockIORedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({});

    expect(results).toHaveLength(2);
    expect(mockIORedisClient.scan).toHaveBeenCalledTimes(2);
    expect(mockIORedisClient.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', 'microservice:registry:*', 'COUNT', 100);
    expect(mockIORedisClient.scan).toHaveBeenNthCalledWith(2, 'cursor-page-2', 'MATCH', 'microservice:registry:*', 'COUNT', 100);
  });

  it('should filter by serviceId in query', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    
    const instance1 = makeInstance({ serviceId: 'svc-1', instanceId: 'inst-1' });
    const instance2 = makeInstance({ serviceId: 'svc-2', instanceId: 'inst-2' });
    
    mockIORedisClient.scan.mockResolvedValueOnce(['0', ['microservice:registry:lease-1', 'microservice:registry:lease-2']]);
    mockIORedisClient.multi.mockReturnThis();
    mockIORedisClient.get.mockReturnThis();
    mockIORedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({ serviceId: 'svc-1' });

    expect(results).toHaveLength(1);
    expect(results[0].serviceId).toBe('svc-1');
  });

  it('should filter by status in query', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    
    const instance1 = makeInstance({ status: 'healthy' });
    const instance2 = makeInstance({ status: 'unhealthy' });
    
    mockIORedisClient.scan.mockResolvedValueOnce(['0', ['microservice:registry:lease-1', 'microservice:registry:lease-2']]);
    mockIORedisClient.multi.mockReturnThis();
    mockIORedisClient.get.mockReturnThis();
    mockIORedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({ status: 'healthy' });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('healthy');
  });

  it('should filter by capability in query', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    
    const instance1 = makeInstance({ capabilities: ['test', 'rpc'] });
    const instance2 = makeInstance({ capabilities: ['test'] });
    
    mockIORedisClient.scan.mockResolvedValueOnce(['0', ['microservice:registry:lease-1', 'microservice:registry:lease-2']]);
    mockIORedisClient.multi.mockReturnThis();
    mockIORedisClient.get.mockReturnThis();
    mockIORedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({ capability: 'rpc' });

    expect(results).toHaveLength(1);
    expect(results[0].capabilities).toContain('rpc');
  });

  it('should filter expired instances in query', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    
    const instance1 = makeInstance({ leaseExpiresAt: Date.now() + 60000 });
    const instance2 = makeInstance({ leaseExpiresAt: Date.now() - 1000 }); // expired
    
    mockIORedisClient.scan.mockResolvedValueOnce(['0', ['microservice:registry:lease-1', 'microservice:registry:lease-2']]);
    mockIORedisClient.multi.mockReturnThis();
    mockIORedisClient.get.mockReturnThis();
    mockIORedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({});

    expect(results).toHaveLength(1);
    expect(results[0].leaseExpiresAt).toBeGreaterThan(Date.now());
  });

  it('should respect limit in query', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    
    const instances = Array.from({ length: 5 }, (_, i) => 
      makeInstance({ instanceId: `inst-${i}` })
    );
    
    mockIORedisClient.scan.mockResolvedValueOnce(['0', [instances.map((_, i) => `microservice:registry:lease-${i}`)]]);
    mockIORedisClient.multi.mockReturnThis();
    mockIORedisClient.get.mockReturnThis();
    mockIORedisClient.exec.mockResolvedValueOnce(
      instances.map(inst => [null, JSON.stringify(inst)])
    );

    const results = await store.query({ limit: 3 });

    expect(results).toHaveLength(3);
  });

  it('should expire (delete) instance', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    await store.expire('lease-1');

    expect(mockIORedisClient.del).toHaveBeenCalledWith('microservice:registry:lease-1');
  });

  it('should renew a lease atomically via server-side script', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    mockIORedisClient.eval.mockResolvedValueOnce('renewed');

    const result = await store.renew('lease-1', 30000);

    expect(result).toBe('renewed');
    expect(mockIORedisClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      1,
      'microservice:registry:lease-1',
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('should report not-found when renewing a missing lease', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    mockIORedisClient.eval.mockResolvedValueOnce('not-found');

    const result = await store.renew('missing-lease', 30000);

    expect(result).toBe('not-found');
  });

  it('should report expired when renewing an expired lease', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    mockIORedisClient.eval.mockResolvedValueOnce('expired');

    const result = await store.renew('lease-1', 30000);

    expect(result).toBe('expired');
  });

  it('should update health on the canonical record', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);

    mockIORedisClient.scan.mockResolvedValueOnce(['0', ['microservice:registry:lease-1']]);
    mockIORedisClient.eval.mockResolvedValueOnce('1');

    const updated = await store.updateInstanceHealth('svc-1', 'inst-1', 'degraded', Date.now());

    expect(updated).toBe(true);
    expect(mockIORedisClient.eval).toHaveBeenCalled();
  });

  it('should return false when updating health for an unknown instance', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);

    mockIORedisClient.scan.mockResolvedValueOnce(['0', ['microservice:registry:lease-1']]);
    mockIORedisClient.eval.mockResolvedValueOnce('0');

    const updated = await store.updateInstanceHealth('svc-1', 'inst-1', 'degraded', Date.now());

    expect(updated).toBe(false);
  });

  it('should return false when updating health with no keys', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);
    mockIORedisClient.scan.mockResolvedValueOnce(['0', []]);

    const updated = await store.updateInstanceHealth('svc-1', 'inst-1', 'degraded', Date.now());

    expect(updated).toBe(false);
  });

  it('should filter by serviceName in query', async () => {
    store = await createRedisStore(makeConfig(), (await import('ioredis')).default);

    const instance1 = makeInstance({ serviceName: 'service-a' });
    const instance2 = makeInstance({ serviceName: 'service-b' });

    mockIORedisClient.scan.mockResolvedValueOnce(['0', ['microservice:registry:lease-1', 'microservice:registry:lease-2']]);
    mockIORedisClient.multi.mockReturnThis();
    mockIORedisClient.get.mockReturnThis();
    mockIORedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({ serviceName: 'service-a' });

    expect(results).toHaveLength(1);
    expect(results[0].serviceName).toBe('service-a');
  });

  it('should handle sentinel configuration', async () => {
    store = await createRedisStore(makeConfig({
      sentinels: [{ host: 'sentinel1', port: 26379 }],
      sentinelName: 'mymaster',
      sentinelPassword: 'secret',
    }), (await import('ioredis')).default);

    // Verify Redis was constructed with sentinel options
    const Redis = (await import('ioredis')).default;
    expect(Redis).toHaveBeenCalledWith(expect.objectContaining({
      sentinels: [{ host: 'sentinel1', port: 26379 }],
      name: 'mymaster',
      sentinelPassword: 'secret',
    }));
  });

  it('should handle TLS configuration', async () => {
    store = await createRedisStore(makeConfig({ tls: {} }), (await import('ioredis')).default);
    const Redis = (await import('ioredis')).default;
    expect(Redis).toHaveBeenCalledWith(expect.objectContaining({ tls: {} }));
  });

  it('should handle password and db configuration', async () => {
    store = await createRedisStore(makeConfig({ password: 'secret', db: 1 }), (await import('ioredis')).default);
    const Redis = (await import('ioredis')).default;
    expect(Redis).toHaveBeenCalledWith(expect.objectContaining({ password: 'secret', db: 1 }));
  });
});