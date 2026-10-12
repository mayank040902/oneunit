import { RegistryStore } from '../registry.js';

export type RedisDriver = 'oneunit' | 'ioredis' | 'node-redis' | 'auto';

export interface RedisAdapterConfig {
  driver?: RedisDriver;
  host: string;
  port: number;
  password?: string;
  db?: number;
  tls?: boolean;
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