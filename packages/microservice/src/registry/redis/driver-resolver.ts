import { RedisDriver, RedisAdapterConfig, RedisDriverModule } from './types.js';

export interface ResolvedRedisDriver {
  driver: RedisDriver;
  module: RedisDriverModule;
}

interface OneUnitRedisModuleShape {
  createClient?: unknown;
  createRedisClient?: unknown;
  RedisClient?: unknown;
}

interface IORedisModuleShape {
  default?: unknown;
  Redis?: unknown;
}

interface NodeRedisModuleShape {
  createClient?: unknown;
}

export async function resolveRedisDriver(config: RedisAdapterConfig): Promise<ResolvedRedisDriver> {
  const requestedDriver = config.driver ?? 'auto';

  if (requestedDriver === 'oneunit') {
    return await loadOneUnitDriver();
  }

  if (requestedDriver === 'ioredis') {
    return await loadIORedisDriver();
  }

  if (requestedDriver === 'node-redis') {
    return await loadNodeRedisDriver();
  }

  // Auto mode: try oneunit first, then ioredis, then node-redis
  try {
    return await loadOneUnitDriver();
  } catch (oneUnitError) {
    try {
      return await loadIORedisDriver();
    } catch (ioredisError) {
      try {
        return await loadNodeRedisDriver();
      } catch (nodeRedisError) {
        const oneUnitMsg = oneUnitError instanceof Error ? oneUnitError.message : String(oneUnitError);
        const ioredisMsg = ioredisError instanceof Error ? ioredisError.message : String(ioredisError);
        const nodeRedisMsg = nodeRedisError instanceof Error ? nodeRedisError.message : String(nodeRedisError);
        throw new Error(
          `No Redis driver available. @oneunit/redis: ${oneUnitMsg}. ioredis: ${ioredisMsg}. node-redis: ${nodeRedisMsg}`,
        );
      }
    }
  }
}

async function loadOneUnitDriver(): Promise<ResolvedRedisDriver> {
  let oneUnitModule: OneUnitRedisModuleShape;
  try {
    oneUnitModule = await import('@oneunit/redis');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('Cannot find module') ||
      msg.includes('Failed to load url') ||
      msg.includes('Cannot find package')
    ) {
      throw new Error(
        '@oneunit/redis is not installed. Install it or use driver: "ioredis" or "node-redis"',
      );
    }
    throw err;
  }

  // Verify the module has the expected exports. The current @oneunit/redis
  // package exports `createClient` (returning an ioredis-compatible client);
  // `createRedisClient` and `RedisClient` are accepted as aliases for
  // compatibility with other releases of that package.
  if (!oneUnitModule.createClient && !oneUnitModule.createRedisClient && !oneUnitModule.RedisClient) {
    throw new Error(
      '@oneunit/redis does not export required APIs (createClient, createRedisClient, or RedisClient)',
    );
  }

  const { createRedisStore } = await import('./oneunit/adapter.js');

  return {
    driver: 'oneunit',
    module: {
      createStore: (cfg) => createRedisStore(cfg, oneUnitModule as import('./oneunit/adapter.js').OneUnitRedisModule),
    },
  };
}

async function loadIORedisDriver(): Promise<ResolvedRedisDriver> {
  let ioredisModule: IORedisModuleShape;
  try {
    ioredisModule = await import('ioredis');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('Cannot find module') ||
      msg.includes('Failed to load url') ||
      msg.includes('Cannot find package')
    ) {
      throw new Error(
        'ioredis is not installed. Install it or use driver: "oneunit" or "node-redis"',
      );
    }
    throw err;
  }

  if (!ioredisModule.default && !ioredisModule.Redis) {
    throw new Error('ioredis does not export Redis class');
  }

  const Redis = ioredisModule.default || ioredisModule.Redis;
  const { createRedisStore } = await import('./ioredis/adapter.js');

  return {
    driver: 'ioredis',
    module: {
      createStore: (cfg) => createRedisStore(cfg, Redis as import('./ioredis/adapter.js').IORedisConstructor),
    },
  };
}

async function loadNodeRedisDriver(): Promise<ResolvedRedisDriver> {
  let nodeRedisModule: NodeRedisModuleShape;
  try {
    // @ts-expect-error node-redis (v4) is an optional peer dependency and may
    // not be installed; the import is resolved at runtime.
    nodeRedisModule = await import('redis');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('Cannot find module') ||
      msg.includes('Failed to load url') ||
      msg.includes('Cannot find package')
    ) {
      throw new Error(
        'redis (node-redis) is not installed. Install it or use driver: "oneunit" or "ioredis"',
      );
    }
    throw err;
  }

  if (!nodeRedisModule.createClient) {
    throw new Error('redis does not export createClient');
  }

  const { createRedisStore } = await import('./node-redis/adapter.js');

  return {
    driver: 'node-redis',
    module: {
      createStore: (cfg) => createRedisStore(cfg, nodeRedisModule as import('./node-redis/adapter.js').NodeRedisModule),
    },
  };
}