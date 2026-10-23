import { RedisAdapterConfig } from './types.js';
import { Logger } from '@/observability/logger.js';
import { RedisPipeline } from './types.js';

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { mode?: 'EX' | 'PX' | 'EXAT' | 'PXAT'; ttlMs?: number }): Promise<void>;
  del(key: string): Promise<void>;
  scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]>;
  quit(): Promise<void>;
  multi(): RedisPipeline;
}

interface OneUnitRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttlSeconds: number): Promise<void>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  scan(cursor: string, ...args: string[]): Promise<[string, string[]]>;
  quit(): Promise<void>;
  multi(): RedisPipeline;
}

export interface RedisClientConfig {
  config: RedisAdapterConfig;
  logger?: Logger;
}

let cachedRedisClient: RedisClient | null = null;
let redisInitializationPromise: Promise<RedisClient> | null = null;

export function isRedisAvailable(): boolean {
  try {
    import.meta.resolve('@oneunit/redis');
    return true;
  } catch {
    return false;
  }
}

export async function createRedisClient(config: RedisClientConfig): Promise<RedisClient> {
  if (cachedRedisClient) {
    return cachedRedisClient;
  }
  if (redisInitializationPromise) {
    return redisInitializationPromise;
  }

  const { config: redisConfig, logger } = config;

  let resolveInitialization!: (value: RedisClient) => void;
  let rejectInitialization!: (reason?: unknown) => void;
  redisInitializationPromise = new Promise<RedisClient>((resolve, reject) => {
    resolveInitialization = resolve;
    rejectInitialization = reject;
  });

  (async () => {
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
      }, logger)) as unknown as OneUnitRedisClient;

      const keyPrefix = redisConfig.keyPrefix ?? 'microservice:';

      const redisClient: RedisClient = {
        async get(key: string): Promise<string | null> {
          return client.get(`${keyPrefix}${key}`);
        },

        async set(key: string, value: string, options?: { mode?: 'EX' | 'PX' | 'EXAT' | 'PXAT'; ttlMs?: number }): Promise<void> {
          const fullKey = `${keyPrefix}${key}`;
          if (options?.ttlMs && options.ttlMs > 0) {
            const mode = options.mode ?? 'PX';
            const ttl = options.mode === 'EX' || options.mode === 'EXAT'
              ? Math.ceil(options.ttlMs / 1000)
              : options.ttlMs;
            await client.set(fullKey, value, mode, ttl);
          } else if (options?.mode) {
            throw new Error('TTL value is required when an expiration mode is specified');
          } else {
            await client.set(fullKey, value);
          }
        },

        async del(key: string): Promise<void> {
          await client.del(`${keyPrefix}${key}`);
        },

        async scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]> {
          return client.scan(cursor, ...args as string[]);
        },

        async quit(): Promise<void> {
          await client.quit();
          cachedRedisClient = null;
        },

        multi(): RedisPipeline {
          return client.multi();
        },
      };

      cachedRedisClient = redisClient;
      logger?.info('Redis client initialized with @oneunit/redis', { host: redisConfig.host, port: redisConfig.port });
      resolveInitialization(redisClient);
    } catch (err) {
      redisInitializationPromise = null;
      const msg = err instanceof Error ? err.message : String(err);

      if (
        msg.includes('Cannot find module') ||
        msg.includes('Failed to load url') ||
        msg.includes('Cannot find package')
      ) {
        rejectInitialization(new Error(
          '@oneunit/redis is not installed. Configure another Redis driver instead.',
        ));
      } else {
        rejectInitialization(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      redisInitializationPromise = null;
    }
  })();

  return redisInitializationPromise;
}

export function resetRedisClient(): void {
  cachedRedisClient = null;
  redisInitializationPromise = null;
}

export function getCachedRedisClient(): RedisClient | null {
  return cachedRedisClient;
}
