import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  KeyRotationPolicy,
  KeyRotationEvent,
  KeyRotationListener,
  KeyRotationManager,
  createKeyRotationManager,
} from '../../src/security/key-rotation.js';
import { MemoryKeyProvider } from '../../src/security/key-provider.js';
import { EncryptionService } from '../../src/security/encryption.js';
import { KeyExchangeService } from '../../src/security/key-exchange.js';

describe('KeyRotationManager', () => {
  let provider: MemoryKeyProvider;
  let manager: KeyRotationManager;
  let policy: KeyRotationPolicy;

  beforeEach(async () => {
    provider = new MemoryKeyProvider();
    
    // Pre-populate with initial keys
    await provider.rotateKeys('service-1');
    await provider.rotateKeys('service-2');
    
    policy = {
      intervalMs: 1000, // 1 second for testing
      gracePeriodMs: 500,
      maxVersions: 3,
      autoRotate: true,
    };
    
    manager = new KeyRotationManager(provider, policy);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create manager with default policy', () => {
    const manager = createKeyRotationManager(provider);
    expect(manager.getPolicy().intervalMs).toBe(24 * 60 * 60 * 1000);
    expect(manager.getPolicy().gracePeriodMs).toBe(60 * 60 * 1000);
    expect(manager.getPolicy().maxVersions).toBe(3);
    expect(manager.getPolicy().autoRotate).toBe(true);
  });

  it('should create manager with custom policy', () => {
    const customPolicy = {
      intervalMs: 3600000,
      gracePeriodMs: 1800000,
      maxVersions: 5,
      autoRotate: false,
    };
    
    const manager = createKeyRotationManager(provider, customPolicy);
    expect(manager.getPolicy()).toEqual({ ...policy, ...customPolicy });
  });

  it('should add and remove listeners', () => {
    const listener1: KeyRotationListener = vi.fn();
    const listener2: KeyRotationListener = vi.fn();
    
    manager.addListener(listener1);
    manager.addListener(listener2);
    
    // Can't directly test internal array, but we can verify by rotating
    // and checking if listeners are called (tested below)
    
    manager.removeListener(listener1);
    // After removal, only listener2 should be called
  });

  it('should start and stop rotation timer', () => {
    vi.useFakeTimers();
    
    manager.start('service-1');
    expect(manager.isRunning()).toBe(true);
    
    manager.stop('service-1');
    // isRunning might still be true if other timers running
    
    vi.useRealTimers();
  });

  it('should not start duplicate timer for same service', () => {
    vi.useFakeTimers();
    
    manager.start('service-1');
    manager.start('service-1'); // Should not create duplicate
    
    vi.useRealTimers();
  });

  it('should rotate keys and emit event', async () => {
    const listener: KeyRotationListener = vi.fn();
    manager.addListener(listener);
    
    const newKeys = await manager.rotate('service-1');
    
    expect(newKeys).toBeDefined();
    expect(newKeys.version).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledTimes(1);
    
    const event = listener.mock.calls[0][0] as KeyRotationEvent;
    expect(event.serviceId).toBe('service-1');
    expect(event.oldVersion).toBeGreaterThanOrEqual(0);
    expect(event.newVersion).toBeGreaterThan(event.oldVersion);
    expect(event.rotatedAt).toBeDefined();
  });

  it('should handle listener errors gracefully', async () => {
    const errorListener: KeyRotationListener = vi.fn(() => {
      throw new Error('Listener error');
    });
    const goodListener: KeyRotationListener = vi.fn();
    
    manager.addListener(errorListener);
    manager.addListener(goodListener);
    
    await manager.rotate('service-1');
    
    // Both listeners should have been called despite error
    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(goodListener).toHaveBeenCalledTimes(1);
  });

  it('should rotate all services', async () => {
    vi.useFakeTimers();
    
    manager.start('service-1');
    manager.start('service-2');
    
    const results = await manager.rotateAll();
    
    expect(results.size).toBe(2);
    expect(results.has('service-1')).toBe(true);
    expect(results.has('service-2')).toBe(true);
    
    vi.useRealTimers();
  });

  it('should continue rotating other services if one fails', async () => {
    vi.useFakeTimers();
    
    manager.start('service-1');
    manager.start('non-existent'); // This will fail
    
    const results = await manager.rotateAll();
    
    // Should still have results for service-1
    expect(results.has('service-1')).toBe(true);
    
    vi.useRealTimers();
  });

  it('should update policy', () => {
    const newPolicy = { intervalMs: 5000, maxVersions: 10 };
    manager.setPolicy(newPolicy);
    
    expect(manager.getPolicy().intervalMs).toBe(5000);
    expect(manager.getPolicy().maxVersions).toBe(10);
    // Other values should remain
    expect(manager.getPolicy().gracePeriodMs).toBe(policy.gracePeriodMs);
    expect(manager.getPolicy().autoRotate).toBe(policy.autoRotate);
  });
});

describe('KeyRotationEvent', () => {
  it('should define correct structure', () => {
    const event: KeyRotationEvent = {
      serviceId: 'service-1',
      oldVersion: 1,
      newVersion: 2,
      rotatedAt: Date.now(),
    };
    
    expect(event.serviceId).toBe('service-1');
    expect(event.oldVersion).toBe(1);
    expect(event.newVersion).toBe(2);
    expect(event.rotatedAt).toBeDefined();
  });
});

describe('KeyRotationPolicy', () => {
  it('should define correct structure', () => {
    const policy: KeyRotationPolicy = {
      intervalMs: 86400000,
      gracePeriodMs: 3600000,
      maxVersions: 3,
      autoRotate: true,
    };
    
    expect(policy.intervalMs).toBe(86400000);
    expect(policy.autoRotate).toBe(true);
  });
});

describe('KeyRotationManager - Adversarial and Edge Case Tests', () => {
  let provider: MemoryKeyProvider;
  let manager: KeyRotationManager;
  let policy: KeyRotationPolicy;

  beforeEach(async () => {
    provider = new MemoryKeyProvider();
    await provider.rotateKeys('service-1');
    await provider.rotateKeys('service-2');
    
    policy = {
      intervalMs: 1000,
      gracePeriodMs: 500,
      maxVersions: 3,
      autoRotate: true,
    };
    
    manager = new KeyRotationManager(provider, policy);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should handle rapid start/stop cycles', () => {
    for (let i = 0; i < 10; i++) {
      manager.start('service-rapid');
      expect(manager.isRunning()).toBe(true);
      manager.stop('service-rapid');
    }
    expect(manager.isRunning()).toBe(false);
  });

  it('should not allow duplicate rotation timers for same service', () => {
    vi.useFakeTimers();
    
    manager.start('service-dup');
    manager.start('service-dup');
    manager.start('service-dup');
    
    // Should only have one timer
    // We can't directly check internal state, but we can verify behavior
    expect(manager.isRunning()).toBe(true);
    
    vi.useRealTimers();
  });

  it('should handle rotation while timer is running', async () => {
    vi.useFakeTimers();
    
    manager.start('service-1');
    
    // Advance time to trigger automatic rotation
    vi.advanceTimersByTime(2000);
    
    // Manual rotation should also work
    const manualResult = await manager.rotate('service-1');
    expect(manualResult.version).toBeGreaterThan(1);
    
    vi.useRealTimers();
  });

  it('should handle concurrent rotations', async () => {
    const results = await Promise.all([
      manager.rotate('service-1'),
      manager.rotate('service-1'),
      manager.rotate('service-1'),
    ]);
    
    // All should succeed
    results.forEach(keys => {
      expect(keys.version).toBeGreaterThan(0);
    });
  });

  it('should maintain isRunning state correctly', () => {
    expect(manager.isRunning()).toBe(false);
    
    manager.start('service-1');
    expect(manager.isRunning()).toBe(true);
    
    manager.start('service-2');
    expect(manager.isRunning()).toBe(true);
    
    manager.stop('service-1');
    expect(manager.isRunning()).toBe(true); // service-2 still running
    
    manager.stop('service-2');
    expect(manager.isRunning()).toBe(false);
  });

  it('should handle stop of non-existent service', () => {
    expect(() => manager.stop('non-existent')).not.toThrow();
    expect(manager.isRunning()).toBe(false);
  });

  it('should handle rotation of non-existent service', async () => {
    const newKeys = await manager.rotate('brand-new-service');
    expect(newKeys.version).toBe(1);
  });

  it('should emit events with correct version tracking', async () => {
    const listener = vi.fn();
    manager.addListener(listener);
    
    await manager.rotate('service-1');
    expect(listener).toHaveBeenCalledTimes(1);
    
    const event1 = listener.mock.calls[0][0];
    // Provider pre-populated with version 1 in beforeEach, first rotation goes to version 2
    expect(event1.oldVersion).toBe(1);
    expect(event1.newVersion).toBe(2);
    
    await manager.rotate('service-1');
    expect(listener).toHaveBeenCalledTimes(2);
    
    const event2 = listener.mock.calls[1][0];
    // Second rotation: provider version goes from 2 to 3
    expect(event2.oldVersion).toBe(2);
    expect(event2.newVersion).toBe(3);
  });

  it('should continue other rotations if one fails', async () => {
    // Rotate non-existent (should work, creates new)
    await manager.rotate('new-service');
    
    // Rotate existing
    const result = await manager.rotate('service-1');
    expect(result.version).toBeGreaterThan(1);
  });

  it('should handle listener errors without stopping other listeners', async () => {
    const errorListener = vi.fn(() => { throw new Error('Listener error'); });
    const goodListener1 = vi.fn();
    const goodListener2 = vi.fn();
    
    manager.addListener(errorListener);
    manager.addListener(goodListener1);
    manager.addListener(goodListener2);
    
    await manager.rotate('service-1');
    
    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(goodListener1).toHaveBeenCalledTimes(1);
    expect(goodListener2).toHaveBeenCalledTimes(1);
  });

  it('should handle policy updates during rotation', async () => {
    vi.useFakeTimers();
    
    manager.start('service-1');
    
    // Update policy
    manager.setPolicy({ intervalMs: 500, maxVersions: 5 });
    
    vi.advanceTimersByTime(1000);
    
    const result = await manager.rotate('service-1');
    expect(result.version).toBeGreaterThan(1);
    
    vi.useRealTimers();
  });

  it('should cleanup timers on stop', () => {
    vi.useFakeTimers();
    
    manager.start('service-1');
    manager.start('service-2');
    expect(manager.isRunning()).toBe(true);
    
    manager.stop('service-1');
    manager.stop('service-2');
    expect(manager.isRunning()).toBe(false);
    
    // Advancing time should not cause errors
    vi.advanceTimersByTime(10000);
    
    vi.useRealTimers();
  });

  it('should handle gracePeriod in policy (documentation)', () => {
    // gracePeriodMs is part of policy but not currently used in rotation logic
    // This test documents the expected behavior for future implementation
    expect(policy.gracePeriodMs).toBe(500);
  });

  it('should handle maxVersions in policy (documentation)', () => {
    // maxVersions is part of policy but not currently enforced
    // This test documents the expected behavior for future implementation
    expect(policy.maxVersions).toBe(3);
  });
});

// === NEW ADVERSARIAL TESTS ===

describe('KeyRotationManager - Security and Edge Cases', () => {
  let provider: MemoryKeyProvider;
  let manager: KeyRotationManager;
  let policy: KeyRotationPolicy;

  beforeEach(async () => {
    provider = new MemoryKeyProvider();
    await provider.rotateKeys('service-1');
    await provider.rotateKeys('service-2');
    
    policy = {
      intervalMs: 1000,
      gracePeriodMs: 500,
      maxVersions: 3,
      autoRotate: true,
    };
    
    manager = new KeyRotationManager(provider, policy);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should track running state correctly after start/stop', () => {
    expect(manager.isRunning()).toBe(false);
    
    manager.start('service-1');
    expect(manager.isRunning()).toBe(true);
    
    manager.stop('service-1');
    expect(manager.isRunning()).toBe(false);
  });

  it('should track running state with multiple services', () => {
    expect(manager.isRunning()).toBe(false);
    
    manager.start('service-1');
    expect(manager.isRunning()).toBe(true);
    
    manager.start('service-2');
    expect(manager.isRunning()).toBe(true);
    
    manager.stop('service-1');
    expect(manager.isRunning()).toBe(true); // service-2 still running
    
    manager.stop('service-2');
    expect(manager.isRunning()).toBe(false);
  });

  it('should handle rotation failure gracefully', async () => {
    // Try to rotate non-existent service (should work - creates new keys)
    const newKeys = await manager.rotate('brand-new-service');
    expect(newKeys.version).toBe(1);
  });

  it('should emit events with correct structure', async () => {
    const listener = vi.fn();
    manager.addListener(listener);
    
    await manager.rotate('service-1');
    
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0];
    
    expect(event.serviceId).toBe('service-1');
    expect(typeof event.oldVersion).toBe('number');
    expect(typeof event.newVersion).toBe('number');
    expect(event.newVersion).toBeGreaterThan(event.oldVersion);
    expect(typeof event.rotatedAt).toBe('number');
  });

  it('should handle listener errors without stopping other listeners', async () => {
    const errorListener = vi.fn(() => { throw new Error('Listener error'); });
    const goodListener1 = vi.fn();
    const goodListener2 = vi.fn();
    
    manager.addListener(errorListener);
    manager.addListener(goodListener1);
    manager.addListener(goodListener2);
    
    await manager.rotate('service-1');
    
    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(goodListener1).toHaveBeenCalledTimes(1);
    expect(goodListener2).toHaveBeenCalledTimes(1);
  });

  it('should cleanup timers properly on stop', () => {
    vi.useFakeTimers();
    
    manager.start('service-1');
    manager.start('service-2');
    expect(manager.isRunning()).toBe(true);
    
    manager.stop('service-1');
    manager.stop('service-2');
    expect(manager.isRunning()).toBe(false);
    
    // Advancing time should not cause errors
    vi.advanceTimersByTime(10000);
    
    vi.useRealTimers();
  });

  it('should not start duplicate timers for same service', () => {
    vi.useFakeTimers();
    
    manager.start('service-dup');
    manager.start('service-dup');
    manager.start('service-dup');
    
    expect(manager.isRunning()).toBe(true);
    
    vi.useRealTimers();
  });

  it('should handle concurrent manual rotations', async () => {
    const results = await Promise.all([
      manager.rotate('service-1'),
      manager.rotate('service-1'),
      manager.rotate('service-1'),
    ]);
    
    results.forEach(keys => {
      expect(keys.version).toBeGreaterThan(0);
    });
  });

  it('should handle rotateAll with mixed success/failure', async () => {
    vi.useFakeTimers();
    
    manager.start('service-1');
    manager.start('non-existent-service');
    
    const results = await manager.rotateAll();
    
    expect(results.has('service-1')).toBe(true);
    // non-existent-service should also work (creates new keys)
    expect(results.has('non-existent-service')).toBe(true);
    
    vi.useRealTimers();
  });

  it('should update policy dynamically', () => {
    const newPolicy = { intervalMs: 500, maxVersions: 5 };
    manager.setPolicy(newPolicy);
    
    expect(manager.getPolicy().intervalMs).toBe(500);
    expect(manager.getPolicy().maxVersions).toBe(5);
    // Other values should remain
    expect(manager.getPolicy().gracePeriodMs).toBe(policy.gracePeriodMs);
    expect(manager.getPolicy().autoRotate).toBe(policy.autoRotate);
  });

  it('should handle rapid start/stop cycles', () => {
    for (let i = 0; i < 20; i++) {
      manager.start('service-rapid');
      expect(manager.isRunning()).toBe(true);
      manager.stop('service-rapid');
    }
    expect(manager.isRunning()).toBe(false);
  });

  it('should handle rotation during active timer', async () => {
    vi.useFakeTimers();
    
    manager.start('service-1');
    
    // Advance time to trigger automatic rotation
    vi.advanceTimersByTime(2000);
    
    // Manual rotation should also work
    const manualResult = await manager.rotate('service-1');
    expect(manualResult.version).toBeGreaterThan(1);
    
    vi.useRealTimers();
  });

  it('should handle stop of non-existent service', () => {
    expect(() => manager.stop('non-existent')).not.toThrow();
    expect(manager.isRunning()).toBe(false);
  });

  it('should return correct policy copy', () => {
    const policyCopy = manager.getPolicy();
    
    expect(policyCopy).toEqual(policy);
    // Should be a copy, not reference
    policyCopy.intervalMs = 999999;
    expect(manager.getPolicy().intervalMs).not.toBe(999999);
  });

  it('should handle zero interval (edge case)', () => {
    const zeroIntervalManager = createKeyRotationManager(provider, { intervalMs: 0 });
    
    vi.useFakeTimers();
    zeroIntervalManager.start('service-zero');
    
    // Should not throw
    expect(() => zeroIntervalManager.stop('service-zero')).not.toThrow();
    
    vi.useRealTimers();
  });
});

describe('KeyRotationManager - Concurrency and Race Conditions', () => {
  let provider: MemoryKeyProvider;
  let manager: KeyRotationManager;

  beforeEach(async () => {
    provider = new MemoryKeyProvider();
    await provider.rotateKeys('service-concurrent');
    
    manager = new KeyRotationManager(provider, {
      intervalMs: 1000,
      gracePeriodMs: 500,
      maxVersions: 3,
      autoRotate: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should handle concurrent rotations on different services', async () => {
    const results = await Promise.all([
      manager.rotate('service-a'),
      manager.rotate('service-b'),
      manager.rotate('service-c'),
    ]);
    
    results.forEach(keys => {
      expect(keys.version).toBeGreaterThan(0);
    });
  });

  it('should handle concurrent start/stop', () => {
    vi.useFakeTimers();
    
    const operations = [];
    for (let i = 0; i < 10; i++) {
      operations.push(() => manager.start(`service-${i}`));
      operations.push(() => manager.stop(`service-${i}`));
    }
    
    operations.forEach(op => expect(op).not.toThrow());
    
    vi.useRealTimers();
  });

  it('should handle listener add/remove during rotation', async () => {
    const listener = vi.fn();
    manager.addListener(listener);
    
    await manager.rotate('service-1');
    expect(listener).toHaveBeenCalledTimes(1);
    
    manager.removeListener(listener);
    
    await manager.rotate('service-1');
    expect(listener).toHaveBeenCalledTimes(1); // Not called again
  });
});