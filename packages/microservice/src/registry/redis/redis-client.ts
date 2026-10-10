import { RedisAdapterConfig } from './types.js';
import { Logger } from '@/observability/logger.js';
import Redis from 'ioredis';

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { mode?: 'EX' | 'PX' | 'EXAT' | 'PXAT'; ttlMs?: number }): Promise<void>;
  del(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  quit(): Promise<void>;
  multi(): any;
}

export interface RedisClientConfig {
  config: RedisAdapterConfig;
  logger?: Logger;
}

let cachedRedisClient: RedisClient | null = null;
let redisInitializationError: Error | null = null;

export function isRedisAvailable(): boolean {
  try {
    require.resolve('@oneunit/redis');
    return true;
  } catch {
    return false;
  }
}

export async function createRedisClient(config: RedisClientConfig): Promise<RedisClient> {
  if (cachedRedisClient) {
    return cachedRedisClient;
  }

  if (redisInitializationError) {
    throw redisInitializationError;
  }

  const { config: redisConfig, logger } = config;

  try {
    const oneUnitRedisModule = await import('@oneunit/redis');
    
    if (!oneUnitRedisModule.createClient) {
      throw new Error('@oneunit/redis does not export required API (createClient)');
    }

    const client = (await oneUnitRedisModule.createClient({
      host: redisConfig.host,
      port: redisConfig.port,
      password: redisConfig.password,
      db: redisConfig.db,
      tls: redisConfig.tls ? {} : undefined,
    }, logger)) as any;

    const keyPrefix = redisConfig.keyPrefix ?? 'microservice:';

    cachedRedisClient = {
      async get(key: string): Promise<string | null> {
        return client.get(`${keyPrefix}${key}`);
      },

      async set(key: string, value: string, options?: { mode?: 'EX' | 'PX' | 'EXAT' | 'PXAT'; ttlMs?: number }): Promise<void> {
        const fullKey = `${keyPrefix}${key}`;
        if (options?.ttlMs && options?.mode) {
          const ttlSeconds = options.mode === 'EX' || options.mode === 'EXAT' 
            ? Math.ceil(options.ttlMs / 1000) 
            : options.ttlMs;
          await client.set(fullKey, value, options.mode, ttlSeconds);
        } else {
          await client.set(fullKey, value);
        }
      },

      async del(key: string): Promise<void> {
        await client.del(`${keyPrefix}${key}`);
      },

      async keys(pattern: string): Promise<string[]> {
        return client.keys(`${keyPrefix}${pattern}`);
      },

      async quit(): Promise<void> {
        await client.quit();
        cachedRedisClient = null;
      },

      multi(): any {
        return client.multi();
      },
    };

    logger?.info('Redis client initialized with @oneunit/redis', { host: redisConfig.host, port: redisConfig.port });
    return cachedRedisClient;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    
    if (
      msg.includes('Cannot find module') ||
      msg.includes('Failed to load url') ||
      msg.includes('Cannot find package')
    ) {
      redisInitializationError = new Error(
        '@oneunit/redis is not installed. ' +
        'To use Redis, either:\n' +
        '  1. Install @oneunit/redis: pnpm add @oneunit/redis\n' +
        '  2. Or configure an ioredis driver by setting driver: "ioredis" in your Redis adapter config and installing ioredis: pnpm add ioredis\n' +
        '  3. Or configure a node-redis driver by setting driver: "node-redis" in your Redis adapter config and installing redis: pnpm add redis\n' +
        '  4. Or provide your own Redis infrastructure and client implementation.'
      );
    } else {
      redisInitializationError = err instanceof Error ? err : new Error(String(err));
    }
    
    throw redisInitializationError;
  }
}

export function resetRedisClient(): void {
  cachedRedisClient = null;
  redisInitializationError = null;
}

export function getCachedRedisClient(): RedisClient | null {
  return cachedRedisClient;
}