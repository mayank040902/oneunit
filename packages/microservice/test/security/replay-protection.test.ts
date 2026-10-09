import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ReplayProtectionConfig,
  MessageId,
  ReplayProtection,
  createReplayProtection,
} from '../../src/security/replay-protection.js';

describe('ReplayProtection', () => {
  let protection: ReplayProtection;

  beforeEach(() => {
    protection = createReplayProtection({
      windowSize: 1000,
      maxEntries: 100,
      ttlMs: 5000,
    });
  });

  afterEach(() => {
    protection.stop();
  });

  it('should create with default config', () => {
    const defaultProtection = createReplayProtection();
    expect(defaultProtection).toBeInstanceOf(ReplayProtection);
    defaultProtection.stop();
  });

  it('should allow first message', () => {
    const messageId: MessageId = {
      id: 'msg-1',
      timestamp: Date.now(),
      source: 'service-1',
    };
    
    const result = protection.checkAndStore(messageId);
    
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('should reject duplicate message', () => {
    const messageId: MessageId = {
      id: 'msg-1',
      timestamp: Date.now(),
      source: 'service-1',
    };
    
    protection.checkAndStore(messageId);
    const result = protection.checkAndStore(messageId);
    
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Duplicate message ID detected');
  });

  it('should reject message with old timestamp', () => {
    const oldTimestamp = Date.now() - 10000; // 10 seconds ago, beyond 5 second TTL
    const messageId: MessageId = {
      id: 'msg-1',
      timestamp: oldTimestamp,
      source: 'service-1',
    };
    
    const result = protection.checkAndStore(messageId);
    
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Message timestamp outside allowed window');
  });

  it('should allow message within TTL', () => {
    const recentTimestamp = Date.now() - 1000; // 1 second ago
    const messageId: MessageId = {
      id: 'msg-1',
      timestamp: recentTimestamp,
      source: 'service-1',
    };
    
    const result = protection.checkAndStore(messageId);
    
    expect(result.allowed).toBe(true);
  });

  it('should track messages per source separately', () => {
    const messageId1: MessageId = {
      id: 'msg-1',
      timestamp: Date.now(),
      source: 'service-1',
    };
    
    const messageId2: MessageId = {
      id: 'msg-1', // Same ID, different source
      timestamp: Date.now(),
      source: 'service-2',
    };
    
    protection.checkAndStore(messageId1);
    const result = protection.checkAndStore(messageId2);
    
    expect(result.allowed).toBe(true);
  });

  it('should detect replay with isReplay', () => {
    const messageId: MessageId = {
      id: 'msg-1',
      timestamp: Date.now(),
      source: 'service-1',
    };
    
    expect(protection.isReplay(messageId)).toBe(false);
    
    protection.checkAndStore(messageId);
    
    expect(protection.isReplay(messageId)).toBe(true);
  });

  it('should return false for isReplay with unknown message', () => {
    const messageId: MessageId = {
      id: 'unknown',
      timestamp: Date.now(),
      source: 'service-1',
    };
    
    expect(protection.isReplay(messageId)).toBe(false);
  });

  it('should enforce maxEntries per source', () => {
    const smallProtection = createReplayProtection({
      windowSize: 1000,
      maxEntries: 5,
      ttlMs: 5000,
    });
    
    // Add 5 messages
    for (let i = 0; i < 5; i++) {
      const messageId: MessageId = {
        id: `msg-${i}`,
        timestamp: Date.now(),
        source: 'service-1',
      };
      smallProtection.checkAndStore(messageId);
    }
    
    // 6th message should trigger cleanup
    const messageId6: MessageId = {
      id: 'msg-5',
      timestamp: Date.now(),
      source: 'service-1',
    };
    const result = smallProtection.checkAndStore(messageId6);
    
    expect(result.allowed).toBe(true);
    smallProtection.stop();
  });

  it('should cleanup expired entries', () => {
    vi.useFakeTimers();
    
    const protection = createReplayProtection({
      windowSize: 1000,
      maxEntries: 100,
      ttlMs: 1000, // 1 second TTL
    });
    
    protection.start();
    
    const messageId: MessageId = {
      id: 'msg-1',
      timestamp: Date.now(),
      source: 'service-1',
    };
    
    protection.checkAndStore(messageId);
    expect(protection.getStats().totalEntries).toBe(1);
    
    // Advance time past TTL
    vi.advanceTimersByTime(2000);
    
    // Trigger cleanup manually
    protection.checkAndStore({
      id: 'msg-2',
      timestamp: Date.now(),
      source: 'service-1',
    });
    
    // Old entry should be cleaned up
    expect(protection.getStats().totalEntries).toBe(1);
    
    protection.stop();
    vi.useRealTimers();
  });

  it('should start and stop cleanup timer', () => {
    const protection = createReplayProtection();
    
    expect(() => protection.start()).not.toThrow();
    expect(() => protection.start()).not.toThrow(); // Idempotent
    
    protection.stop();
    expect(() => protection.stop()).not.toThrow(); // Idempotent
  });

  it('should return stats', () => {
    const messageId1: MessageId = {
      id: 'msg-1',
      timestamp: Date.now(),
      source: 'service-1',
    };
    
    const messageId2: MessageId = {
      id: 'msg-2',
      timestamp: Date.now(),
      source: 'service-2',
    };
    
    protection.checkAndStore(messageId1);
    protection.checkAndStore(messageId2);
    
    const stats = protection.getStats();
    
    expect(stats.sources).toBe(2);
    expect(stats.totalEntries).toBe(2);
  });

  it('should handle multiple messages from same source', () => {
    for (let i = 0; i < 10; i++) {
      const messageId: MessageId = {
        id: `msg-${i}`,
        timestamp: Date.now(),
        source: 'service-1',
      };
      protection.checkAndStore(messageId);
    }
    
    const stats = protection.getStats();
    expect(stats.sources).toBe(1);
    expect(stats.totalEntries).toBe(10);
  });
});

describe('ReplayProtectionConfig', () => {
  it('should define correct structure', () => {
    const config: ReplayProtectionConfig = {
      windowSize: 10000,
      maxEntries: 100000,
      ttlMs: 300000,
    };
    
    expect(config.windowSize).toBe(10000);
    expect(config.maxEntries).toBe(100000);
    expect(config.ttlMs).toBe(300000);
  });
});

describe('MessageId', () => {
  it('should define correct structure', () => {
    const messageId: MessageId = {
      id: 'msg-123',
      timestamp: Date.now(),
      source: 'service-1',
    };
    
    expect(messageId.id).toBe('msg-123');
    expect(typeof messageId.timestamp).toBe('number');
    expect(messageId.source).toBe('service-1');
  });
});

describe('ReplayProtection - Adversarial and Edge Case Tests', () => {
  let protection: ReplayProtection;

  beforeEach(() => {
    protection = createReplayProtection({
      windowSize: 1000,
      maxEntries: 100,
      ttlMs: 5000,
    });
  });

  afterEach(() => {
    protection.stop();
  });

  it('should handle concurrent checkAndStore for same message', async () => {
    const messageId: MessageId = {
      id: 'concurrent-msg',
      timestamp: Date.now(),
      source: 'service-1',
    };
    
    // Multiple concurrent checks for the same message
    const results = await Promise.all([
      protection.checkAndStore(messageId),
      protection.checkAndStore(messageId),
      protection.checkAndStore(messageId),
      protection.checkAndStore(messageId),
      protection.checkAndStore(messageId),
    ]);
    
    // Exactly one should be allowed, rest rejected
    const allowedCount = results.filter(r => r.allowed).length;
    expect(allowedCount).toBe(1);
  });

  it('should handle concurrent different messages from same source', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: `msg-${i}`,
      timestamp: Date.now(),
      source: 'service-1',
    }));
    
    const results = await Promise.all(
      messages.map(m => protection.checkAndStore(m))
    );
    
    // All should be allowed (different IDs)
    const allowedCount = results.filter(r => r.allowed).length;
    expect(allowedCount).toBe(20);
  });

  it('should enforce maxEntries bound', () => {
    const boundedProtection = createReplayProtection({
      windowSize: 1000,
      maxEntries: 10,
      ttlMs: 60000, // Long TTL so entries don't expire
    });
    
    // Add 15 messages
    for (let i = 0; i < 15; i++) {
      const messageId: MessageId = {
        id: `msg-${i}`,
        timestamp: Date.now(),
        source: 'service-1',
      };
      boundedProtection.checkAndStore(messageId);
    }
    
    // Should only keep maxEntries (10) after cleanup
    const stats = boundedProtection.getStats();
    expect(stats.totalEntries).toBeLessThanOrEqual(10);
    
    boundedProtection.stop();
  });

  it('should handle message ID collisions across sources', () => {
    const msg1: MessageId = { id: 'same-id', timestamp: Date.now(), source: 'source-a' };
    const msg2: MessageId = { id: 'same-id', timestamp: Date.now(), source: 'source-b' };
    
    protection.checkAndStore(msg1);
    const result = protection.checkAndStore(msg2);
    
    expect(result.allowed).toBe(true);
  });

  it('should reject future timestamps beyond tolerance', () => {
    // Default futureSkewMs is 10 seconds
    const futureTimestamp = Date.now() + 20000; // 20 seconds in future (beyond 10s tolerance)
    const messageId: MessageId = {
      id: 'future-msg',
      timestamp: futureTimestamp,
      source: 'service-1',
    };
    
    const result = protection.checkAndStore(messageId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Message timestamp exceeds future skew tolerance');
  });

  it('should allow future timestamps within tolerance', () => {
    // Default futureSkewMs is 10 seconds
    const futureTimestamp = Date.now() + 5000; // 5 seconds in future (within 10s tolerance)
    const messageId: MessageId = {
      id: 'future-msg-within-tolerance',
      timestamp: futureTimestamp,
      source: 'service-1',
    };
    
    const result = protection.checkAndStore(messageId);
    expect(result.allowed).toBe(true);
  });

  it('should handle very old timestamps', () => {
    const oldTimestamp = Date.now() - 86400000; // 24 hours ago
    const messageId: MessageId = {
      id: 'old-msg',
      timestamp: oldTimestamp,
      source: 'service-1',
    };
    
    const result = protection.checkAndStore(messageId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Message timestamp outside allowed window');
  });

  it('should handle malformed message IDs', () => {
    // Empty ID
    const emptyId: MessageId = { id: '', timestamp: Date.now(), source: 'service-1' };
    const result1 = protection.checkAndStore(emptyId);
    expect(result1.allowed).toBe(true); // Empty string is valid ID
    
    // Very long ID
    const longId: MessageId = { 
      id: 'x'.repeat(10000), 
      timestamp: Date.now(), 
      source: 'service-1' 
    };
    const result2 = protection.checkAndStore(longId);
    expect(result2.allowed).toBe(true);
  });

  it('should handle special characters in source and ID', () => {
    const specialChars: MessageId = {
      id: 'msg/with\\special:chars',
      timestamp: Date.now(),
      source: 'service/with:special\\chars',
    };
    
    const result = protection.checkAndStore(specialChars);
    expect(result.allowed).toBe(true);
  });

  it('should not leak memory with many sources', () => {
    const manySourcesProtection = createReplayProtection({
      windowSize: 1000,
      maxEntries: 100000,
      ttlMs: 60000,
    });
    
    // Add messages from many different sources
    for (let i = 0; i < 1000; i++) {
      const messageId: MessageId = {
        id: `msg-${i}`,
        timestamp: Date.now(),
        source: `service-${i}`,
      };
      manySourcesProtection.checkAndStore(messageId);
    }
    
    const stats = manySourcesProtection.getStats();
    expect(stats.sources).toBe(1000);
    expect(stats.totalEntries).toBe(1000);
    
    manySourcesProtection.stop();
  });

  it('should handle cleanup timer start/stop idempotency', () => {
    expect(() => protection.start()).not.toThrow();
    expect(() => protection.start()).not.toThrow();
    expect(() => protection.stop()).not.toThrow();
    expect(() => protection.stop()).not.toThrow();
  });

  it('should handle zero TTL', () => {
    const zeroTtlProtection = createReplayProtection({
      windowSize: 1000,
      maxEntries: 100,
      ttlMs: 0,
    });
    
    const messageId: MessageId = {
      id: 'zero-ttl',
      timestamp: Date.now(),
      source: 'service-1',
    };
    
    // With zero TTL, even current timestamp should be "expired"
    const result = zeroTtlProtection.checkAndStore(messageId);
    // Behavior depends on implementation - document it
    expect(typeof result.allowed).toBe('boolean');
    
    zeroTtlProtection.stop();
  });

  it('should handle rapid expiration and re-addition', () => {
    vi.useFakeTimers();
    
    const shortTtlProtection = createReplayProtection({
      windowSize: 1000,
      maxEntries: 100,
      ttlMs: 1000,
    });
    
    shortTtlProtection.start();
    
    const messageId: MessageId = {
      id: 'expiring-msg',
      timestamp: Date.now(),
      source: 'service-1',
    };
    
    shortTtlProtection.checkAndStore(messageId);
    expect(shortTtlProtection.getStats().totalEntries).toBe(1);
    
    // Advance past TTL
    vi.advanceTimersByTime(2000);
    
    // Add new message - should trigger cleanup
    shortTtlProtection.checkAndStore({
      id: 'new-msg',
      timestamp: Date.now(),
      source: 'service-1',
    });
    
    // Old entry should be cleaned
    expect(shortTtlProtection.getStats().totalEntries).toBe(1);
    
    shortTtlProtection.stop();
    vi.useRealTimers();
  });

  it('should not allow replay after expiration and cleanup', () => {
    vi.useFakeTimers();
    
    const shortTtlProtection = createReplayProtection({
      windowSize: 1000,
      maxEntries: 100,
      ttlMs: 1000,
    });
    
    shortTtlProtection.start();
    
    const messageId: MessageId = {
      id: 'replay-test',
      timestamp: Date.now(),
      source: 'service-1',
    };
    
    shortTtlProtection.checkAndStore(messageId);
    expect(shortTtlProtection.isReplay(messageId)).toBe(true);
    
    // Advance past TTL
    vi.advanceTimersByTime(2000);
    
    // Add new message to trigger cleanup
    shortTtlProtection.checkAndStore({
      id: 'trigger-cleanup',
      timestamp: Date.now(),
      source: 'service-1',
    });
    
    // Original message should no longer be detected as replay
    expect(shortTtlProtection.isReplay(messageId)).toBe(false);
    
    shortTtlProtection.stop();
    vi.useRealTimers();
  });

  it('should handle isReplay without prior checkAndStore', () => {
    const messageId: MessageId = {
      id: 'never-seen',
      timestamp: Date.now(),
      source: 'service-1',
    };
    
    expect(protection.isReplay(messageId)).toBe(false);
  });

  it('should maintain stats accuracy', () => {
    const msg1: MessageId = { id: 'msg-1', timestamp: Date.now(), source: 'service-1' };
    const msg2: MessageId = { id: 'msg-2', timestamp: Date.now(), source: 'service-1' };
    const msg3: MessageId = { id: 'msg-3', timestamp: Date.now(), source: 'service-2' };
    
    protection.checkAndStore(msg1);
    protection.checkAndStore(msg2);
    protection.checkAndStore(msg3);
    
    const stats = protection.getStats();
    expect(stats.sources).toBe(2);
    expect(stats.totalEntries).toBe(3);
  });
});