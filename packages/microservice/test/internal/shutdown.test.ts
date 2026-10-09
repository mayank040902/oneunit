import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShutdownManager, createShutdownManager, gracefulShutdown } from '../../src/internal/shutdown.js';
import { ShutdownHook } from '../../src/internal/shutdown.js';

describe('ShutdownManager', () => {
  let manager: ShutdownManager;

  beforeEach(() => {
    manager = new ShutdownManager({ timeoutMs: 1000, signals: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should default timeoutMs to 30000', () => {
    const m = new ShutdownManager({ signals: [] });
    expect((m as any).options.timeoutMs).toBe(30000);
  });

  it('should default signals to SIGTERM, SIGINT, SIGUSR2', () => {
    const m = new ShutdownManager();
    expect((m as any).options.signals).toEqual(['SIGTERM', 'SIGINT', 'SIGUSR2']);
  });

  it('should start not shutting down and not completed', () => {
    expect(manager.isShuttingDown()).toBe(false);
    expect(manager.isCompleted()).toBe(false);
  });

  it('should register a hook', () => {
    const hook: ShutdownHook = {
      name: 'cleanup',
      priority: 10,
      handler: vi.fn().mockResolvedValue(undefined),
    };
    manager.registerHook(hook);
    expect((manager as any).hooks).toContain(hook);
  });

  it('should sort hooks by priority descending', () => {
    manager.registerHook({ name: 'low', priority: 1, handler: vi.fn() });
    manager.registerHook({ name: 'high', priority: 10, handler: vi.fn() });
    const hooks = (manager as any).hooks as ShutdownHook[];
    expect(hooks[0].name).toBe('high');
    expect(hooks[1].name).toBe('low');
  });

  it('should unregister a hook by name', () => {
    manager.registerHook({ name: 'a', priority: 1, handler: vi.fn() });
    expect(manager.unregisterHook('a')).toBe(true);
    expect((manager as any).hooks).toEqual([]);
  });

  it('should return false when unregistering an unknown hook', () => {
    expect(manager.unregisterHook('missing')).toBe(false);
  });

  it('should emit shutdown:started on shutdown', async () => {
    const started = vi.fn();
    manager.on('shutdown:started', started);
    await manager.shutdown('test');
    expect(started).toHaveBeenCalledWith('test');
  });

  it('should emit shutdown:completed on successful shutdown', async () => {
    const completed = vi.fn();
    manager.on('shutdown:completed', completed);
    await manager.shutdown();
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('should run registered hooks during shutdown', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    manager.registerHook({ name: 'h', priority: 1, handler });
    await manager.shutdown();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should emit hook:start and hook:complete for each hook', async () => {
    const start = vi.fn();
    const complete = vi.fn();
    manager.on('hook:start', start);
    manager.on('hook:complete', complete);
    manager.registerHook({ name: 'h', priority: 1, handler: vi.fn().mockResolvedValue(undefined) });
    await manager.shutdown();
    expect(start).toHaveBeenCalledWith('h');
    expect(complete).toHaveBeenCalledWith('h');
  });

  it('should continue running other hooks when one fails', async () => {
    const error = vi.fn();
    manager.on('hook:error', error);
    manager.registerHook({
      name: 'bad',
      priority: 1,
      handler: vi.fn().mockRejectedValue(new Error('boom')),
    });
    manager.registerHook({
      name: 'good',
      priority: 1,
      handler: vi.fn().mockResolvedValue(undefined),
    });
    // A failing hook must not abort the shutdown sequence.
    await manager.shutdown();
    expect(error).toHaveBeenCalledWith('bad', expect.any(Error));
  });

  it('should be idempotent across repeated shutdown calls', async () => {
    await manager.shutdown();
    const completed = vi.fn();
    manager.on('shutdown:completed', completed);
    await manager.shutdown();
    expect(completed).not.toHaveBeenCalled();
  });

  it('should mark completed after shutdown', async () => {
    await manager.shutdown();
    expect(manager.isCompleted()).toBe(true);
    expect(manager.isShuttingDown()).toBe(false);
  });

  it('should throw and emit shutdown:error on timeout', async () => {
    vi.useFakeTimers();
    manager = new ShutdownManager({ timeoutMs: 100, signals: [] });
    const error = vi.fn();
    manager.on('shutdown:error', error);
    manager.registerHook({
      name: 'slow',
      priority: 1,
      handler: () => new Promise(() => {}), // never resolves
    });

    const promise = manager.shutdown();
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).rejects.toThrow(/Shutdown timeout/);
    expect(error).toHaveBeenCalled();
  });
});

describe('createShutdownManager', () => {
  it('should create a ShutdownManager', () => {
    const manager = createShutdownManager({ timeoutMs: 5000, signals: [] });
    expect(manager).toBeInstanceOf(ShutdownManager);
    expect((manager as any).options.timeoutMs).toBe(5000);
  });
});

describe('gracefulShutdown', () => {
  it('should stop services in order', async () => {
    const order: string[] = [];
    await gracefulShutdown([
      { name: 'a', stop: vi.fn(async () => { order.push('a'); }) },
      { name: 'b', stop: vi.fn(async () => { order.push('b'); }) },
    ]);
    expect(order).toEqual(['a', 'b']);
  });

  it('should throw when the timeout is exceeded', async () => {
    await expect(
      gracefulShutdown(
        [{ name: 'slow', stop: () => new Promise(() => {}) }],
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow(/Shutdown timeout exceeded/);
  });

  it('should collect errors and throw a combined message', async () => {
    await expect(
      gracefulShutdown(
        [
          { name: 'a', stop: vi.fn(async () => { throw new Error('fail-a'); }) },
          { name: 'b', stop: vi.fn(async () => { throw new Error('fail-b'); }) },
        ],
        { timeoutMs: 5000 },
      ),
    ).rejects.toThrow(/fail-a.*fail-b/);
  });

  it('should succeed when all services stop cleanly', async () => {
    await expect(
      gracefulShutdown(
        [
          { name: 'a', stop: vi.fn().mockResolvedValue(undefined) },
          { name: 'b', stop: vi.fn().mockResolvedValue(undefined) },
        ],
        { timeoutMs: 5000 },
      ),
    ).resolves.toBeUndefined();
  });
});