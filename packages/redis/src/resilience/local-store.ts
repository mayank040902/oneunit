import type { Logger } from "../logger.js";
import {
  type LocalEntry,
  type LocalRead,
  type LocalStoreMetrics,
  type LocalStoreOptions,
} from "./types.js";

const DEFAULT_MAX_ENTRIES = 10000;
const DEFAULT_MAX_PAYLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024;

function estimateEntrySize(entry: LocalEntry<unknown>): number {
  let size = 128;
  size += Buffer.byteLength(String(entry.value ?? ""));
  if (entry.expiresAt !== undefined) {
    size += 8;
  }
  return size;
}

function estimateValueBytes(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "string") {
    return Buffer.byteLength(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return 8;
  }
  if (Buffer.isBuffer(value)) {
    return value.length;
  }
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 256;
  }
}

export class LocalStore<T = unknown> {
  private readonly maxEntries: number;
  private readonly maxPayloadBytes: number;
  private readonly maxEntryBytes: number;
  private readonly logger: Logger | undefined;

  private readonly entries = new Map<string, LocalEntry<T>>();
  private estimatedBytes = 0;

  private localReads = 0;
  private localReadHits = 0;
  private localReadMisses = 0;
  private localReadUnknown = 0;
  private localWrites = 0;
  private localDeletions = 0;
  private entriesExpired = 0;
  private entriesRejected = 0;
  private overflowEvents = 0;

  constructor(options: LocalStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
    this.logger = options.logger;
  }

  get size(): number {
    return this.entries.size;
  }

  get estimatedPayloadBytes(): number {
    return this.estimatedBytes;
  }

  get isEmpty(): boolean {
    return this.entries.size === 0;
  }

  get overflowCount(): number {
    return this.overflowEvents;
  }

  metrics(): LocalStoreMetrics {
    return {
      entries: this.entries.size,
      estimatedPayloadBytes: this.estimatedBytes,
      localReads: this.localReads,
      localReadHits: this.localReadHits,
      localReadMisses: this.localReadMisses,
      localReadUnknown: this.localReadUnknown,
      localWrites: this.localWrites,
      localDeletions: this.localDeletions,
      entriesExpired: this.entriesExpired,
      entriesRejected: this.entriesRejected,
      overflowEvents: this.overflowEvents,
    };
  }

  read(key: string, now: number = Date.now()): LocalRead<T> {
    this.localReads += 1;

    const entry = this.entries.get(key);
    if (!entry) {
      this.localReadUnknown += 1;
      return { result: "UNKNOWN", value: null };
    }

    if (entry.state === "tombstone") {
      this.localReadMisses += 1;
      return { result: "MISS", value: null, operationId: entry.operationId };
    }

    if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
      this.release(key);
      this.entriesExpired += 1;
      this.localReadMisses += 1;
      this.logger?.debug("redis resilience: local entry expired on read", {
        key,
        operationId: entry.operationId,
      });
      return { result: "MISS", value: null, operationId: entry.operationId };
    }

    if (entry.state === "expired") {
      this.localReadMisses += 1;
      return { result: "MISS", value: null, operationId: entry.operationId };
    }

    this.localReadHits += 1;
    let remainingTtlSeconds: number | undefined;
    if (entry.expiresAt !== undefined) {
      remainingTtlSeconds = Math.max(0, Math.ceil((entry.expiresAt - now) / 1000));
    }
    return {
      result: "HIT",
      value: entry.value,
      operationId: entry.operationId,
      remainingTtlSeconds,
    };
  }

  write(
    key: string,
    value: T,
    opts: { ttlSeconds?: number; operationId: string; now?: number },
  ): LocalEntry<T> {
    const now = opts.now ?? Date.now();

    const valueBytes = estimateValueBytes(value);
    if (valueBytes > this.maxEntryBytes) {
      this.entriesRejected += 1;
      this.logger?.warn(
        "redis resilience: local entry exceeds max size, rejecting",
        { key, sizeBytes: valueBytes },
      );
      throw new Error(`Local entry for key "${key}" exceeds maximum entry size`);
    }

    const sizeBytes = estimateEntrySize({
      value,
      state: "valid",
      version: 0,
      operationId: "",
      updatedAt: now,
    } as LocalEntry<T>);

    const wouldExceedCount = this.entries.size + 1 > this.maxEntries;
    const wouldExceedBytes = this.estimatedBytes + sizeBytes > this.maxPayloadBytes;

    if (wouldExceedCount || wouldExceedBytes) {
      this.overflowEvents += 1;
      this.entriesRejected += 1;
      this.logger?.warn("redis resilience: local store at capacity", {
        entries: this.entries.size,
        estimatedBytes: this.estimatedBytes,
        key,
      });
      throw new Error("Local store at capacity; cannot accept write");
    }

    const existing = this.entries.get(key);
    if (existing) {
      this.estimatedBytes -= estimateEntrySize(existing as LocalEntry<unknown>);
    }

    const entry: LocalEntry<T> = {
      value,
      state: "valid",
      expiresAt:
        opts.ttlSeconds !== undefined ? now + opts.ttlSeconds * 1000 : undefined,
      version: (existing?.version ?? 0) + 1,
      operationId: opts.operationId,
      updatedAt: now,
    };

    this.entries.set(key, entry);
    this.estimatedBytes += sizeBytes;
    this.localWrites += 1;

    this.logger?.debug("redis resilience: local write applied", {
      key,
      operationId: opts.operationId,
      version: entry.version,
    });

    return entry;
  }

  del(key: string, opts: { operationId: string; now?: number }): LocalEntry<T> {
    const now = opts.now ?? Date.now();
    const existing = this.entries.get(key);

    const tombstone: LocalEntry<T> = {
      value: null,
      state: "tombstone",
      expiresAt:
        existing?.expiresAt !== undefined && existing.expiresAt > now
          ? existing.expiresAt
          : now + 300,
      version: (existing?.version ?? 0) + 1,
      operationId: opts.operationId,
      updatedAt: now,
    };

    if (existing) {
      this.estimatedBytes -= estimateEntrySize(existing as LocalEntry<unknown>);
    }
    this.entries.set(key, tombstone);
    this.estimatedBytes += estimateEntrySize(tombstone as LocalEntry<unknown>);
    this.localDeletions += 1;

    this.logger?.debug("redis resilience: local delete applied (tombstone)", {
      key,
      operationId: opts.operationId,
      version: tombstone.version,
    });

    return tombstone;
  }

  expireStale(now: number = Date.now()): string[] {
    const expired: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        expired.push(key);
      }
    }
    for (const key of expired) {
      this.release(key);
      this.entriesExpired += 1;
    }
    return expired;
  }

  get(key: string): LocalEntry<T> | undefined {
    return this.entries.get(key);
  }

  list(): LocalEntry<T>[] {
    return Array.from(this.entries.values());
  }

  remove(key: string): void {
    this.release(key);
  }

  clear(): void {
    this.entries.clear();
    this.estimatedBytes = 0;
  }

  private release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.entries.delete(key);
    this.estimatedBytes -= estimateEntrySize(entry as LocalEntry<unknown>);
    if (this.estimatedBytes < 0) {
      this.estimatedBytes = 0;
    }
  }
}
