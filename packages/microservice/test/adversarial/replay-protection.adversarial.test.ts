import { describe, it, expect, vi } from 'vitest';
import { ReplayProtection } from '../../src/security/replay-protection.js';

describe('Replay Protection - Adversarial Tests', () => {
  it('should reject replayed message', () => {
    const rp = new ReplayProtection();
    const now = Date.now();
    const res1 = rp.checkAndStore({ id: 'msg1', source: 'src1', timestamp: now });
    expect(res1.allowed).toBe(true);
    const res2 = rp.checkAndStore({ id: 'msg1', source: 'src1', timestamp: now });
    expect(res2.allowed).toBe(false);
  });

  it('should reject message with future timestamp beyond tolerance', () => {
    const rp = new ReplayProtection({ futureSkewMs: 1000 });
    const now = Date.now();
    const res = rp.checkAndStore({ id: 'msg1', source: 'src1', timestamp: now + 2000 });
    expect(res.allowed).toBe(false);
  });

  it('should allow message with future timestamp within tolerance', () => {
    const rp = new ReplayProtection({ futureSkewMs: 5000 });
    const now = Date.now();
    const res = rp.checkAndStore({ id: 'msg1', source: 'src1', timestamp: now + 2000 });
    expect(res.allowed).toBe(true);
  });

  it('should reject expired message', () => {
    const rp = new ReplayProtection({ ttlMs: 100 });
    const now = Date.now();
    const res = rp.checkAndStore({ id: 'msg1', source: 'src1', timestamp: now - 200 });
    expect(res.allowed).toBe(false);
  });

  it('should handle cleanup', () => {
    const rp = new ReplayProtection({ ttlMs: 10, cleanupIntervalMs: 100 });
    rp.checkAndStore({ id: 'msg1', source: 'src1', timestamp: Date.now() - 200 });
    expect(() => rp.cleanup()).not.toThrow();
  });
});
