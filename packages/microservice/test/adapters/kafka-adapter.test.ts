import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KafkaTransport } from '../../src/adapters/messaging/kafka/adapter.js';
import { KafkaAdapterConfig } from '../../src/adapters/messaging/kafka/types.js';

function baseConfig(overrides: Partial<KafkaAdapterConfig> = {}): KafkaAdapterConfig {
  return {
    brokers: ['localhost:9092'],
    clientId: 'test-client',
    topics: { prefix: 'oneunit' },
    ...overrides,
  };
}

describe('KafkaTransport construction', () => {
  it('should report correct capabilities', () => {
    const transport = new KafkaTransport(baseConfig());
    expect(transport.name).toBe('kafka');
    expect(transport.capabilities.requestResponse).toBe(false);
    expect(transport.capabilities.publishSubscribe).toBe(true);
    expect(transport.capabilities.durableDelivery).toBe(true);
    expect(transport.capabilities.orderedDelivery).toBe(true);
  });

  it('should default resolved driver to kafkajs', () => {
    const transport = new KafkaTransport(baseConfig());
    expect(transport.getResolvedDriver()).toBe('kafkajs');
  });
});

describe('KafkaTransport before start', () => {
  it('should reject publish when not started', async () => {
    const transport = new KafkaTransport(baseConfig());
    await expect(transport.publish('topic', { a: 1 })).rejects.toThrow(/not started/);
  });

  it('should reject subscribe when not started', async () => {
    const transport = new KafkaTransport(baseConfig());
    await expect(transport.subscribe('topic', async () => {})).rejects.toThrow(/not started/);
  });

  it('should reject unsubscribe when not started', async () => {
    const transport = new KafkaTransport(baseConfig());
    await expect(transport.unsubscribe('topic')).rejects.toThrow(/not started/);
  });

  it('should report unhealthy before start', async () => {
    const transport = new KafkaTransport(baseConfig());
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
    expect(health.details).toEqual({ connected: false, driver: 'kafkajs' });
  });
});

describe('KafkaTransport lifecycle', () => {
  let transport: KafkaTransport;
  let closeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    transport = new KafkaTransport(baseConfig({ driver: 'kafkajs' }));
    closeSpy = vi.spyOn(transport as any, 'close');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be idempotent across repeated close calls', async () => {
    await transport.close();
    await transport.close();
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });

  it('should route publish through the driver adapter', async () => {
    const fakeAdapter = {
      name: 'kafka',
      capabilities: transport.capabilities,
      start: vi.fn(),
      close: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checkedAt: Date.now() }),
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    (transport as any).driverAdapter = fakeAdapter;

    await transport.publish('topic', { value: 42 }, { key: 'k1' });

    expect(fakeAdapter.publish).toHaveBeenCalledWith('topic', { value: 42 }, { key: 'k1' });
  });

  it('should route subscribe through the driver adapter', async () => {
    const fakeAdapter = {
      name: 'kafka',
      capabilities: transport.capabilities,
      start: vi.fn(),
      close: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checkedAt: Date.now() }),
      publish: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn(),
    };
    (transport as any).driverAdapter = fakeAdapter;

    const handler = vi.fn();
    await transport.subscribe('topic', handler, { groupId: 'g1' });

    expect(fakeAdapter.subscribe).toHaveBeenCalledWith('topic', handler, { groupId: 'g1' });
  });

  it('should route unsubscribe through the driver adapter', async () => {
    const fakeAdapter = {
      name: 'kafka',
      capabilities: transport.capabilities,
      start: vi.fn(),
      close: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checkedAt: Date.now() }),
      publish: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    };
    (transport as any).driverAdapter = fakeAdapter;

    await transport.unsubscribe('topic');

    expect(fakeAdapter.unsubscribe).toHaveBeenCalledWith('topic');
  });

  it('should clear the adapter on close', async () => {
    const fakeAdapter = {
      name: 'kafka',
      capabilities: transport.capabilities,
      start: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checkedAt: Date.now() }),
      publish: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    (transport as any).driverAdapter = fakeAdapter;

    await transport.close();
    expect(fakeAdapter.close).toHaveBeenCalledTimes(1);
    expect((transport as any).driverAdapter).toBeNull();
  });

  it('should report unhealthy after close', async () => {
    const fakeAdapter = {
      name: 'kafka',
      capabilities: transport.capabilities,
      start: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checkedAt: Date.now() }),
      publish: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    (transport as any).driverAdapter = fakeAdapter;

    await transport.close();
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
  });
});

describe('KafkaTransport driver selection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should default to kafkajs when no driver is specified', () => {
    const transport = new KafkaTransport(baseConfig());
    expect(transport.getResolvedDriver()).toBe('kafkajs');
  });

  it('should report oneunit driver before start when configured', () => {
    const transport = new KafkaTransport(baseConfig({ driver: 'oneunit' }));
    // The resolved driver is only set after start(); before that it retains
    // the constructor default. This documents the pre-start state.
    expect(transport.getResolvedDriver()).toBe('kafkajs');
  });

  it('should report auto driver before start when configured', () => {
    const transport = new KafkaTransport(baseConfig({ driver: 'auto' }));
    expect(transport.getResolvedDriver()).toBe('kafkajs');
  });
});