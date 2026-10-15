export interface ReplayProtectionConfig {
  windowSize: number;
  maxEntries: number;
  ttlMs: number;
  futureSkewMs: number;
}

export interface MessageId {
  id: string;
  timestamp: number;
  source: string;
}

export class ReplayProtection {
  private store: Map<string, Set<string>> = new Map();
  private timestamps: Map<string, number> = new Map();
  private config: ReplayProtectionConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<ReplayProtectionConfig> = {}) {
    this.config = {
      windowSize: config.windowSize ?? 10000,
      maxEntries: config.maxEntries ?? 100000,
      ttlMs: config.ttlMs ?? 5 * 60 * 1000,
      futureSkewMs: config.futureSkewMs ?? 10 * 1000, // 10 seconds default future skew tolerance
    };
  }

  start(): void {
    if (this.cleanupTimer) return;
    
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.ttlMs);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  checkAndStore(messageId: MessageId): { allowed: boolean; reason?: string } {
    const key = `${messageId.source}:${messageId.id}`;
    const now = Date.now();

    // Opportunistic cleanup: reap expired entries so correctness does
    // not depend on start() being called. This is cheap (single scan
    // of timestamps) and keeps memory bounded even in one-shot usage.
    this.lazyCleanup(now);

    // Check if timestamp is too far in the future (beyond clock skew tolerance)
    if (messageId.timestamp > now + this.config.futureSkewMs) {
      return { allowed: false, reason: 'Message timestamp exceeds future skew tolerance' };
    }

    // Check if timestamp is too old (outside TTL window)
    if (now - messageId.timestamp > this.config.ttlMs) {
      return { allowed: false, reason: 'Message timestamp outside allowed window' };
    }

    let sourceSet = this.store.get(messageId.source);
    if (!sourceSet) {
      sourceSet = new Set();
      this.store.set(messageId.source, sourceSet);
    }

    if (sourceSet.has(key)) {
      return { allowed: false, reason: 'Duplicate message ID detected' };
    }

    // Enforce the per-source replay window: only the
    // most recent `windowSize` message IDs per source
    // are tracked, evicting the oldest entries first.
    // A replayed ID older than the window is no longer
    // detectable - this is the documented bound of the
    // replay state.
    while (sourceSet.size >= this.config.windowSize) {
      const oldest = sourceSet.values().next().value;
      if (oldest === undefined) break;
      sourceSet.delete(oldest);
      this.timestamps.delete(oldest);
    }

    // Enforce the global entry bound across all
    // sources. Fail closed when the store is at
    // capacity after purging expired entries.
    if (this.getTotalEntries() >= this.config.maxEntries) {
      this.cleanup();
      if (this.getTotalEntries() >= this.config.maxEntries) {
        return { allowed: false, reason: 'Replay store capacity reached' };
      }
    }

    sourceSet.add(key);
    this.timestamps.set(key, now);

    return { allowed: true };
  }

  isReplay(messageId: MessageId): boolean {
    const key = `${messageId.source}:${messageId.id}`;
    const stored = this.timestamps.get(key);
    if (stored === undefined) {
      return false;
    }
    if (Date.now() - stored > this.config.ttlMs) {
      return false;
    }
    return this.store.get(messageId.source)?.has(key) ?? false;
  }

  private lazyCleanup(now: number): void {
    const cutoff = now - this.config.ttlMs;
    let hadExpired = false;

    for (const [key, timestamp] of this.timestamps.entries()) {
      if (timestamp < cutoff) {
        hadExpired = true;
        const source = key.split(':', 1)[0];
        if (!source) continue;
        const sourceSet = this.store.get(source);
        if (sourceSet) {
          sourceSet.delete(key);
          if (sourceSet.size === 0) {
            this.store.delete(source);
          }
        }
        this.timestamps.delete(key);
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.config.ttlMs;

    for (const [key, timestamp] of this.timestamps.entries()) {
      if (timestamp < cutoff) {
        const source = key.split(':', 1)[0];
        if (!source) continue;
        const sourceSet = this.store.get(source);
        if (sourceSet) {
          sourceSet.delete(key);
          if (sourceSet.size === 0) {
            this.store.delete(source);
          }
        }
        this.timestamps.delete(key);
      }
    }
  }

  private getTotalEntries(): number {
    let total = 0;
    for (const set of this.store.values()) {
      total += set.size;
    }
    return total;
  }

  getStats(): { sources: number; totalEntries: number } {
    let total = 0;
    for (const set of this.store.values()) {
      total += set.size;
    }
    return { sources: this.store.size, totalEntries: total };
  }
}

export function createReplayProtection(config?: Partial<ReplayProtectionConfig>): ReplayProtection {
  return new ReplayProtection(config);
}