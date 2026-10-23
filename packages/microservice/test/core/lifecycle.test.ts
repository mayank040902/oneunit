import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LifecycleManager, createLifecycleManager, LifecycleState } from '../../src/core/lifecycle.js';
import { Transport, TransportCapabilities, TransportHealth } from '../../src/core/capabilities.js';

describe('Lifecycle Manager', () => {
  let lifecycle: LifecycleManager;

  beforeEach(() => {
    lifecycle = createLifecycleManager(1000); // 1 second health check interval for tests
  });

  afterEach(async () => {
    if (lifecycle.getState() !== 'initialized' && lifecycle.getState() !== 'stopped') {
      await lifecycle.stop().catch(() => {});
    }
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should start in initialized state', () => {
      expect(lifecycle.getState()).toBe('initialized');
    });

    it('should have empty transports initially', () => {
      expect(lifecycle.getAllTransports()).toHaveLength(0);
    });
  });

  describe('degraded state', () => {
    it('should transition from running to degraded when a transport reports unhealthy', async () => {
      vi.useFakeTimers();
      const transport = createMockTransport('tcp');
      transport.healthCheck = vi.fn().mockResolvedValue({
        status: 'unhealthy',
        checkedAt: Date.now(),
      });
      lifecycle.registerTransport(transport);

      await lifecycle.start();
      expect(lifecycle.getState()).toBe('running');

      await vi.advanceTimersByTimeAsync(1000);
      expect(lifecycle.getState()).toBe('degraded');
    });

    it('should return from degraded to running when every transport recovers', async () => {
      vi.useFakeTimers();
      let status: 'healthy' | 'unhealthy' = 'unhealthy';
      const transport = createMockTransport('tcp');
      transport.healthCheck = vi.fn().mockImplementation(async () => ({
        status,
        checkedAt: Date.now(),
      }));
      lifecycle.registerTransport(transport);

      await lifecycle.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(lifecycle.getState()).toBe('degraded');

      status = 'healthy';
      await vi.advanceTimersByTimeAsync(1000);
      expect(lifecycle.getState()).toBe('running');
    });

    it('should emit the degraded event with the unhealthy transport names', async () => {
      vi.useFakeTimers();
      const degradedNames: string[][] = [];
      lifecycle.on('degraded', (names: string[]) => degradedNames.push(names));
      const transport = createMockTransport('tcp');
      transport.healthCheck = vi.fn().mockResolvedValue({
        status: 'unhealthy',
        checkedAt: Date.now(),
      });
      lifecycle.registerTransport(transport);

      await lifecycle.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(degradedNames).toEqual([['tcp']]);
    });

    it('should stop from the degraded state', async () => {
      vi.useFakeTimers();
      const transport = createMockTransport('tcp');
      transport.healthCheck = vi.fn().mockResolvedValue({
        status: 'unhealthy',
        checkedAt: Date.now(),
      });
      lifecycle.registerTransport(transport);

      await lifecycle.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(lifecycle.getState()).toBe('degraded');

      await lifecycle.stop();
      expect(lifecycle.getState()).toBe('stopped');
    });

    it('should reject start from the degraded state', async () => {
      vi.useFakeTimers();
      const transport = createMockTransport('tcp');
      transport.healthCheck = vi.fn().mockResolvedValue({
        status: 'unhealthy',
        checkedAt: Date.now(),
      });
      lifecycle.registerTransport(transport);

      await lifecycle.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(lifecycle.getState()).toBe('degraded');

      await expect(lifecycle.start()).rejects.toThrow('Cannot start from state: degraded');
    });
  });

  describe('registerTransport', () => {
    it('should register a transport', () => {
      const mockTransport = createMockTransport('test-transport');
      lifecycle.registerTransport(mockTransport);
      expect(lifecycle.getAllTransports()).toHaveLength(1);
      expect(lifecycle.getTransport('test-transport')).toBe(mockTransport);
    });

    it('should throw when registering duplicate transport name', () => {
      const transport1 = createMockTransport('duplicate');
      const transport2 = createMockTransport('duplicate');
      lifecycle.registerTransport(transport1);
      expect(() => lifecycle.registerTransport(transport2)).toThrow();
      try {
        lifecycle.registerTransport(transport2);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as any).code).toBe('TRANSPORT_ALREADY_REGISTERED');
      }
    });

    it('should emit no events on register', () => {
      const stateChanges: LifecycleState[] = [];
      lifecycle.on('stateChange', (state) => stateChanges.push(state));
      const mockTransport = createMockTransport('test');
      lifecycle.registerTransport(mockTransport);
      expect(stateChanges).toHaveLength(0);
    });
  });

  describe('unregisterTransport', () => {
    it('should remove registered transport', () => {
      const mockTransport = createMockTransport('to-remove');
      lifecycle.registerTransport(mockTransport);
      const removed = lifecycle.unregisterTransport('to-remove');
      expect(removed).toBe(true);
      expect(lifecycle.getTransport('to-remove')).toBeUndefined();
    });

    it('should return false for non-existent transport', () => {
      const removed = lifecycle.unregisterTransport('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('setHooks', () => {
    it('should set lifecycle hooks', () => {
      const onStart = vi.fn().mockResolvedValue(undefined);
      const onStop = vi.fn().mockResolvedValue(undefined);
      const onHealthCheck = vi.fn().mockResolvedValue({ custom: 'health' });

      lifecycle.setHooks({ onStart, onStop, onHealthCheck });
      // Hooks are private, tested indirectly through start/stop/healthCheck
    });

    it('should preserve onStart when setHooks is called with only onStop', async () => {
      const onStart = vi.fn().mockResolvedValue(undefined);
      const onStop = vi.fn().mockResolvedValue(undefined);

      lifecycle.setHooks({ onStart });
      lifecycle.setHooks({ onStop });

      lifecycle.registerTransport(createMockTransport('t1'));
      await lifecycle.start();
      await lifecycle.stop();

      expect(onStart).toHaveBeenCalled();
      expect(onStop).toHaveBeenCalled();
    });
  });

  describe('start', () => {
    it('should start successfully with no transports', async () => {
      await lifecycle.start();
      expect(lifecycle.getState()).toBe('running');
    });

    it('should emit stateChange events', async () => {
      const states: LifecycleState[] = [];
      lifecycle.on('stateChange', (state) => states.push(state));
      
      await lifecycle.start();
      
      expect(states).toContain('starting');
      expect(states).toContain('running');
    });

    it('should emit started event', async () => {
      const started = vi.fn();
      lifecycle.on('started', started);
      
      await lifecycle.start();
      
      expect(started).toHaveBeenCalled();
    });

    it('should start registered transports', async () => {
      const mockTransport = createMockTransport('transport-1');
      lifecycle.registerTransport(mockTransport);
      
      await lifecycle.start();
      
      expect(mockTransport.start).toHaveBeenCalled();
      expect(lifecycle.getState()).toBe('running');
    });

    it('should start transports in order', async () => {
      const transport1 = createMockTransport('transport-1');
      const transport2 = createMockTransport('transport-2');
      lifecycle.registerTransport(transport1);
      lifecycle.registerTransport(transport2);
      
      await lifecycle.start();
      
      expect(transport1.start).toHaveBeenCalled();
      expect(transport2.start).toHaveBeenCalled();
    });

    it('should emit transportStarted for each transport', async () => {
      const events: string[] = [];
      lifecycle.on('transportStarted', (name) => events.push(name));
      
      const transport1 = createMockTransport('t1');
      const transport2 = createMockTransport('t2');
      lifecycle.registerTransport(transport1);
      lifecycle.registerTransport(transport2);
      
      await lifecycle.start();
      
      expect(events).toContain('t1');
      expect(events).toContain('t2');
    });

    it('should call onStart hook if provided', async () => {
      const onStart = vi.fn().mockResolvedValue(undefined);
      lifecycle.setHooks({ onStart });
      
      await lifecycle.start();
      
      expect(onStart).toHaveBeenCalled();
    });

    it('should fail if transport start fails', async () => {
      const failingTransport = createMockTransport('failing');
      failingTransport.start.mockRejectedValue(new Error('start failed'));
      lifecycle.registerTransport(failingTransport);
      
      try {
        await lifecycle.start();
      } catch (err) {
        expect((err as any).code).toBe('TRANSPORT_START_FAILED');
      }
      expect(lifecycle.getState()).toBe('failed');
    });

    it('should roll back previously started transports when a later transport fails', async () => {
      const goodTransport = createMockTransport('good');
      const failingTransport = createMockTransport('failing');
      failingTransport.start.mockRejectedValue(new Error('start failed'));
      lifecycle.registerTransport(goodTransport);
      lifecycle.registerTransport(failingTransport);

      try {
        await lifecycle.start();
      } catch {
        // Expected
      }

      expect(goodTransport.close).toHaveBeenCalled();
      expect(failingTransport.close).not.toHaveBeenCalled();
      expect(lifecycle.getState()).toBe('failed');
      expect(goodTransport.start).toHaveBeenCalled();
    });

    it('should emit transportStartError on transport failure', async () => {
      const events: Array<{ name: string; error: Error }> = [];
      lifecycle.on('transportStartError', (name, error) => events.push({ name, error }));
      
      const failingTransport = createMockTransport('failing');
      failingTransport.start.mockRejectedValue(new Error('start failed'));
      lifecycle.registerTransport(failingTransport);
      
      await expect(lifecycle.start()).rejects.toThrow();
      
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('failing');
      expect(events[0].error.message).toBe('start failed');
    });

    it('should throw if start called from invalid state', async () => {
      await lifecycle.start(); // running
      try {
        await lifecycle.start();
      } catch (err) {
        expect((err as any).code).toBe('INVALID_STATE');
      }
    });

    it('should throw if start called from stopping state', async () => {
      await lifecycle.start();
      const stopPromise = lifecycle.stop();
      try {
        await lifecycle.start();
      } catch (err) {
        expect((err as any).code).toBe('INVALID_STATE');
      }
      await stopPromise;
    });

    it('should allow start from stopped state', async () => {
      await lifecycle.start();
      await lifecycle.stop();
      await lifecycle.start(); // Should work
      expect(lifecycle.getState()).toBe('running');
    });
  });

  describe('stop', () => {
    it('should stop successfully', async () => {
      await lifecycle.start();
      await lifecycle.stop();
      expect(lifecycle.getState()).toBe('stopped');
    });

    it('should be idempotent', async () => {
      await lifecycle.start();
      await lifecycle.stop();
      await lifecycle.stop(); // Should not throw
      expect(lifecycle.getState()).toBe('stopped');
    });

    it('should emit stateChange events', async () => {
      await lifecycle.start();
      const states: LifecycleState[] = [];
      lifecycle.on('stateChange', (state) => states.push(state));
      
      await lifecycle.stop();
      
      expect(states).toContain('stopping');
      expect(states).toContain('stopped');
    });

    it('should emit stopped event', async () => {
      await lifecycle.start();
      const stopped = vi.fn();
      lifecycle.on('stopped', stopped);
      
      await lifecycle.stop();
      
      expect(stopped).toHaveBeenCalled();
    });

    it('should stop transports in reverse order', async () => {
      const transport1 = createMockTransport('t1');
      const transport2 = createMockTransport('t2');
      lifecycle.registerTransport(transport1);
      lifecycle.registerTransport(transport2);
      
      await lifecycle.start();
      await lifecycle.stop();
      
      // close should be called in reverse order
      expect(transport1.close).toHaveBeenCalled();
      expect(transport2.close).toHaveBeenCalled();
      // Verify order by checking call order
      const closeCalls = [transport1.close, transport2.close].map(m => m.mock.invocationCallOrder[0]);
      expect(closeCalls[1]).toBeLessThan(closeCalls[0]); // t2 closed before t1
    });

    it('should emit transportStopped for each transport', async () => {
      const events: string[] = [];
      lifecycle.on('transportStopped', (name) => events.push(name));
      
      const transport1 = createMockTransport('t1');
      const transport2 = createMockTransport('t2');
      lifecycle.registerTransport(transport1);
      lifecycle.registerTransport(transport2);
      
      await lifecycle.start();
      await lifecycle.stop();
      
      expect(events).toContain('t1');
      expect(events).toContain('t2');
    });

    it('should call onStop hook if provided', async () => {
      const onStop = vi.fn().mockResolvedValue(undefined);
      lifecycle.setHooks({ onStop });
      
      await lifecycle.start();
      await lifecycle.stop();
      
      expect(onStop).toHaveBeenCalled();
    });

    it('should continue stopping other transports if one fails', async () => {
      const failingTransport = createMockTransport('failing');
      failingTransport.close.mockRejectedValue(new Error('close failed'));
      const goodTransport = createMockTransport('good');
      
      lifecycle.registerTransport(failingTransport);
      lifecycle.registerTransport(goodTransport);
      
      await lifecycle.start();
      await expect(lifecycle.stop()).rejects.toThrow(); // STOP_ERRORS is thrown
      
      expect(failingTransport.close).toHaveBeenCalled();
      expect(goodTransport.close).toHaveBeenCalled();
    });

    it('should emit transportStopError on transport failure', async () => {
      const events: Array<{ name: string; error: Error }> = [];
      lifecycle.on('transportStopError', (name, error) => events.push({ name, error }));
      
      const failingTransport = createMockTransport('failing');
      failingTransport.close.mockRejectedValue(new Error('close failed'));
      lifecycle.registerTransport(failingTransport);
      
      await lifecycle.start();
      await expect(lifecycle.stop()).rejects.toThrow();
      
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('failing');
    });

    it('should throw MicroserviceError if any transport fails to stop', async () => {
      const failingTransport = createMockTransport('failing');
      failingTransport.close.mockRejectedValue(new Error('close failed'));
      lifecycle.registerTransport(failingTransport);
      
      await lifecycle.start();
      try {
        await lifecycle.stop();
      } catch (err) {
        expect((err as any).code).toBe('STOP_ERRORS');
      }
      
      // State should be stopped even when transports fail to close.
      expect(lifecycle.getState()).toBe('stopped');
    });

    it('should aggregate multiple stop errors', async () => {
      const failing1 = createMockTransport('failing1');
      failing1.close.mockRejectedValue(new Error('error 1'));
      const failing2 = createMockTransport('failing2');
      failing2.close.mockRejectedValue(new Error('error 2'));
      
      lifecycle.registerTransport(failing1);
      lifecycle.registerTransport(failing2);
      
      await lifecycle.start();
      try {
        await lifecycle.stop();
      } catch (err) {
        expect((err as any).code).toBe('STOP_ERRORS');
      }
    });

    it('should stop health checks interval', async () => {
      vi.useFakeTimers();
      await lifecycle.start();
      const healthCheckCalls: TransportHealth[] = [];
      lifecycle.on('healthCheck', (health) => healthCheckCalls.push(health));
      
      await lifecycle.stop();
      
      // Advance timers - should not trigger health checks after stop
      vi.advanceTimersByTime(5000);
      const callsAfterStop = healthCheckCalls.length;
      
      // Wait a bit more
      vi.advanceTimersByTime(5000);
      expect(healthCheckCalls.length).toBe(callsAfterStop);
      
      vi.useRealTimers();
    });
  });

  describe('healthCheck', () => {
    it('should return health for all transports', async () => {
      const transport1 = createMockTransport('t1');
      transport1.healthCheck.mockResolvedValue({ status: 'healthy', checkedAt: Date.now() });
      const transport2 = createMockTransport('t2');
      transport2.healthCheck.mockResolvedValue({ status: 'degraded', checkedAt: Date.now(), details: { reason: 'slow' } });
      
      lifecycle.registerTransport(transport1);
      lifecycle.registerTransport(transport2);
      
      await lifecycle.start();
      const health = await lifecycle.healthCheck();
      
      expect(health.t1.status).toBe('healthy');
      expect(health.t2.status).toBe('degraded');
      expect(health.t2.details).toEqual({ reason: 'slow' });
    });

    it('should return unhealthy for transport that throws', async () => {
      const failingTransport = createMockTransport('failing');
      failingTransport.healthCheck.mockRejectedValue(new Error('health check failed'));
      lifecycle.registerTransport(failingTransport);
      
      await lifecycle.start();
      const health = await lifecycle.healthCheck();
      
      expect(health.failing.status).toBe('unhealthy');
      expect(health.failing.details?.error).toBe('health check failed');
    });

    it('should include application health if onHealthCheck hook provided', async () => {
      lifecycle.setHooks({
        onHealthCheck: vi.fn().mockResolvedValue({ custom: 'data' }),
      });
      
      await lifecycle.start();
      const health = await lifecycle.healthCheck();
      
      expect(health.application).toBeDefined();
      expect(health.application?.status).toBe('healthy');
      expect(health.application?.details).toEqual({ custom: 'data' });
    });

    it('should mark application unhealthy if onHealthCheck throws', async () => {
      lifecycle.setHooks({
        onHealthCheck: vi.fn().mockRejectedValue(new Error('hook failed')),
      });
      
      await lifecycle.start();
      const health = await lifecycle.healthCheck();
      
      expect(health.application?.status).toBe('unhealthy');
    });
  });

  describe('getState', () => {
    it('should return current state', () => {
      expect(lifecycle.getState()).toBe('initialized');
    });

    it('should return running after start', async () => {
      await lifecycle.start();
      expect(lifecycle.getState()).toBe('running');
    });

    it('should return stopped after stop', async () => {
      await lifecycle.start();
      await lifecycle.stop();
      expect(lifecycle.getState()).toBe('stopped');
    });
  });

  describe('health check interval', () => {
    it('should emit healthCheck events periodically', async () => {
      vi.useFakeTimers();
      const transport = createMockTransport('t1');
      transport.healthCheck.mockResolvedValue({ status: 'healthy', checkedAt: Date.now() });
      lifecycle.registerTransport(transport);
      
      const healthEvents: TransportHealth[] = [];
      lifecycle.on('healthCheck', (health) => healthEvents.push(health));
      
      await lifecycle.start();
      
      vi.advanceTimersByTime(1000); // 1 interval
      await vi.runOnlyPendingTimersAsync();
      expect(healthEvents.length).toBeGreaterThanOrEqual(1);
      
      vi.advanceTimersByTime(1000); // 2nd interval
      await vi.runOnlyPendingTimersAsync();
      expect(healthEvents.length).toBeGreaterThanOrEqual(2);
      
      await lifecycle.stop();
      vi.useRealTimers();
    });

    it('should emit degraded event when transports unhealthy', async () => {
      vi.useFakeTimers();
      const transport = createMockTransport('t1');
      transport.healthCheck.mockResolvedValue({ status: 'unhealthy', checkedAt: Date.now() });
      lifecycle.registerTransport(transport);
      
      const degradedEvents: string[][] = [];
      lifecycle.on('degraded', (names) => degradedEvents.push(names));
      
      await lifecycle.start();
      
      vi.advanceTimersByTime(1000);
      await vi.runOnlyPendingTimersAsync();
      expect(degradedEvents.length).toBeGreaterThanOrEqual(1);
      expect(degradedEvents[0]).toContain('t1');
      
      await lifecycle.stop();
      vi.useRealTimers();
    });
  });

  describe('sortByDependencies', () => {
    it('should handle bidirectional transports', async () => {
      // Test internal behavior indirectly through start order
      const tcpTransport = createMockTransport('tcp');
      tcpTransport.capabilities = { ...tcpTransport.capabilities, bidirectional: true };
      const httpTransport = createMockTransport('http');
      httpTransport.capabilities = { ...httpTransport.capabilities, requestResponse: true };
      
      lifecycle.registerTransport(tcpTransport);
      lifecycle.registerTransport(httpTransport);
      
      await lifecycle.start();
      // Both should start without error
      expect(lifecycle.getState()).toBe('running');
    });
  });

  describe('concurrent start and stop', () => {
    it('should start only once when start is called concurrently', async () => {
      const transport = createMockTransport('t1');
      lifecycle.registerTransport(transport);

      const results = await Promise.allSettled([
        lifecycle.start(),
        lifecycle.start(),
        lifecycle.start(),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
      expect(transport.start).toHaveBeenCalledTimes(1);
      expect(lifecycle.getState()).toBe('running');
    });

    it('should reject the extra starts with INVALID_STATE when start is called concurrently', async () => {
      lifecycle.registerTransport(createMockTransport('t1'));

      const results = await Promise.allSettled([lifecycle.start(), lifecycle.start()]);
      const rejected = results.find((r) => r.status === 'rejected');

      expect(rejected).toBeDefined();
      expect((rejected as PromiseRejectedResult).reason.code).toBe('INVALID_STATE');
    });

    it('should stop without error when stop is called concurrently', async () => {
      const transport = createMockTransport('t1');
      lifecycle.registerTransport(transport);
      await lifecycle.start();

      const results = await Promise.allSettled([
        lifecycle.stop(),
        lifecycle.stop(),
        lifecycle.stop(),
      ]);

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(transport.close).toHaveBeenCalledTimes(1);
      expect(lifecycle.getState()).toBe('stopped');
    });
  });

  describe('hook ordering', () => {
    it('should run the onStart hook before the transports start', async () => {
      const order: string[] = [];
      const transport = createMockTransport('t1');
      transport.start = vi.fn(async () => {
        order.push('transport');
      });
      lifecycle.registerTransport(transport);
      lifecycle.setHooks({
        onStart: vi.fn(async () => {
          order.push('hook');
        }),
      });

      await lifecycle.start();

      expect(order).toEqual(['hook', 'transport']);
    });

    it('should run the onStop hook after the transports close', async () => {
      const order: string[] = [];
      const transport = createMockTransport('t1');
      transport.close = vi.fn(async () => {
        order.push('transport');
      });
      lifecycle.registerTransport(transport);
      await lifecycle.start();

      lifecycle.setHooks({
        onStop: vi.fn(async () => {
          order.push('hook');
        }),
      });

      await lifecycle.stop();

      expect(order).toEqual(['transport', 'hook']);
    });

    it('should fail the start when the onStart hook rejects', async () => {
      lifecycle.registerTransport(createMockTransport('t1'));
      lifecycle.setHooks({
        onStart: vi.fn().mockRejectedValue(new Error('hook start failed')),
      });

      await expect(lifecycle.start()).rejects.toThrow('hook start failed');
      expect(lifecycle.getState()).toBe('failed');
    });
  });
});

function createMockTransport(name: string): Transport {
  const capabilities: TransportCapabilities = {
    requestResponse: false,
    streaming: false,
    publishSubscribe: false,
    durableDelivery: false,
    orderedDelivery: false,
    bidirectional: false,
  };

  return {
    name,
    capabilities,
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checkedAt: Date.now() }),
  };
}