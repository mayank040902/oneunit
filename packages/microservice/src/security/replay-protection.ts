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

    if (sourceSet.size >= this.config.maxEntries) {
      this.cleanupSource(messageId.source);
    }

    sourceSet.add(key);
    this.timestamps.set(key, now);

    return { allowed: true };
  }

  isReplay(messageId: MessageId): boolean {
    const key = `${messageId.source}:${messageId.id}`;
    return this.store.get(messageId.source)?.has(key) ?? false;
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

  private cleanupSource(source: string): void {
    const sourceSet = this.store.get(source);
    if (!sourceSet) return;

    const keysToDelete = Array.from(sourceSet).slice(0, sourceSet.size / 2);
    for (const key of keysToDelete) {
      sourceSet.delete(key);
      this.timestamps.delete(key);
    }
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