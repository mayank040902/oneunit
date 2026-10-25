import { type Redis } from "ioredis";
import { type Logger } from "../logger.js";

export type EvictionPolicy = "lru" | "lfu" | "fifo" | "random";

export interface CacheSizePolicy {
  /** Maximum number of entries in the local L1 cache. */
  maxEntries?: number;
  /** Maximum memory in bytes for the local L1 cache (approximate). */
  maxMemoryBytes?: number;
  /** Eviction policy when size limits are reached. */
  evictionPolicy?: EvictionPolicy;
}

export interface WriteBehindOptions {
  /** Enable write-behind mode. When enabled, writes go to L1 cache first. */
  enabled?: boolean;
  /** Interval in milliseconds to flush dirty entries to Redis. */
  flushIntervalMs?: number;
  /** Maximum number of dirty entries before forced flush. */
  maxDirtyEntries?: number;
  /** Maximum time in milliseconds a dirty entry can wait before flush. */
  maxDirtyAgeMs?: number;
  /** Callback when write-behind flush fails. */
  onFlushError?: (error: Error, entries: Map<string, CacheRecord>) => void;
}

export interface LocalL1CacheOptions {
  /** Enable local L1 cache. */
  enabled?: boolean;
  /** Size policies for the local cache. */
  sizePolicy?: CacheSizePolicy;
  /** TTL for local cache entries (in seconds). 0 = no TTL. */
  ttlSeconds?: number;
  /** Whether to warm L1 cache on cache misses. */
  populateOnMiss?: boolean;
}

export interface RedisCacheOptions {
  keyPrefix?: string;
  defaultTtlSeconds?: number;
  logger?: Logger;
  /**
   * Cache "not found" results for this many seconds (negative caching).
   * When set, `getOrLoad` stores a negative marker so a loader that returns
   * nullish isn't re-run on every request while the marker survives.
   */
  negativeTtlSeconds?: number;
  /**
   * Serve stale values while revalidating them in the background.
   * Applies to `getOrLoad`/`remember`/`wrap` when a value is present but past
   * its staleness window.
   */
  staleWhileRevalidate?: boolean;
  /**
   * Seconds before expiry a value is considered stale (SWR window).
   * Defaults to 60 when `staleWhileRevalidate` is enabled.
   */
  swrStaleSeconds?: number;
  /**
   * Apply TTL jitter (0 to 1) to every stored TTL so expiries spread out
   * instead of clustering, which thins cache stampedes at expiry time.
   */
  jitter?: number;
  /** Track cache hit/miss metrics exposed via `metrics()`. */
  metrics?: boolean;
  /** Write-behind caching configuration. */
  writeBehind?: WriteBehindOptions;
  /** Local L1 cache configuration. */
  localL1?: LocalL1CacheOptions;
}

export interface CacheSetOptions {
  ttlSeconds?: number;
  tags?: string[];
  /** Skip write-behind and write directly to Redis. */
  writeThrough?: boolean;
}

export interface CacheLoadOptions extends CacheSetOptions {
  stampedeProtection?: boolean;
  /** Override negative caching for this load. */
  negativeCaching?: boolean;
  /** Override stale-while-revalidate for this load. */
  staleWhileRevalidate?: boolean;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  /** hits / (hits + misses), or 0 when nothing has been read. */
  hitRate: number;
  /** Local L1 cache hits. */
  l1Hits?: number;
  /** Local L1 cache misses. */
  l1Misses?: number;
  /** Write-behind flush count. */
  writeBehindFlushes?: number;
  /** Write-behind pending dirty entries. */
  writeBehindPending?: number;
}

export interface WriteBehindStats {
  /** Number of dirty entries waiting to be flushed. */
  pending: number;
  /** Number of successful flushes. */
  flushes: number;
  /** Number of failed flushes. */
  flushErrors: number;
  /** Timestamp of last successful flush. */
  lastFlushAt?: number;
  /** Timestamp of last flush error. */
  lastFlushErrorAt?: number;
}

export interface L1CacheStats {
  /** Current number of entries in L1 cache. */
  entries: number;
  /** Approximate memory usage in bytes. */
  memoryBytes: number;
  /** Number of evictions due to size policy. */
  evictions: number;
  /** L1 cache hits. */
  hits: number;
  /** L1 cache misses. */
  misses: number;
}

export interface RedisCache {
  redis: Redis;
  writeThrough<T>(
    key: string,
    writer: () => Promise<T> | T,
    options?: CacheSetOptions,
  ): Promise<T>;
  /**
   * Populate the cache for a key without returning the loaded value.
   * Useful for warming a cache ahead of traffic.
   */
  warm<T>(key: string, loader: () => Promise<T> | T, options?: CacheLoadOptions): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, options?: CacheSetOptions): Promise<void>;
  invalidate(key: string): Promise<void>;
  invalidateTag(tag: string): Promise<void>;
  getOrLoad<T>(key: string, loader: () => Promise<T> | T, options?: CacheLoadOptions): Promise<T>;
  remember<T>(key: string, loader: () => Promise<T> | T, options?: CacheLoadOptions): Promise<T>;
  wrap<TArgs extends unknown[], TResult>(
    keyFactory: (...args: TArgs) => string,
    fn: (...args: TArgs) => Promise<TResult> | TResult,
    options?: CacheLoadOptions,
  ): (...args: TArgs) => Promise<TResult>;
  metrics(): CacheMetrics;
  resetMetrics(): void;
  /** Get write-behind statistics. */
  writeBehindStats(): WriteBehindStats;
  /** Force flush all dirty write-behind entries to Redis. */
  flushWriteBehind(): Promise<void>;
  /** Get local L1 cache statistics. */
  l1Stats(): L1CacheStats;
  /** Clear the local L1 cache. */
  clearL1(): void;
  /** Manually evict entries from L1 cache based on policy. */
  evictL1(count?: number): number;
  /** Shutdown the cache (flush write-behind, clear timers). */
  shutdown(): Promise<void>;
}

export interface CacheRecord {
  value: unknown;
  tags: string[];
  storedAt?: number;
  ttlSeconds?: number;
  negative?: boolean;
  /** Write-behind: whether this entry is dirty (modified but not flushed to Redis). */
  dirty?: boolean;
  /** L1 cache: last access time for LRU. */
  lastAccessed?: number;
  /** L1 cache: access count for LFU. */
  accessCount?: number;
  /** L1 cache: insertion order for FIFO. */
  insertionOrder?: number;
}

export interface ReadResult<T> {
  hit: boolean;
  value: T | null;
  negative: boolean;
  stale: boolean;
  /** Whether the result came from L1 cache. */
  fromL1?: boolean;
}

