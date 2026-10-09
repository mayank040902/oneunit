import { RedisDriver, RedisAdapterConfig, RedisDriverModule, ResolvedRedisDriver as ResolvedRedisDriverType } from './types.js';

export interface ResolvedRedisDriver {
  driver: RedisDriver;
  module: RedisDriverModule;
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
          `No Redis driver available. @oneunit/redis: ${oneUnitMsg}. ioredis: ${ioredisMsg}. node-redis: ${nodeRedisMsg}`
        );
      }
    }
  }
}

async function loadOneUnitDriver(): Promise<ResolvedRedisDriver> {
  const importModule = new Function('specifier', 'return import(specifier)');
  
  let oneUnitModule: any;
  try {
    oneUnitModule = await importModule('@oneunit/redis');
  } catch (err) {
    if (err instanceof Error && err.message.includes('Cannot find module')) {
      throw new Error('@oneunit/redis is not installed. Install it or use driver: "ioredis" or "node-redis"');
    }
    throw err;
  }
  
  // Verify the module has the expected exports
  if (!oneUnitModule.createRedisClient && !oneUnitModule.RedisClient) {
    throw new Error('@oneunit/redis does not export required APIs (createRedisClient or RedisClient)');
  }
  
  const { createRedisStore } = await import('./oneunit/adapter.js');
  
  return {
    driver: 'oneunit',
    module: {
      createStore: (cfg) => createRedisStore(cfg, oneUnitModule),
    },
  };
}

async function loadIORedisDriver(): Promise<ResolvedRedisDriver> {
  const importModule = new Function('specifier', 'return import(specifier)');
  
  let ioredisModule: any;
  try {
    ioredisModule = await importModule('ioredis');
  } catch (err) {
    if (err instanceof Error && err.message.includes('Cannot find module')) {
      throw new Error('ioredis is not installed. Install it or use driver: "oneunit" or "node-redis"');
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
      createStore: (cfg) => createRedisStore(cfg, Redis),
    },
  };
}

async function loadNodeRedisDriver(): Promise<ResolvedRedisDriver> {
  const importModule = new Function('specifier', 'return import(specifier)');
  
  let nodeRedisModule: any;
  try {
    nodeRedisModule = await importModule('redis');
  } catch (err) {
    if (err instanceof Error && err.message.includes('Cannot find module')) {
      throw new Error('redis (node-redis) is not installed. Install it or use driver: "oneunit" or "ioredis"');
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
      createStore: (cfg) => createRedisStore(cfg, nodeRedisModule),
    },
  };
}