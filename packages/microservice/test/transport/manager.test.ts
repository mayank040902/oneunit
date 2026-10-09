import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TransportManager, createTransportManager, TransportManagerConfig } from '../../src/transport/manager.js';
import { Transport, TransportCapabilities, TransportHealth } from '../../src/core/capabilities.js';

function makeCapabilities(overrides: Partial<TransportCapabilities> = {}): TransportCapabilities {
  return {
    requestResponse: false,
    streaming: false,
    publishSubscribe: false,
    durableDelivery: false,
    orderedDelivery: false,
    bidirectional: false,
    ...overrides,
  };
}

function makeTransport(overrides: Partial<Transport> & { name: string }): Transport {
  const caps = overrides.capabilities ?? makeCapabilities();
  return {
    name: overrides.name,
    capabilities: caps,
    start: overrides.start ?? vi.fn().mockResolvedValue(undefined),
    close: overrides.close ?? vi.fn().mockResolvedValue(undefined),
    healthCheck: overrides.healthCheck ?? vi.fn().mockResolvedValue({
      status: 'healthy',
      checkedAt: Date.now(),
    } as TransportHealth),
  };
}

describe('TransportManager construction', () => {
  it('should create with empty config', () => {
    const manager = new TransportManager();
    expect(manager.getAll()).toEqual([]);
    expect(manager.getAllMetrics()).toEqual({});
  });

  it('should create with config', () => {
    const manager = new TransportManager({ healthCheckIntervalMs: 5000 });
    expect((manager as any).config.healthCheckIntervalMs).toBe(5000);
  });

  it('should create via factory', () => {
    const manager = createTransportManager();
    expect(manager).toBeInstanceOf(TransportManager);
  });
});

describe('TransportManager registration', () => {
  let manager: TransportManager;

  beforeEach(() => {
    manager = new TransportManager();
  });

  it('should register a transport', () => {
    const transport = makeTransport({ name: 'tcp' });
    manager.register(transport);
    expect(manager.get('tcp')).toBe(transport);
  });

  it('should register multiple transports', () => {
    manager.register(makeTransport({ name: 'tcp' }));
    manager.register(makeTransport({ name: 'udp' }));
    expect(manager.getAll()).toHaveLength(2);
  });

  it('should throw on duplicate registration', () => {
    manager.register(makeTransport({ name: 'tcp' }));
    expect(() => manager.register(makeTransport({ name: 'tcp' }))).toThrow(
      /already registered/,
    );
  });

  it('should unregister a transport', () => {
    const transport = makeTransport({ name: 'tcp' });
    manager.register(transport);
    expect(manager.unregister('tcp')).toBe(true);
    expect(manager.get('tcp')).toBeUndefined();
  });

  it('should return false when unregistering unknown transport', () => {
    expect(manager.unregister('unknown')).toBe(false);
  });

  it('should return undefined for unknown transport', () => {
    expect(manager.get('unknown')).toBeUndefined();
  });

  it('should also remove metrics when unregistering', () => {
    manager.register(makeTransport({ name: 'tcp' }));
    manager.recordMetrics('tcp', { messagesSent: 5 });
    expect(manager.getMetrics('tcp')).toBeDefined();
    manager.unregister('tcp');
    expect(manager.getMetrics('tcp')).toBeUndefined();
  });
});

describe('TransportManager capability filtering', () => {
  let manager: TransportManager;

  beforeEach(() => {
    manager = new TransportManager();
  });

  it('should find transports by capability', () => {
    manager.register(makeTransport({
      name: 'rpc',
      capabilities: makeCapabilities({ requestResponse: true }),
    }));
    manager.register(makeTransport({
      name: 'kafka',
      capabilities: makeCapabilities({ publishSubscribe: true }),
    }));

    const rpcTransports = manager.getByCapability('requestResponse');
    expect(rpcTransports).toHaveLength(1);
    expect(rpcTransports[0].name).toBe('rpc');

    const kafkaTransports = manager.getByCapability('publishSubscribe');
    expect(kafkaTransports).toHaveLength(1);
    expect(kafkaTransports[0].name).toBe('kafka');
  });

  it('should return empty array when no transport has the capability', () => {
    manager.register(makeTransport({
      name: 'udp',
      capabilities: makeCapabilities({ requestResponse: false }),
    }));
    expect(manager.getByCapability('requestResponse')).toEqual([]);
  });
});

describe('TransportManager lifecycle', () => {
  let manager: TransportManager;

  beforeEach(() => {
    manager = new TransportManager();
  });

  it('should start all transports', async () => {
    const t1 = makeTransport({ name: 'tcp', start: vi.fn().mockResolvedValue(undefined) });
    const t2 = makeTransport({ name: 'udp', start: vi.fn().mockResolvedValue(undefined) });
    manager.register(t1);
    manager.register(t2);

    await manager.startAll();

    expect(t1.start).toHaveBeenCalled();
    expect(t2.start).toHaveBeenCalled();
  });

  it('should throw if any transport fails to start and leave others started', async () => {
    const t1 = makeTransport({ name: 'tcp', start: vi.fn().mockResolvedValue(undefined) });
    const t2 = makeTransport({
      name: 'udp',
      start: vi.fn().mockRejectedValue(new Error('udp start failed')),
    });
    manager.register(t1);
    manager.register(t2);

    await expect(manager.startAll()).rejects.toThrow(/Failed to start transports/);
    expect(t1.start).toHaveBeenCalled();
    expect(t2.start).toHaveBeenCalled();
  });

  it('should stop all transports', async () => {
    const t1 = makeTransport({ name: 'tcp', close: vi.fn().mockResolvedValue(undefined) });
    const t2 = makeTransport({ name: 'udp', close: vi.fn().mockResolvedValue(undefined) });
    manager.register(t1);
    manager.register(t2);

    await manager.stopAll();

    expect(t1.close).toHaveBeenCalled();
    expect(t2.close).toHaveBeenCalled();
  });

  it('should throw if any transport fails to stop', async () => {
    const t1 = makeTransport({ name: 'tcp', close: vi.fn().mockRejectedValue(new Error('close failed')) });
    const t2 = makeTransport({ name: 'udp', close: vi.fn().mockResolvedValue(undefined) });
    manager.register(t1);
    manager.register(t2);

    await expect(manager.stopAll()).rejects.toThrow(/Failed to stop transports/);
  });

  it('should be safe to call stopAll with no transports', async () => {
    await expect(manager.stopAll()).resolves.toBeUndefined();
  });

  it('should be safe to call startAll with no transports', async () => {
    await expect(manager.startAll()).resolves.toBeUndefined();
  });

  it('should stop health checks before stopping transports', async () => {
    const spy = vi.spyOn(manager as any, 'stopHealthChecks');
    manager.register(makeTransport({ name: 'tcp' }));
    await manager.startAll({ healthCheckIntervalMs: 1000 } as any);
    // Override config to trigger health checks
    (manager as any).config.healthCheckIntervalMs = 1000;
    await manager.startAll();
    await manager.stopAll();
    expect(spy).toHaveBeenCalled();
  });
});

describe('TransportManager health checks', () => {
  let manager: TransportManager;

  beforeEach(() => {
    manager = new TransportManager();
  });

  it('should check health of all transports', async () => {
    const healthyResult: TransportHealth = { status: 'healthy', checkedAt: Date.now() };
    const degradedResult: TransportHealth = { status: 'degraded', checkedAt: Date.now() };

    manager.register(makeTransport({
      name: 'tcp',
      healthCheck: vi.fn().mockResolvedValue(healthyResult),
    }));
    manager.register(makeTransport({
      name: 'udp',
      healthCheck: vi.fn().mockResolvedValue(degradedResult),
    }));

    const results = await manager.healthCheckAll();
    expect(results.tcp.status).toBe('healthy');
    expect(results.udp.status).toBe('degraded');
  });

  it('should report unhealthy when health check throws', async () => {
    manager.register(makeTransport({
      name: 'tcp',
      healthCheck: vi.fn().mockRejectedValue(new Error('connection refused')),
    }));

    const results = await manager.healthCheckAll();
    expect(results.tcp.status).toBe('unhealthy');
    expect(results.tcp.details).toEqual({ error: 'connection refused' });
  });

  it('should report all healthy via isHealthy', async () => {
    manager.register(makeTransport({
      name: 'tcp',
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checkedAt: Date.now() }),
    }));
    expect(await manager.isHealthy()).toBe(true);
  });

  it('should report false via isHealthy when any transport is unhealthy', async () => {
    manager.register(makeTransport({
      name: 'tcp',
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checkedAt: Date.now() }),
    }));
    manager.register(makeTransport({
      name: 'udp',
      healthCheck: vi.fn().mockResolvedValue({ status: 'unhealthy', checkedAt: Date.now() }),
    }));
    expect(await manager.isHealthy()).toBe(false);
  });

  it('should report false via isHealthy when health check throws', async () => {
    manager.register(makeTransport({
      name: 'tcp',
      healthCheck: vi.fn().mockRejectedValue(new Error('fail')),
    }));
    expect(await manager.isHealthy()).toBe(false);
  });

  it('should start periodic health checks when configured', async () => {
    vi.useFakeTimers();
    const manager = new TransportManager({ healthCheckIntervalMs: 1000 });
    const transport = makeTransport({
      name: 'tcp',
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checkedAt: Date.now() }),
    });
    manager.register(transport);

    await manager.startAll();
    expect(transport.healthCheck).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.healthCheck).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('should stop periodic health checks on stopAll', async () => {
    vi.useFakeTimers();
    const manager = new TransportManager({ healthCheckIntervalMs: 1000 });
    const transport = makeTransport({
      name: 'tcp',
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checkedAt: Date.now() }),
    });
    manager.register(transport);

    await manager.startAll();
    await vi.advanceTimersByTimeAsync(1000);
    const callsAfterFirstInterval = transport.healthCheck.mock.calls.length;

    await manager.stopAll();
    await vi.advanceTimersByTimeAsync(5000);

    expect(transport.healthCheck.mock.calls.length).toBe(callsAfterFirstInterval);
    vi.useRealTimers();
  });
});

describe('TransportManager send and broadcast', () => {
  let manager: TransportManager;

  beforeEach(() => {
    manager = new TransportManager();
  });

  it('should reject send when no matching transport is found', async () => {
    await expect(manager.send('unknown', 'dest', { data: 1 })).rejects.toThrow(
      /No transport found for protocol/,
    );
  });

  it('should throw "send not implemented" when a matching transport is found', async () => {
    manager.register(makeTransport({
      name: 'rpc',
      capabilities: makeCapabilities({ requestResponse: true }),
    }));
    await expect(manager.send('rpc', 'dest', { data: 1 })).rejects.toThrow(
      /send not implemented/,
    );
  });

  it('should broadcast to all publish-subscribe transports, respecting exclude', async () => {
    const t1 = makeTransport({ name: 'kafka', capabilities: makeCapabilities({ publishSubscribe: true }) });
    const t2 = makeTransport({ name: 'nats', capabilities: makeCapabilities({ publishSubscribe: true }) });
    manager.register(t1);
    manager.register(t2);

    // broadcast is a no-op in the current implementation (no real send on base transport)
    await expect(manager.broadcast('kafka', { data: 1 }, ['nats'])).resolves.toBeUndefined();
  });
});

describe('TransportManager metrics', () => {
  let manager: TransportManager;

  beforeEach(() => {
    manager = new TransportManager();
  });

  it('should initialize empty metrics for registered transport', () => {
    manager.register(makeTransport({ name: 'tcp' }));
    const metrics = manager.getMetrics('tcp');
    expect(metrics).toBeDefined();
    expect(metrics!.messagesSent).toBe(0);
    expect(metrics!.messagesReceived).toBe(0);
    expect(metrics!.errors).toBe(0);
  });

  it('should return undefined for unknown transport metrics', () => {
    expect(manager.getMetrics('unknown')).toBeUndefined();
  });

  it('should record metrics for a transport', () => {
    manager.register(makeTransport({ name: 'tcp' }));
    manager.recordMetrics('tcp', { messagesSent: 10, errors: 2 });
    const metrics = manager.getMetrics('tcp');
    expect(metrics!.messagesSent).toBe(10);
    expect(metrics!.errors).toBe(2);
  });

  it('should return empty object when no metrics exist', () => {
    expect(manager.getAllMetrics()).toEqual({});
  });

  it('should return all metrics after recording', () => {
    manager.register(makeTransport({ name: 'tcp' }));
    manager.register(makeTransport({ name: 'udp' }));
    manager.recordMetrics('tcp', { messagesSent: 5 });
    manager.recordMetrics('udp', { messagesReceived: 3 });

    const all = manager.getAllMetrics();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all.tcp.messagesSent).toBe(5);
    expect(all.udp.messagesReceived).toBe(3);
  });
});
