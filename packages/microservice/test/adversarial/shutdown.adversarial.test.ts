import { describe, it, expect } from 'vitest';
import { ShutdownManager } from '../../src/internal/shutdown.js';

describe('Shutdown - Adversarial Tests', () => {
  it('should handle multiple shutdown hooks', async () => {
    const shutdown = new ShutdownManager();
    const order: number[] = [];
    shutdown.registerHook({ name: 'h1', priority: 1, handler: async () => { order.push(1); } });
    shutdown.registerHook({ name: 'h2', priority: 2, handler: async () => { order.push(2); } });
    shutdown.registerHook({ name: 'h3', priority: 3, handler: async () => { order.push(3); } });
    await shutdown.shutdown();
    expect(order).toEqual([3, 2, 1]);
  });

  it('should collect errors from handlers but continue', async () => {
    const shutdown = new ShutdownManager();
    shutdown.registerHook({ name: 'good', priority: 1, handler: async () => {} });
    shutdown.registerHook({ name: 'bad1', priority: 1, handler: async () => { throw new Error('bad1'); } });
    shutdown.registerHook({ name: 'bad2', priority: 1, handler: async () => { throw new Error('bad2'); } });
    await shutdown.shutdown();
  });

  it('should not run hooks twice', async () => {
    const shutdown = new ShutdownManager();
    let count = 0;
    shutdown.registerHook({ name: 'h', priority: 1, handler: async () => { count++; } });
    await shutdown.shutdown();
    await shutdown.shutdown();
    expect(count).toBe(1);
  });

  it('should unregister hooks', async () => {
    const shutdown = new ShutdownManager();
    let count = 0;
    shutdown.registerHook({ name: 'h', priority: 1, handler: async () => { count++; } });
    shutdown.unregisterHook('h');
    await shutdown.shutdown();
    expect(count).toBe(0);
  });
});
