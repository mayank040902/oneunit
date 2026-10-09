import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveRedisDriver } from '../../src/registry/redis/driver-resolver.js';
import { RedisAdapterConfig } from '../../src/registry/redis/types.js';

function makeConfig(overrides: Partial<RedisAdapterConfig> = {}): RedisAdapterConfig {
  return {
    driver: 'ioredis',
    host: 'localhost',
    port: 6379,
    ...overrides,
  };
}

describe('resolveRedisDriver explicit selection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('should resolve ioredis driver when explicitly requested', async () => {
    const resolved = await resolveRedisDriver(makeConfig({ driver: 'ioredis' }));
    expect(resolved.driver).toBe('ioredis');
    expect(typeof resolved.module.createStore).toBe('function');
  });

  it('should surface a clear error for oneunit when the package lacks the expected exports', async () => {
    // @oneunit/redis is installed in this workspace but does not export the
    // `createRedisClient` / `RedisClient` names the resolver expects. The
    // resolver must surface that as a configuration/dependency error rather
    // than silently falling through to another driver.
    await expect(resolveRedisDriver(makeConfig({ driver: 'oneunit' }))).rejects.toThrow(
      /@oneunit\/redis does not export required APIs/,
    );
  });

  it('should surface a clear actionable error for node-redis when redis is not installed', async () => {
    // node-redis (v4+) is not installed in this workspace; the resolver must
    // surface that as a dependency-resolution error rather than silently
    // falling through to another driver.
    await expect(resolveRedisDriver(makeConfig({ driver: 'node-redis' }))).rejects.toThrow(
      /redis \(node-redis\) is not installed/,
    );
  });
});

describe('resolveRedisDriver auto mode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('should select an available driver in auto mode', async () => {
    // Auto mode must deterministically pick an available driver rather than
    // silently failing. ioredis is installed and exports the Redis class.
    const resolved = await resolveRedisDriver(makeConfig({ driver: 'auto' }));
    expect(['oneunit', 'ioredis']).toContain(resolved.driver);
    expect(typeof resolved.module.createStore).toBe('function');
  });
});