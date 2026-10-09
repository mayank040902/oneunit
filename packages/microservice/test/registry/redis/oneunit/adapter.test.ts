import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RedisAdapterConfig } from '@registry/redis/types.js';
import { RegistryStore, ServiceInstance } from '@registry/registry.js';

// Mock @oneunit/redis at the top level
const mockOneUnitRedisClient = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
  keys: vi.fn().mockResolvedValue([]),
  quit: vi.fn().mockResolvedValue(undefined),
  multi: vi.fn().mockReturnThis(),
  get: vi.fn().mockResolvedValue(null),
  exec: vi.fn().mockResolvedValue([]),
};

const mockOneUnitModule = {
  createRedisClient: vi.fn().mockResolvedValue(mockOneUnitRedisClient),
  RedisClient: vi.fn(() => mockOneUnitRedisClient),
};

vi.mock('@oneunit/redis', () => mockOneUnitModule);

// Import after mocking
const { createRedisStore } = await import('@registry/redis/oneunit/adapter.js');

function makeConfig(overrides: Partial<RedisAdapterConfig> = {}): RedisAdapterConfig {
  return {
    driver: 'oneunit',
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

describe('OneUnit Redis Driver Adapter', () => {
  let store: RegistryStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOneUnitRedisClient.get.mockResolvedValue(null);
    mockOneUnitRedisClient.set.mockResolvedValue(undefined);
    mockOneUnitRedisClient.del.mockResolvedValue(undefined);
    mockOneUnitRedisClient.keys.mockResolvedValue([]);
    mockOneUnitRedisClient.quit.mockResolvedValue(undefined);
    mockOneUnitRedisClient.multi.mockReturnThis();
    mockOneUnitRedisClient.exec.mockResolvedValue([]);
    mockOneUnitModule.createRedisClient.mockResolvedValue(mockOneUnitRedisClient);
    mockOneUnitModule.RedisClient.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create store with oneunit redis client', async () => {
    store = await createRedisStore(makeConfig(), mockOneUnitModule);
    expect(store).toBeDefined();
    expect(typeof store.set).toBe('function');
    expect(typeof store.get).toBe('function');
    expect(typeof store.delete).toBe('function');
    expect(typeof store.query).toBe('function');
    expect(typeof store.expire).toBe('function');
  });

  it('should create redis client on creation', async () => {
    store = await createRedisStore(makeConfig(), mockOneUnitModule);
    expect(mockOneUnitModule.createRedisClient).toHaveBeenCalledWith({
      host: 'localhost',
      port: 6379,
      password: undefined,
      db: undefined,
      tls: undefined,
    });
  });

  it('should use custom key prefix', async () => {
    store = await createRedisStore(makeConfig({ keyPrefix: 'custom:' }), mockOneUnitModule);
    await store.set('lease-1', makeInstance());
    expect(mockOneUnitRedisClient.set).toHaveBeenCalledWith('custom:lease-1', expect.any(String), 'EX', expect.any(Number));
  });

  it('should set instance with TTL', async () => {
    store = await createRedisStore(makeConfig(), mockOneUnitModule);
    const instance = makeInstance({ leaseExpiresAt: Date.now() + 60000 });
    await store.set('lease-1', instance);

    expect(mockOneUnitRedisClient.set).toHaveBeenCalledWith(
      'microservice:registry:lease-1',
      JSON.stringify(instance),
      'EX',
      expect.any(Number)
    );
  });

  it('should get instance by leaseId', async () => {
    store = await createRedisStore(makeConfig(), mockOneUnitModule);
    const instance = makeInstance();
    mockOneUnitRedisClient.get.mockResolvedValueOnce(JSON.stringify(instance));

    const result = await store.get('lease-1');

    expect(result).toEqual(instance);
    expect(mockOneUnitRedisClient.get).toHaveBeenCalledWith('microservice:registry:lease-1');
  });

  it('should return null for missing key', async () => {
    store = await createRedisStore(makeConfig(), mockOneUnitModule);
    mockOneUnitRedisClient.get.mockResolvedValueOnce(null);

    const result = await store.get('missing-lease');

    expect(result).toBeNull();
  });

  it('should delete instance by leaseId', async () => {
    store = await createRedisStore(makeConfig(), mockOneUnitModule);
    await store.delete('lease-1');

    expect(mockOneUnitRedisClient.del).toHaveBeenCalledWith('microservice:registry:lease-1');
  });

  it('should query instances with filters', async () => {
    store = await createRedisStore(makeConfig(), mockOneUnitModule);
    
    const instance1 = makeInstance({ serviceId: 'svc-1', instanceId: 'inst-1' });
    const instance2 = makeInstance({ serviceId: 'svc-2', instanceId: 'inst-2' });
    
    mockOneUnitRedisClient.keys.mockResolvedValueOnce(['microservice:registry:lease-1', 'microservice:registry:lease-2']);
    mockOneUnitRedisClient.multi.mockReturnThis();
    mockOneUnitRedisClient.get.mockReturnThis();
    mockOneUnitRedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({});

    expect(results).toHaveLength(2);
    expect(mockOneUnitRedisClient.keys).toHaveBeenCalledWith('microservice:registry:*');
  });

  it('should filter by serviceId in query', async () => {
    store = await createRedisStore(makeConfig(), mockOneUnitModule);
    
    const instance1 = makeInstance({ serviceId: 'svc-1', instanceId: 'inst-1' });
    const instance2 = makeInstance({ serviceId: 'svc-2', instanceId: 'inst-2' });
    
    mockOneUnitRedisClient.keys.mockResolvedValueOnce(['microservice:registry:lease-1', 'microservice:registry:lease-2']);
    mockOneUnitRedisClient.multi.mockReturnThis();
    mockOneUnitRedisClient.get.mockReturnThis();
    mockOneUnitRedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({ serviceId: 'svc-1' });

    expect(results).toHaveLength(1);
    expect(results[0].serviceId).toBe('svc-1');
  });

  it('should filter by status in query', async () => {
    store = await createRedisStore(makeConfig(), mockOneUnitModule);
    
    const instance1 = makeInstance({ status: 'healthy' });
    const instance2 = makeInstance({ status: 'unhealthy' });
    
    mockOneUnitRedisClient.keys.mockResolvedValueOnce(['microservice:registry:lease-1', 'microservice:registry:lease-2']);
    mockOneUnitRedisClient.multi.mockReturnThis();
    mockOneUnitRedisClient.get.mockReturnThis();
    mockOneUnitRedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({ status: 'healthy' });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('healthy');
  });

  it('should filter by capability in query', async () => {
    store = await createRedisStore(makeConfig(), mockOneUnitModule);
    
    const instance1 = makeInstance({ capabilities: ['test', 'rpc'] });
    const instance2 = makeInstance({ capabilities: ['test'] });
    
    mockOneUnitRedisClient.keys.mockResolvedValueOnce(['microservice:registry:lease-1', 'microservice:registry:lease-2']);
    mockOneUnitRedisClient.multi.mockReturnThis();
    mockOneUnitRedisClient.get.mockReturnThis();
    mockOneUnitRedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({ capability: 'rpc' });

    expect(results).toHaveLength(1);
    expect(results[0].capabilities).toContain('rpc');
  });

  it('should filter expired instances in query', async () => {
    store = await createRedisStore(makeConfig(), mockOneUnitModule);
    
    const instance1 = makeInstance({ leaseExpiresAt: Date.now() + 60000 });
    const instance2 = makeInstance({ leaseExpiresAt: Date.now() - 1000 }); // expired
    
    mockOneUnitRedisClient.keys.mockResolvedValueOnce(['microservice:registry:lease-1', 'microservice:registry:lease-2']);
    mockOneUnitRedisClient.multi.mockReturnThis();
    mockOneUnitRedisClient.get.mockReturnThis();
    mockOneUnitRedisClient.exec.mockResolvedValueOnce([
      [null, JSON.stringify(instance1)],
      [null, JSON.stringify(instance2)],
    ]);

    const results = await store.query({});

    expect(results).toHaveLength(1);
    expect(results[0].leaseExpiresAt).toBeGreaterThan(Date.now());
  });

  it('should respect limit in query', async () => {
    store = await createRedisStore(makeConfig(), mockOneUnitModule);
    
    const instances = Array.from({ length: 5 }, (_, i) => 
      makeInstance({ instanceId: `inst-${i}` })
    );
    
    mockOneUnitRedisClient.keys.mockResolvedValueOnce(instances.map((_, i) => `microservice:registry:lease-${i}`));
    mockOneUnitRedisClient.multi.mockReturnThis();
    mockOneUnitRedisClient.get.mockReturnThis();
    mockOneUnitRedisClient.exec.mockResolvedValueOnce(
      instances.map(inst => [null, JSON.stringify(inst)])
    );

    const results = await store.query({ limit: 3 });

    expect(results).toHaveLength(3);
  });

  it('should expire (delete) instance', async () => {
    store = await createRedisStore(makeConfig(), mockOneUnitModule);
    await store.expire('lease-1');

    expect(mockOneUnitRedisClient.del).toHaveBeenCalledWith('microservice:registry:lease-1');
  });

  it('should pass TLS configuration to client', async () => {
    store = await createRedisStore(makeConfig({ tls: {} }), mockOneUnitModule);
    expect(mockOneUnitModule.createRedisClient).toHaveBeenCalledWith(expect.objectContaining({ tls: {} }));
  });

  it('should pass password and db configuration to client', async () => {
    store = await createRedisStore(makeConfig({ password: 'secret', db: 1 }), mockOneUnitModule);
    expect(mockOneUnitModule.createRedisClient).toHaveBeenCalledWith(expect.objectContaining({ password: 'secret', db: 1 }));
  });
});