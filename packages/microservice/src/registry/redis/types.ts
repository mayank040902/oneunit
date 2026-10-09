import { RegistryStore, ServiceInstance, ServiceQuery } from '../registry.js';

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

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  quit(): Promise<void>;
  multi(): any;
  connect?(): Promise<void>;
}

export interface ResolvedRedisDriver {
  driver: RedisDriver;
  module: RedisDriverModule;
}