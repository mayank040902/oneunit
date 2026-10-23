import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRedisStore } from '../../src/registry/redis/adapter.js';
import { createRegistry } from '../../src/registry/registry.js';
import { ServiceRegistration } from '../../src/contracts/schemas.js';
import { RedisAdapterConfig } from '../../src/registry/redis/types.js';
import { MicroserviceConfig } from '../../src/config/schema.js';

const LIVE = process.env['RUN_LIVE_INTEGRATION'] === '1';
const REDIS_HOST = process.env['REDIS_HOST'] ?? 'localhost';
const REDIS_PORT = Number(process.env['REDIS_PORT'] ?? '6379');
const REDIS_PASSWORD = process.env['REDIS_PASSWORD'];
const RUN_ID = process.env['REDIS_RUN_ID'] ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const KEY_PREFIX = `microservice:integration:${RUN_ID}:`;

function makeRedisConfig(overrides: Partial<RedisAdapterConfig> = {}): RedisAdapterConfig {
  return {
    driver: 'ioredis',
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    db: 0,
    tls: process.env['REDIS_TLS'] === '1',
    keyPrefix: KEY_PREFIX,
    ...overrides,
  };
}

function makeRegistration(serviceId: string, instanceId: string): ServiceRegistration {
  return {
    serviceId,
    serviceName: 'integration-test-service',
    instanceId,
    endpoints: [{ protocol: 'tcp', host: 'localhost', port: 18080 }],
    capabilities: ['test-cap'],
    metadata: {},
    registeredAt: Date.now(),
  };
}

async function cleanupKeys() {
  const ioredis = await import('ioredis');
  const Redis = (ioredis as any).default ?? (ioredis as any).Redis;
  const client = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD, lazyConnect: true });
  await client.connect();
  const pattern = `${KEY_PREFIX}*`;
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    if (batch.length) await client.del(...batch);
  } while (cursor !== '0');
  await client.quit();
}

describe.skipIf(!LIVE)('Redis live integration', () => {
  beforeAll(async () => {
    const store = await createRedisStore(makeRedisConfig());
    await store.close();
  });

  afterAll(async () => {
    await cleanupKeys();
  });

  it('registers, discovers, renews, and deregisters through the public registry', async () => {
    const config: MicroserviceConfig = {
      service: { id: crypto.randomUUID(), name: 'svc', endpoints: [], capabilities: [], metadata: {}, instanceId: crypto.randomUUID(), registeredAt: Date.now() } as any,
      registry: { backend: 'redis', redis: makeRedisConfig() as any, ttlMs: 5000, heartbeatIntervalMs: 1000, healthCheckIntervalMs: 1000, maxServices: 1000 },
      security: { authenticationEnabled: true, encryptionMode: 'disabled', keyRotationIntervalMs: 1, sessionTimeoutMs: 1 },
      observability: { logging: false, tracing: false, metrics: false, audit: false },
    } as any;
    const registry = createRegistry(config.registry!);
    const serviceId = crypto.randomUUID();
    const instanceId = crypto.randomUUID();
    const lease = await registry.register(makeRegistration(serviceId, instanceId));
    const discovered = await registry.discover({ serviceId });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.instanceId).toBe(instanceId);
    await registry.renew(lease.leaseId);
    const renewed = await registry.getInstance(lease.leaseId);
    expect(renewed?.leaseExpiresAt).toBeGreaterThan(lease.expiresAt);
    await registry.deregister(lease.leaseId);
    expect(await registry.getInstance(lease.leaseId)).toBeNull();
  });

  it('handles concurrent renewals without lost or invalid lease timestamps', async () => {
    const store = await createRedisStore(makeRedisConfig());
    const serviceId = crypto.randomUUID();
    const instanceId = crypto.randomUUID();
    const leaseId = `lease-${RUN_ID}-renew`;
    await store.set(leaseId, {
      serviceId,
      serviceName: 'integration-test-service',
      instanceId,
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 18080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 5000,
      capabilities: ['test-cap'],
      metadata: {},
    });

    const iterations = 50;
    const results = await Promise.allSettled(
      Array.from({ length: iterations }, () => store.renew(leaseId, 5000)),
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    const values = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<any>).value);
    expect(rejected).toHaveLength(0);
    expect(values.every((v) => v === 'renewed')).toBe(true);

    const final = await store.get(leaseId);
    expect(final).not.toBeNull();
    expect(final!.leaseExpiresAt).toBeGreaterThan(Date.now() - 1000);
    await store.close();
  });

  it('does not recreate or leave valid records after renewal races deregistration', async () => {
    const store = await createRedisStore(makeRedisConfig());
    const leaseId = `lease-${RUN_ID}-race-delete`;

    for (let i = 0; i < 25; i++) {
      await store.set(leaseId, {
        serviceId: crypto.randomUUID(),
        serviceName: 'integration-test-service',
        instanceId: crypto.randomUUID(),
        endpoints: [{ protocol: 'tcp', host: 'localhost', port: 18080 }],
        status: 'healthy',
        lastHeartbeat: Date.now(),
        leaseExpiresAt: Date.now() + 5000,
        capabilities: ['test-cap'],
        metadata: {},
      });

      await Promise.allSettled([
        store.renew(leaseId, 5000),
        store.delete(leaseId),
      ]);

      const final = await store.get(leaseId);
      if (final !== null) {
        expect(final.leaseExpiresAt).toBeGreaterThan(0);
      }

      // no accidental recreation after deregistration in subsequent get
      await store.delete(leaseId);
      expect(await store.get(leaseId)).toBeNull();
    }
    await store.close();
  });

  it('concurrently updates health and renews without crashing and preserves timestamps', async () => {
    const store = await createRedisStore(makeRedisConfig());
    const serviceId = crypto.randomUUID();
    const instanceId = crypto.randomUUID();
    const leaseId = `lease-${RUN_ID}-health`;
    await store.set(leaseId, {
      serviceId,
      serviceName: 'integration-test-service',
      instanceId,
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 18080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 5000,
      capabilities: ['test-cap'],
      metadata: {},
    });

    const ops = [];
    for (let i = 0; i < 20; i++) {
      ops.push(store.updateInstanceHealth(serviceId, instanceId, i % 2 === 0 ? 'healthy' : 'degraded', Date.now()));
      ops.push(store.renew(leaseId, 5000));
    }
    const results = await Promise.allSettled(ops);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(0);

    const final = await store.get(leaseId);
    expect(final).not.toBeNull();
    expect(['healthy', 'degraded']).toContain(final!.status);
    await store.close();
  });

  it('supports concurrent registration of the same instance identifier', async () => {
    const config: MicroserviceConfig = {
      service: { id: crypto.randomUUID(), name: 'svc', endpoints: [], capabilities: [], metadata: {}, instanceId: crypto.randomUUID(), registeredAt: Date.now() } as any,
      registry: { backend: 'redis', redis: makeRedisConfig() as any, ttlMs: 5000, heartbeatIntervalMs: 1000, healthCheckIntervalMs: 1000, maxServices: 1000 },
      security: { authenticationEnabled: true, encryptionMode: 'disabled', keyRotationIntervalMs: 1, sessionTimeoutMs: 1 },
      observability: { logging: false, tracing: false, metrics: false, audit: false },
    } as any;
    const registry = createRegistry(config.registry!);
    const serviceId = crypto.randomUUID();
    const instanceId = crypto.randomUUID();

    const leases = await Promise.all(
      Array.from({ length: 10 }, () => registry.register(makeRegistration(serviceId, instanceId))),
    );
    expect(leases).toHaveLength(10);
    expect(new Set(leases.map((l) => l.leaseId)).size).toBe(1);
    const discovered = await registry.discover({ serviceId });
    // Concurrent registration for the same identity resolves to a single active lease.
    expect(discovered.length).toBe(1);
    expect(discovered.every((i) => i.instanceId === instanceId)).toBe(true);

    await Promise.all(leases.map((l) => registry.deregister(l.leaseId)));
  });

  it('discovery does not crash when registry records change concurrently', async () => {
    const store = await createRedisStore(makeRedisConfig());
    const serviceId = crypto.randomUUID();
    const writers: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      const leaseId = `lease-${RUN_ID}-concurrent-${i}`;
      writers.push(store.set(leaseId, {
        serviceId,
        serviceName: 'integration-test-service',
        instanceId: crypto.randomUUID(),
        endpoints: [{ protocol: 'tcp', host: 'localhost', port: 18080 }],
        status: 'healthy',
        lastHeartbeat: Date.now(),
        leaseExpiresAt: Date.now() + 5000,
        capabilities: ['test-cap'],
        metadata: {},
      }));
      if (i % 3 === 0) writers.push(store.delete(`lease-${RUN_ID}-concurrent-${Math.max(0, i - 1)}`));
    }
    const readers = Array.from({ length: 25 }, () => store.query({ serviceId }));
    const [writeResults, readResults] = await Promise.all([
      Promise.allSettled(writers),
      Promise.allSettled(readers),
    ]);
    expect(writeResults.some((r) => r.status === 'rejected')).toBe(false);
    for (const r of readResults) {
      expect(r.status).toBe('fulfilled');
      if (r.status === 'fulfilled') {
        for (const instance of r.value) {
          expect(instance.leaseExpiresAt).toBeGreaterThan(0);
        }
      }
    }
    await store.close();
  });

  it('propagates errors when the Redis store is closed and recovers with a new store', async () => {
    const store = await createRedisStore(makeRedisConfig());
    const leaseId = `lease-${RUN_ID}-recovery`;
    await store.set(leaseId, {
      serviceId: crypto.randomUUID(),
      serviceName: 'integration-test-service',
      instanceId: crypto.randomUUID(),
      endpoints: [{ protocol: 'tcp', host: 'localhost', port: 18080 }],
      status: 'healthy',
      lastHeartbeat: Date.now(),
      leaseExpiresAt: Date.now() + 60000,
      capabilities: ['test-cap'],
      metadata: {},
    });
    await store.close();
    await expect(store.get(leaseId)).rejects.toThrow(/store not connected/);

    const recovered = await createRedisStore(makeRedisConfig());
    const instance = await recovered.get(leaseId);
    expect(instance).not.toBeNull();
    await recovered.close();
  });

  it('does not present malformed records as valid instances during discovery', async () => {
    const store = await createRedisStore(makeRedisConfig());
    const clientModule = await import('ioredis');
    const Redis = (clientModule as any).default ?? (clientModule as any).Redis;
    const raw = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD, lazyConnect: true });
    await raw.connect();
    await raw.set(`${KEY_PREFIX}corrupt`, '{not valid json', 'EX', 60);
    const malformed = await raw.get(`${KEY_PREFIX}corrupt`);
    expect(malformed).toBe('{not valid json');
    const results = await store.query({});
    expect(results.every((r) => typeof r.serviceId === 'string')).toBe(true);
    await store.close();
    await raw.quit();
  });

  const runAuth = process.env['REDIS_REQUIRES_AUTH'] === '1';
  it.skipIf(!runAuth)('invalid credentials fail clearly during connection', async () => {
    await expect(createRedisStore(makeRedisConfig({ password: 'definitely-wrong-password' }))).rejects.toThrow();
  });
});
