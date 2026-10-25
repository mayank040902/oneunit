import { Redis } from "ioredis";
import { jitterTtl } from "../features/core-helpers.js";
import { normalizeLogger } from "../logger.js";
import { runPipeline } from "../pipeline/builder.js";
import type {
  EvictionPolicy,
  RedisCacheOptions,
  CacheSetOptions,
  CacheLoadOptions,
  CacheMetrics,
  WriteBehindStats,
  L1CacheStats,
  RedisCache,
  ReadResult,
  CacheRecord,
} from "./types.js";


const DEFAULT_PREFIX = "oneunit:cache:";
const DEFAULT_SWR_STALE_SECONDS = 60;
const DEFAULT_WRITE_BEHIND_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_MAX_DIRTY_ENTRIES = 100;
const DEFAULT_MAX_DIRTY_AGE_MS = 5000;
const DEFAULT_L1_TTL_SECONDS = 60;
const DEFAULT_L1_MAX_ENTRIES = 10000;
const DEFAULT_L1_EVICTION_POLICY: EvictionPolicy = "lru";

let l1InsertionCounter = 0;

function cacheKey(prefix: string, key: string): string {
  return `${prefix}${key}`;
}

function tagKey(prefix: string, tag: string): string {
  return `${prefix}tag:${tag}`;
}

function expiresInSeconds(options?: CacheSetOptions, defaultTtlSeconds?: number): number | undefined {
  if (options?.ttlSeconds !== undefined) {
    return options.ttlSeconds;
  }
  return defaultTtlSeconds;
}

function effectiveTtl(
  options: CacheSetOptions | undefined,
  optionsRef: { defaultTtlSeconds?: number; jitter?: number },
): number | undefined {
  let ttl = expiresInSeconds(options, optionsRef.defaultTtlSeconds);
  if (ttl !== undefined && ttl > 0 && optionsRef.jitter) {
    ttl = jitterTtl(ttl, optionsRef.jitter);
  }
  return ttl;
}

export function createRedisCache(redis: Redis, options: RedisCacheOptions = {}): RedisCache {
  const prefix = options.keyPrefix ?? DEFAULT_PREFIX;
  const defaultTtlSeconds = options.defaultTtlSeconds;
  const jitter = options.jitter;
  if (jitter !== undefined && (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1)) {
    throw new Error("jitter must be between 0 and 1");
  }
  const negativeTtlSeconds = options.negativeTtlSeconds;
  const defaultSwr = options.staleWhileRevalidate ?? false;
  const swrStaleSeconds = options.swrStaleSeconds ?? DEFAULT_SWR_STALE_SECONDS;
  const logger = normalizeLogger(options.logger);

  // Write-behind configuration
  const writeBehindEnabled = options.writeBehind?.enabled ?? false;
  const writeBehindFlushIntervalMs = options.writeBehind?.flushIntervalMs ?? DEFAULT_WRITE_BEHIND_FLUSH_INTERVAL_MS;
  const writeBehindMaxDirtyEntries = options.writeBehind?.maxDirtyEntries ?? DEFAULT_MAX_DIRTY_ENTRIES;
  const writeBehindMaxDirtyAgeMs = options.writeBehind?.maxDirtyAgeMs ?? DEFAULT_MAX_DIRTY_AGE_MS;
  const writeBehindOnFlushError = options.writeBehind?.onFlushError;

  // Local L1 cache configuration
  const l1Enabled = options.localL1?.enabled ?? false;
  const l1TtlSeconds = options.localL1?.ttlSeconds ?? DEFAULT_L1_TTL_SECONDS;
  const l1PopulateOnMiss = options.localL1?.populateOnMiss ?? true;
  const l1MaxEntries = options.localL1?.sizePolicy?.maxEntries ?? DEFAULT_L1_MAX_ENTRIES;
  const l1MaxMemoryBytes = options.localL1?.sizePolicy?.maxMemoryBytes;
  const l1EvictionPolicy = options.localL1?.sizePolicy?.evictionPolicy ?? DEFAULT_L1_EVICTION_POLICY;

  // State
  const loading = new Map<string, Promise<unknown>>();
  const invalidationTokens = new Map<string, number>();
  let hits = 0;
  let misses = 0;
  let l1Hits = 0;
  let l1Misses = 0;
  let l1Evictions = 0;
  let writeBehindFlushes = 0;
  let writeBehindFlushErrors = 0;
  let writeBehindLastFlushAt: number | undefined;
  let writeBehindLastFlushErrorAt: number | undefined;

  // L1 cache: Map<key, CacheRecord>
  const l1Cache = new Map<string, CacheRecord>();
  // Write-behind dirty entries: Map<key, CacheRecord>
  const writeBehindDirty = new Map<string, CacheRecord>();
  let writeBehindFlushTimer: ReturnType<typeof setInterval> | undefined;
  let writeBehindDirtyOldestAt: number | undefined;

  function recordHit() {
    hits += 1;
  }

  function recordMiss() {
    misses += 1;
  }

  function recordL1Hit() {
    l1Hits += 1;
  }

  function recordL1Miss() {
    l1Misses += 1;
  }

  function metrics(): CacheMetrics {
    const total = hits + misses;
    return {
      hits,
      misses,
      hitRate: total === 0 ? 0 : hits / total,
      l1Hits,
      l1Misses,
      writeBehindFlushes,
      writeBehindPending: writeBehindDirty.size,
    };
  }

  function resetMetrics(): void {
    hits = 0;
    misses = 0;
    l1Hits = 0;
    l1Misses = 0;
    l1Evictions = 0;
    writeBehindFlushes = 0;
    writeBehindFlushErrors = 0;
    writeBehindLastFlushAt = undefined;
    writeBehindLastFlushErrorAt = undefined;
  }

  // L1 Cache helper functions
  function estimateRecordSize(record: CacheRecord): number {
    try {
      return JSON.stringify(record).length * 2; // rough estimate (UTF-16)
    } catch {
      return 1024; // fallback
    }
  }

  function getL1MemoryUsage(): number {
    let total = 0;
    for (const record of l1Cache.values()) {
      total += estimateRecordSize(record);
    }
    return total;
  }

  function evictL1Entries(count: number): number {
    if (l1Cache.size === 0 || count <= 0) return 0;

    const entries = Array.from(l1Cache.entries());
    let toEvict: string[] = [];

    switch (l1EvictionPolicy) {
      case "lru": {
        entries.sort((a, b) => (a[1].lastAccessed ?? 0) - (b[1].lastAccessed ?? 0));
        toEvict = entries.slice(0, count).map(([key]) => key);
        break;
      }
      case "lfu": {
        entries.sort((a, b) => (a[1].accessCount ?? 0) - (b[1].accessCount ?? 0));
        toEvict = entries.slice(0, count).map(([key]) => key);
        break;
      }
      case "fifo": {
        entries.sort((a, b) => (a[1].insertionOrder ?? 0) - (b[1].insertionOrder ?? 0));
        toEvict = entries.slice(0, count).map(([key]) => key);
        break;
      }
      case "random": {
        for (let i = 0; i < count && i < entries.length; i++) {
          const idx = Math.floor(Math.random() * entries.length);
          toEvict.push(entries[idx][0]);
          entries.splice(idx, 1);
        }
        break;
      }
    }

    for (const key of toEvict) {
      l1Cache.delete(key);
      l1Evictions++;
    }
    return toEvict.length;
  }

  function enforceL1SizePolicy(): void {
    // Check max entries
    if (l1MaxEntries > 0 && l1Cache.size >= l1MaxEntries) {
      const overage = l1Cache.size - l1MaxEntries + 1;
      evictL1Entries(overage);
    }

    // Check max memory
    if (l1MaxMemoryBytes && l1MaxMemoryBytes > 0) {
      let currentMemory = getL1MemoryUsage();
      if (currentMemory >= l1MaxMemoryBytes) {
        // Evict roughly 10% of entries or enough to get under limit
        const targetMemory = l1MaxMemoryBytes * 0.9;
        while (currentMemory > targetMemory && l1Cache.size > 0) {
          const evictedCount = evictL1Entries(Math.max(1, Math.ceil(l1Cache.size * 0.1)));
          if (evictedCount === 0) break;
          currentMemory = getL1MemoryUsage();
        }
      }
    }
  }

  function l1Get<T>(key: string): ReadResult<T> | null {
    const record = l1Cache.get(key);
    if (!record) {
      recordL1Miss();
      return null;
    }

    // Check TTL
    const effectiveL1Ttl = (() => {
      const cands: number[] = [];
      if (l1TtlSeconds > 0) cands.push(l1TtlSeconds);
      if (record.ttlSeconds !== undefined && record.ttlSeconds > 0) cands.push(record.ttlSeconds);
      return cands.length ? Math.min(...cands) : 0;
    })();
    if (effectiveL1Ttl > 0 && record.storedAt !== undefined) {
      const ageMs = Date.now() - record.storedAt;
      const ttlMs = effectiveL1Ttl * 1000;
      if (ageMs > ttlMs) {
        l1Cache.delete(key);
        recordL1Miss();
        return null;
      }
    }

    // Update access tracking
    record.lastAccessed = Date.now();
    record.accessCount = (record.accessCount ?? 0) + 1;
    recordL1Hit();

    let stale = false;
    if (record.storedAt !== undefined && record.ttlSeconds !== undefined) {
      const ageMs = Date.now() - record.storedAt;
      const ttlMs = effectiveL1Ttl > 0 ? effectiveL1Ttl * 1000 : record.ttlSeconds * 1000;
      const swrWindowMs = swrStaleSeconds * 1000;
      if (ageMs > ttlMs - swrWindowMs + 50 && ageMs <= ttlMs) {
        stale = true;
      }
    }

    return {
      hit: true,
      value: (record.value as T) ?? null,
      negative: !!record.negative,
      stale,
      fromL1: true,
    };
  }

  function l1Set(key: string, value: unknown, options: CacheSetOptions, negative: boolean): void {
    const ttl = effectiveTtl(options, { defaultTtlSeconds, jitter });
    const record: CacheRecord = {
      value,
      tags: options.tags ?? [],
      storedAt: Date.now(),
      ttlSeconds: ttl,
      negative,
      lastAccessed: Date.now(),
      accessCount: 1,
      insertionOrder: ++l1InsertionCounter,
      dirty: writeBehindEnabled && !options.writeThrough,
    };

    l1Cache.set(key, record);
    enforceL1SizePolicy();

    // Track dirty entries for write-behind
    if (writeBehindEnabled && record.dirty) {
      writeBehindDirty.set(key, record);
      if (writeBehindDirtyOldestAt === undefined) {
        writeBehindDirtyOldestAt = Date.now();
      }
      // Check if we need to trigger immediate flush
      if (writeBehindDirty.size >= writeBehindMaxDirtyEntries) {
        scheduleWriteBehindFlush();
      }
    }
  }

  function l1Delete(key: string): void {
    l1Cache.delete(key);
    writeBehindDirty.delete(key);
    if (writeBehindDirty.size === 0) {
      writeBehindDirtyOldestAt = undefined;
    }
  }

  function l1Clear(): void {
    l1Cache.clear();
    writeBehindDirty.clear();
    writeBehindDirtyOldestAt = undefined;
  }

  // Write-behind flush
  async function flushWriteBehind(): Promise<void> {
    if (writeBehindDirty.size === 0) return;

    const entriesToFlush = new Map(writeBehindDirty);
    writeBehindDirty.clear();
    writeBehindDirtyOldestAt = undefined;

    try {
      const steps: { label: string; run: (pipeline: unknown) => void }[] = [];

      for (const [key, record] of entriesToFlush) {
        const targetKey = cacheKey(prefix, key);
        const payload = JSON.stringify({
          value: record.value,
          tags: record.tags,
          storedAt: record.storedAt,
          ttlSeconds: record.ttlSeconds,
          negative: record.negative,
        });

        steps.push({
          label: `wb:set:${key}`,
          run: (pipeline: unknown) => {
            const p = pipeline as { set(key: string, value: string, ...rest: unknown[]): unknown };
            if (record.ttlSeconds && record.ttlSeconds > 0) {
              p.set(targetKey, payload, "EX", record.ttlSeconds);
            } else {
              p.set(targetKey, payload);
            }
          },
        });

        // Handle tags
        if (record.tags && record.tags.length > 0) {
          for (const tag of record.tags) {
            steps.push({
              label: `wb:tag:${tag}`,
              run: (pipeline: unknown) => {
                const p = pipeline as { sadd(key: string, member: string): unknown };
                p.sadd(tagKey(prefix, tag), targetKey);
              },
            });
            if (record.ttlSeconds && record.ttlSeconds > 0) {
              steps.push({
                label: `wb:tag-expire:${tag}`,
                run: (pipeline: unknown) => {
                  const p = pipeline as { expire(key: string, seconds: number): unknown };
                  p.expire(tagKey(prefix, tag), record.ttlSeconds!);
                },
              });
            }
          }
        }
      }

      await runPipeline(redis, steps, { logger });
      writeBehindFlushes++;
      writeBehindLastFlushAt = Date.now();

      // Clear dirty flag in L1 cache
      for (const key of entriesToFlush.keys()) {
        const record = l1Cache.get(key);
        if (record) {
          record.dirty = false;
        }
      }
    } catch (error) {
      writeBehindFlushErrors++;
      writeBehindLastFlushErrorAt = Date.now();
      logger?.error("write-behind flush failed", redactToLog(error));
      // Re-add entries to dirty map on failure
      for (const [key, record] of entriesToFlush) {
        writeBehindDirty.set(key, record);
        if (writeBehindDirtyOldestAt === undefined || record.storedAt! < writeBehindDirtyOldestAt) {
          writeBehindDirtyOldestAt = record.storedAt!;
        }
      }
      writeBehindOnFlushError?.(error instanceof Error ? error : new Error(String(error)), entriesToFlush);
    }
  }

  function scheduleWriteBehindFlush(): void {
    if (writeBehindFlushTimer) return;

    writeBehindFlushTimer = setInterval(async () => {
      const now = Date.now();
      const shouldFlush =
        writeBehindDirty.size >= writeBehindMaxDirtyEntries ||
        (writeBehindDirtyOldestAt !== undefined && now - writeBehindDirtyOldestAt >= writeBehindMaxDirtyAgeMs);

      if (shouldFlush) {
        await flushWriteBehind();
      }

      // Stop timer if no more dirty entries
      if (writeBehindDirty.size === 0) {
        clearInterval(writeBehindFlushTimer);
        writeBehindFlushTimer = undefined;
      }
    }, writeBehindFlushIntervalMs);

    // Don't prevent process exit
    writeBehindFlushTimer.unref?.();
  }

  async function read<T>(key: string): Promise<ReadResult<T> | null> {
    // Try L1 cache first
    if (l1Enabled) {
      const l1Result = l1Get<T>(key);
      if (l1Result) {
        return l1Result;
      }
    }

    // Fall back to Redis
    const raw = await redis.get(cacheKey(prefix, key));
    if (!raw) {
      return null;
    }

    let record: CacheRecord;
    try {
      record = JSON.parse(raw) as CacheRecord;
    } catch {
      await redis.del(cacheKey(prefix, key)).catch(() => undefined);
      return null;
    }

    let stale = false;
    if (record.storedAt !== undefined && record.ttlSeconds !== undefined) {
      const ageMs = Date.now() - record.storedAt;
      const ttlMs = record.ttlSeconds * 1000;
      const swrWindowMs = swrStaleSeconds * 1000;
      if (ageMs > ttlMs - swrWindowMs + 50 && ageMs <= ttlMs) {
        stale = true;
      } else if (ageMs > ttlMs) {
        await redis.del(cacheKey(prefix, key)).catch(() => undefined);
        return null;
      }
    }

    // Populate L1 cache on miss if enabled
    if (l1Enabled && l1PopulateOnMiss) {
      const l1Record: CacheRecord = {
        ...record,
        lastAccessed: Date.now(),
        accessCount: 1,
        insertionOrder: ++l1InsertionCounter,
      };
      l1Cache.set(key, l1Record);
      enforceL1SizePolicy();
    }

    return {
      hit: true,
      value: (record.value as T) ?? null,
      negative: !!record.negative,
      stale,
      fromL1: false,
    };
  }

  async function get<T>(key: string): Promise<T | null> {
    const result = await read<T>(key);
    if (!result) {
      recordMiss();
      return null;
    }
    recordHit();
    return result.value;
  }

  async function set(
    key: string,
    value: unknown,
    options: CacheSetOptions = {},
  ): Promise<void> {
    await store(key, value, options, false);
  }

  async function store(
    key: string,
    value: unknown,
    options: CacheSetOptions,
    negative: boolean,
    beginToken?: number,
  ): Promise<void> {
    if (beginToken !== undefined) {
      const current = invalidationTokens.get(key) ?? 0;
      if (current !== beginToken) {
        return;
      }
    }
    const writeThrough = options.writeThrough ?? !writeBehindEnabled;

    if (l1Enabled && !writeThrough) {
      // Write to L1 cache with write-behind
      l1Set(key, value, options, negative);
      return;
    }

    // Write directly to Redis (write-through)
    const ttl = effectiveTtl(options, { defaultTtlSeconds, jitter });
    const record: CacheRecord = {
      value,
      tags: options.tags ?? [],
      storedAt: Date.now(),
      ttlSeconds: ttl,
      negative,
    };
    const payload = JSON.stringify(record);
    const targetKey = cacheKey(prefix, key);

    if ((!record.tags || record.tags.length === 0) && !ttl) {
      await redis.set(targetKey, payload);
    } else {
      const steps: { label: string; run: (pipeline: unknown) => void }[] = [
        {
          label: "cache:set",
          run: (pipeline: unknown) => {
            const p = pipeline as { set(key: string, value: string, ...rest: unknown[]): unknown };
            if (ttl && ttl > 0) {
              p.set(targetKey, payload, "EX", ttl);
            } else {
              p.set(targetKey, payload);
            }
          },
        },
      ];

      if (record.tags && record.tags.length > 0) {
        for (const tag of record.tags) {
          steps.push({
            label: `tag:${tag}`,
            run: (pipeline: unknown) => {
              const p = pipeline as { sadd(key: string, member: string): unknown };
              p.sadd(tagKey(prefix, tag), targetKey);
            },
          });
          if (ttl && ttl > 0) {
            steps.push({
              label: `tag-expire:${tag}`,
              run: (pipeline: unknown) => {
                const p = pipeline as { expire(key: string, seconds: number): unknown };
                p.expire(tagKey(prefix, tag), ttl);
              },
            });
          }
        }
      }

      await runPipeline(redis, steps, { logger });
    }

    // Also update L1 cache if enabled
    if (l1Enabled) {
      const l1Record: CacheRecord = {
        ...record,
        lastAccessed: Date.now(),
        accessCount: 1,
        insertionOrder: ++l1InsertionCounter,
        dirty: false,
      };
      l1Cache.set(key, l1Record);
      enforceL1SizePolicy();
    }
  }

  async function invalidate(key: string): Promise<void> {
    const token = (invalidationTokens.get(key) ?? 0) + 1;
    invalidationTokens.set(key, token);
    loading.delete(key);
    await redis.del(cacheKey(prefix, key));
    if (l1Enabled) {
      l1Delete(key);
    }
    writeBehindDirty.delete(key);
  }

  async function invalidateTag(tag: string): Promise<void> {
    const members = await redis.smembers(tagKey(prefix, tag));
    // Track invalidation tokens for each affected key so that any in-flight
    // loader does not repopulate stale data after invalidation.
    for (const member of members) {
      const key = member.startsWith(prefix) ? member.slice(prefix.length) : member;
      invalidationTokens.set(key, (invalidationTokens.get(key) ?? 0) + 1);
      loading.delete(key);
    }

    if (members.length === 0) {
      await redis.del(tagKey(prefix, tag));
      return;
    }

    const steps: { label: string; run: (pipeline: unknown) => void }[] = members.map((member) => ({
      label: `del:${member}`,
      run: (pipeline: unknown) => {
        const p = pipeline as { del(key: string): unknown };
        p.del(member);
      },
    }));
    steps.push({ label: "del:tag", run: (pipeline: unknown) => { const p = pipeline as { del(key: string): unknown }; p.del(tagKey(prefix, tag)); } });
    await runPipeline(redis, steps, { logger });

    // Also invalidate from L1 cache
    if (l1Enabled) {
      for (const member of members) {
        // Extract key from member (member is the full cache key)
        const key = member.startsWith(prefix) ? member.slice(prefix.length) : member;
        const token = (invalidationTokens.get(key) ?? 0) + 1;
        invalidationTokens.set(key, token);
        loading.delete(key);
        l1Delete(key);
      }
    }
  }

  async function revalidate<T>(
    key: string,
    loader: () => Promise<T> | T,
    options: CacheLoadOptions,
  ): Promise<void> {
    const beginToken = invalidationTokens.get(key) ?? 0;
    try {
      const result = await Promise.resolve(loader());
      if ((invalidationTokens.get(key) ?? 0) !== beginToken) return;
      const shouldNegative = result == null && negativeCachingEnabled(options);
      await store(
        key,
        result,
        shouldNegative ? { ttlSeconds: negativeTtlSeconds, tags: options.tags } : options,
        shouldNegative,
        beginToken,
      );
    } catch (error) {
      logger?.warn("redis cache background revalidate failed", redactToLog(error));
    }
  }

  function negativeCachingEnabled(options: CacheLoadOptions): boolean {
    if (options.negativeCaching !== undefined) {
      return options.negativeCaching;
    }
    return negativeTtlSeconds !== undefined;
  }

  function swrEnabled(options: CacheLoadOptions): boolean {
    if (options.staleWhileRevalidate !== undefined) {
      return options.staleWhileRevalidate;
    }
    return defaultSwr;
  }

  async function doLoad<T>(
    key: string,
    loader: () => Promise<T> | T,
    options: CacheLoadOptions,
    beginToken?: number,
  ): Promise<T> {
    const result = await Promise.resolve(loader());

    const shouldNegative = result == null && negativeCachingEnabled(options);
    const token = beginToken !== undefined ? beginToken : (invalidationTokens.get(key) ?? 0);

    try {
      await store(
        key,
        result,
        shouldNegative ? { ttlSeconds: negativeTtlSeconds, tags: options.tags } : options,
        shouldNegative,
        token,
      );
    } catch (error) {
      logger?.warn("redis cache set failed", redactToLog(error));
    }

    return result;
  }

  async function getOrLoad<T>(
    key: string,
    loader: () => Promise<T> | T,
    options: CacheLoadOptions = {},
  ): Promise<T> {
    const stampedeProtection = options.stampedeProtection !== false;

    const existing = loading.get(key);
    if (existing) {
      recordHit();
      return existing as Promise<T>;
    }

    const run = async (): Promise<T> => {
      const beginToken = invalidationTokens.get(key) ?? 0;
      const readResult = await read<T>(key);
      if (readResult) {
        recordHit();
        if (readResult.negative) {
          return null as unknown as T;
        }
        if (readResult.value !== null) {
          if (readResult.stale && swrEnabled(options)) {
            void revalidate(key, loader, options);
          }
          return readResult.value;
        }
        // An explicitly stored null is not a usable hit: reload below.
      } else {
        recordMiss();
      }
      return doLoad(key, loader, options, beginToken);
    };

    if (!stampedeProtection) {
      return run();
    }

    // Register the in-flight promise synchronously, before the first await
    // yields, so concurrent callers coalesce onto a single loader execution.
    const promise = run().finally(() => loading.delete(key));
    loading.set(key, promise);
    return promise;
  }

  function wrap<TArgs extends unknown[], TResult>(
    keyFactory: (...args: TArgs) => string,
    fn: (...args: TArgs) => Promise<TResult> | TResult,
    options: CacheLoadOptions = {},
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs) => {
      const key = keyFactory(...args);
      return getOrLoad(key, () => fn(...args), options);
    };
  }

  function redactToLog(error: unknown): unknown {
    return error instanceof Error ? error.message : String(error);
  }

  async function writeThrough<T>(
    key: string,
    writer: () => Promise<T> | T,
    options: CacheSetOptions = {},
  ): Promise<T> {
    const result = await Promise.resolve(writer());
    await set(key, result, { ...options, writeThrough: true });
    return result;
  }

  async function warm<T>(
    key: string,
    loader: () => Promise<T> | T,
    options: CacheLoadOptions = {},
  ): Promise<void> {
    const beginToken = invalidationTokens.get(key) ?? 0;
    const result = await Promise.resolve(loader());
    await store(key, result, options, false, beginToken);
  }

  function remember<T>(
    key: string,
    loader: () => Promise<T> | T,
    options: CacheLoadOptions = {},
  ): Promise<T> {
    return getOrLoad(key, loader, options);
  }

  function writeBehindStats(): WriteBehindStats {
    return {
      pending: writeBehindDirty.size,
      flushes: writeBehindFlushes,
      flushErrors: writeBehindFlushErrors,
      lastFlushAt: writeBehindLastFlushAt,
      lastFlushErrorAt: writeBehindLastFlushErrorAt,
    };
  }

  async function forceFlushWriteBehind(): Promise<void> {
    await flushWriteBehind();
  }

  function l1Stats(): L1CacheStats {
    return {
      entries: l1Cache.size,
      memoryBytes: getL1MemoryUsage(),
      evictions: l1Evictions,
      hits: l1Hits,
      misses: l1Misses,
    };
  }

  function clearL1(): void {
    l1Clear();
  }

  function evictL1(count?: number): number {
    const numToEvict = count ?? Math.ceil(l1Cache.size * 0.1);
    return evictL1Entries(numToEvict);
  }

  async function shutdown(): Promise<void> {
    // Flush any pending write-behind entries
    if (writeBehindEnabled && writeBehindDirty.size > 0) {
      await flushWriteBehind();
    }

    // Clear timers
    if (writeBehindFlushTimer) {
      clearInterval(writeBehindFlushTimer);
      writeBehindFlushTimer = undefined;
    }

    // Clear L1 cache
    l1Clear();
  }

  // Start write-behind flush timer if enabled
  if (writeBehindEnabled) {
    scheduleWriteBehindFlush();
  }

  return {
    redis,
    writeThrough,
    warm,
    get,
    set,
    invalidate,
    invalidateTag,
    getOrLoad,
    remember,
    wrap,
    metrics,
    resetMetrics,
    writeBehindStats,
    flushWriteBehind: forceFlushWriteBehind,
    l1Stats,
    clearL1,
    evictL1,
    shutdown,
  };
}
