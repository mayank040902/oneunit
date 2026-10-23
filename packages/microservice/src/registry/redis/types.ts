import { RegistryStore } from '../registry.js';

export type RedisDriver = 'oneunit' | 'ioredis' | 'node-redis' | 'auto';

/**
 * TLS settings accepted by the supported Redis drivers.
 *
 * Only ioredis and node-redis support custom CA/client certificate material.
 * @oneunit/redis supports only the boolean form in the current driver.
 */
export interface RedisTlsConfig {
  ca?: string | string[] | Buffer | Buffer[];
  cert?: string | string[] | Buffer | Buffer[];
  key?: string | Buffer;
  passphrase?: string;
  servername?: string;
  rejectUnauthorized?: boolean;
  minVersion?: string;
  maxVersion?: string;
  ciphers?: string;
  [key: string]: unknown;
}

export type RedisTlsOptions = boolean | RedisTlsConfig;

export interface RedisAdapterConfig {
  driver?: RedisDriver;
  host: string;
  port: number;
  password?: string;
  db?: number;
  tls?: RedisTlsOptions;
  keyPrefix?: string;
  sentinels?: Array<{ host: string; port: number }>;
  sentinelName?: string;
  sentinelPassword?: string;
}

export interface RedisDriverModule {
  createStore(config: RedisAdapterConfig): Promise<RegistryStore>;
}

export interface RedisPipeline {
  get(key: string): RedisPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]>;
  quit(): Promise<void>;
  multi(): RedisPipeline;
  connect?(): Promise<void>;
}

export interface ResolvedRedisDriver {
  driver: RedisDriver;
  module: RedisDriverModule;
}
export function validateRedisTls(tls: RedisTlsOptions | undefined, supportsMaterial: boolean): void {
  if (tls === undefined || typeof tls === 'boolean') {
    return;
  }
  if (!supportsMaterial) {
    throw new Error(
      'Redis TLS certificate configuration is not supported by the selected Redis driver; use ioredis or node-redis',
    );
  }
  if (tls.cert !== undefined && tls.key === undefined) {
    throw new Error('Redis TLS client certificate requires a private key');
  }
  if (tls.key !== undefined && tls.cert === undefined) {
    throw new Error('Redis TLS private key requires a client certificate');
  }
  if (tls.rejectUnauthorized === false) {
    // Intentionally allowed, but never the default.
  }
}
