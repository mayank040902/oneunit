import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RedisAdapterConfig } from '@registry/redis/types.js';
import { RegistryStore, ServiceInstance } from '@registry/registry.js';

// Mock node-redis at the top level
const mockNodeRedisClient = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  scan: vi.fn().mockResolvedValue({ cursor: 0, keys: [] }),
  eval: vi.fn().mockResolvedValue('renewed'),
  quit: vi.fn().mockResolvedValue('OK'),
  multi: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue([]),
  connect: vi.fn().mockResolvedValue(undefined),
};

vi.mock('redis', () => ({
  createClient: vi.fn(() => mockNodeRedisClient),
}));

// Import after mocking
const { createRedisStore } = await import('@registry/redis/node-redis/adapter.js');

function makeConfig(overrides: Partial<RedisAdapterConfig> = {}): RedisAdapterConfig {
  return {
    driver: 'node-redis',
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

describe('Node-Redis Driver Adapter', () => {
  let store: RegistryStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNodeRedisClient.get.mockResolvedValue(null);
    mockNodeRedisClient.set.mockResolvedValue('OK');
    mockNodeRedisClient.del.mockResolvedValue(1);
    mockNodeRedisClient.scan.mockResolvedValue({ cursor: 0, keys: [] });
    mockNodeRedisClient.eval.mockResolvedValue('renewed');
    mockNodeRedisClient.quit.mockResolvedValue('OK');
    mockNodeRedisClient.multi.mockReturnThis();
    mockNodeRedisClient.exec.mockResolvedValue([]);
    mockNodeRedisClient.connect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create store with node-redis client', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    expect(store).toBeDefined();
    expect(typeof store.set).toBe('function');
    expect(typeof store.get).toBe('function');
    expect(typeof store.delete).toBe('function');
    expect(typeof store.query).toBe('function');
    expect(typeof store.expire).toBe('function');
  });

  it('should connect to redis on creation', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    expect(mockNodeRedisClient.connect).toHaveBeenCalled();
  });

  it('should use custom key prefix', async () => {
    store = await createRedisStore(makeConfig({ keyPrefix: 'custom:' }), (await import('redis')) as any);
    await store.set('lease-1', makeInstance());
    expect(mockNodeRedisClient.set).toHaveBeenCalledWith('custom:lease-1', expect.any(String), { EX: expect.any(Number) });
  });

  it('should set instance with TTL', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    const instance = makeInstance({ leaseExpiresAt: Date.now() + 60000 });
    await store.set('lease-1', instance);

    expect(mockNodeRedisClient.set).toHaveBeenCalledWith(
      'microservice:registry:lease-1',
      JSON.stringify(instance),
      { EX: expect.any(Number) }
    );
  });

  it('should get instance by leaseId', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    const instance = makeInstance();
    mockNodeRedisClient.get.mockResolvedValueOnce(JSON.stringify(instance));

    const result = await store.get('lease-1');

    expect(result).toEqual(instance);
    expect(mockNodeRedisClient.get).toHaveBeenCalledWith('microservice:registry:lease-1');
  });

  it('should return null for missing key', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    mockNodeRedisClient.get.mockResolvedValueOnce(null);

    const result = await store.get('missing-lease');

    expect(result).toBeNull();
  });

  it('should delete instance by leaseId', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    await store.delete('lease-1');

    expect(mockNodeRedisClient.del).toHaveBeenCalledWith('microservice:registry:lease-1');
  });

  it('should query instances with filters', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    
    const instance1 = makeInstance({ serviceId: 'svc-1', instanceId: 'inst-1' });
    const instance2 = makeInstance({ serviceId: 'svc-2', instanceId: 'inst-2' });
    
    mockNodeRedisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: ['microservice:registry:lease-1', 'microservice:registry:lease-2'] });
    mockNodeRedisClient.multi.mockReturnThis();
    mockNodeRedisClient.get.mockReturnThis();
    mockNodeRedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({});

    expect(results).toHaveLength(2);
    expect(mockNodeRedisClient.scan).toHaveBeenCalledWith(0, { MATCH: 'microservice:registry:*', COUNT: 100 });
  });

  it('should filter by serviceId in query', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    
    const instance1 = makeInstance({ serviceId: 'svc-1', instanceId: 'inst-1' });
    const instance2 = makeInstance({ serviceId: 'svc-2', instanceId: 'inst-2' });
    
    mockNodeRedisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: ['microservice:registry:lease-1', 'microservice:registry:lease-2'] });
    mockNodeRedisClient.multi.mockReturnThis();
    mockNodeRedisClient.get.mockReturnThis();
    mockNodeRedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({ serviceId: 'svc-1' });

    expect(results).toHaveLength(1);
    expect(results[0].serviceId).toBe('svc-1');
  });

  it('should filter by status in query', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    
    const instance1 = makeInstance({ status: 'healthy' });
    const instance2 = makeInstance({ status: 'unhealthy' });
    
    mockNodeRedisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: ['microservice:registry:lease-1', 'microservice:registry:lease-2'] });
    mockNodeRedisClient.multi.mockReturnThis();
    mockNodeRedisClient.get.mockReturnThis();
    mockNodeRedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({ status: 'healthy' });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('healthy');
  });

  it('should filter by capability in query', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    
    const instance1 = makeInstance({ capabilities: ['test', 'rpc'] });
    const instance2 = makeInstance({ capabilities: ['test'] });
    
    mockNodeRedisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: ['microservice:registry:lease-1', 'microservice:registry:lease-2'] });
    mockNodeRedisClient.multi.mockReturnThis();
    mockNodeRedisClient.get.mockReturnThis();
    mockNodeRedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({ capability: 'rpc' });

    expect(results).toHaveLength(1);
    expect(results[0].capabilities).toContain('rpc');
  });

  it('should filter expired instances in query', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    
    const instance1 = makeInstance({ leaseExpiresAt: Date.now() + 60000 });
    const instance2 = makeInstance({ leaseExpiresAt: Date.now() - 1000 }); // expired
    
    mockNodeRedisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: ['microservice:registry:lease-1', 'microservice:registry:lease-2'] });
    mockNodeRedisClient.multi.mockReturnThis();
    mockNodeRedisClient.get.mockReturnThis();
    mockNodeRedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({});

    expect(results).toHaveLength(1);
    expect(results[0].leaseExpiresAt).toBeGreaterThan(Date.now());
  });

  it('should respect limit in query', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    
    const instances = Array.from({ length: 5 }, (_, i) => 
      makeInstance({ instanceId: `inst-${i}` })
    );
    
    mockNodeRedisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: instances.map((_, i) => `microservice:registry:lease-${i}`) });
    mockNodeRedisClient.multi.mockReturnThis();
    mockNodeRedisClient.get.mockReturnThis();
    mockNodeRedisClient.exec.mockResolvedValueOnce(
      instances.map(inst => [null, JSON.stringify(inst)])
    );

    const results = await store.query({ limit: 3 });

    expect(results).toHaveLength(3);
  });

  it('should expire (delete) instance', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    await store.expire('lease-1');

    expect(mockNodeRedisClient.del).toHaveBeenCalledWith('microservice:registry:lease-1');
  });

  it('should renew a lease atomically via server-side script', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    mockNodeRedisClient.eval.mockResolvedValueOnce('renewed');

    const result = await store.renew('lease-1', 30000);

    expect(result).toBe('renewed');
    expect(mockNodeRedisClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      {
        keys: ['microservice:registry:lease-1'],
        arguments: [expect.any(String), expect.any(String), expect.any(String)],
      },
    );
  });

  it('should report not-found when renewing a missing lease', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    mockNodeRedisClient.eval.mockResolvedValueOnce('not-found');

    const result = await store.renew('missing-lease', 30000);

    expect(result).toBe('not-found');
  });

  it('should report expired when renewing an expired lease', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    mockNodeRedisClient.eval.mockResolvedValueOnce('expired');

    const result = await store.renew('lease-1', 30000);

    expect(result).toBe('expired');
  });

  it('should update health on the canonical record', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);

    mockNodeRedisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: ['microservice:registry:lease-1'] });
    mockNodeRedisClient.eval.mockResolvedValueOnce('1');

    const updated = await store.updateInstanceHealth('svc-1', 'inst-1', 'degraded', Date.now());

    expect(updated).toBe(true);
    expect(mockNodeRedisClient.eval).toHaveBeenCalled();
  });

  it('should return false when updating health for an unknown instance', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);

    mockNodeRedisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: ['microservice:registry:lease-1'] });
    mockNodeRedisClient.eval.mockResolvedValueOnce('0');

    const updated = await store.updateInstanceHealth('svc-1', 'inst-1', 'degraded', Date.now());

    expect(updated).toBe(false);
  });

  it('should return false when updating health with no keys', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);
    mockNodeRedisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: [] });

    const updated = await store.updateInstanceHealth('svc-1', 'inst-1', 'degraded', Date.now());

    expect(updated).toBe(false);
  });

  it('should filter by serviceName in query', async () => {
    store = await createRedisStore(makeConfig(), (await import('redis')) as any);

    const instance1 = makeInstance({ serviceName: 'service-a' });
    const instance2 = makeInstance({ serviceName: 'service-b' });

    mockNodeRedisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: ['microservice:registry:lease-1', 'microservice:registry:lease-2'] });
    mockNodeRedisClient.multi.mockReturnThis();
    mockNodeRedisClient.get.mockReturnThis();
    mockNodeRedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({ serviceName: 'service-a' });

    expect(results).toHaveLength(1);
    expect(results[0].serviceName).toBe('service-a');
  });

  it('should handle TLS configuration', async () => {
    store = await createRedisStore(makeConfig({ tls: {} }), (await import('redis')) as any);
    const redisModule = await import('redis');
    expect(redisModule.createClient).toHaveBeenCalledWith(expect.objectContaining({
      socket: expect.objectContaining({ tls: true }),
    }));
  });

  it('should handle password and database configuration', async () => {
    store = await createRedisStore(makeConfig({ password: 'secret', db: 1 }), (await import('redis')) as any);
    const redisModule = await import('redis');
    expect(redisModule.createClient).toHaveBeenCalledWith(expect.objectContaining({
      password: 'secret',
      database: 1,
    }));
  });
});