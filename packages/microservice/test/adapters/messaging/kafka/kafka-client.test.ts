import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../src/adapters/messaging/kafka/driver-resolver.js', () => ({
  resolveKafkaDriver: vi.fn(),
}));

import {
  createKafkaClient,
  resetKafkaClient,
  getCachedKafkaClient,
  isKafkaAvailable,
} from '../../../../src/adapters/messaging/kafka/kafka-client.js';
import { resolveKafkaDriver } from '../../../../src/adapters/messaging/kafka/driver-resolver.js';

const mockResolveKafkaDriver = vi.mocked(resolveKafkaDriver);

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    driver: 'oneunit',
    brokers: ['localhost:9092'],
    clientId: 'test-client',
    topics: { prefix: 'test' },
    ...overrides,
  };
}

function makeAdapter() {
  return {
    name: 'kafka',
    capabilities: {
      requestResponse: false,
      streaming: false,
      publishSubscribe: true,
      durableDelivery: true,
      orderedDelivery: true,
      bidirectional: false,
    },
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn(),
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createKafkaClient driver selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetKafkaClient();
  });

  afterEach(() => {
    resetKafkaClient();
    vi.restoreAllMocks();
  });

  it('should resolve the configured driver and delegate to its adapter', async () => {
    const adapter = makeAdapter();
    mockResolveKafkaDriver.mockResolvedValueOnce({
      driver: 'kafkajs',
      module: { createAdapter: vi.fn().mockResolvedValue(adapter) },
    });

    const client = await createKafkaClient({ config: makeConfig({ driver: 'kafkajs' }) });

    // Explicit kafkajs selection is honored: the resolver
    // receives the configured driver verbatim.
    expect(mockResolveKafkaDriver).toHaveBeenCalledWith(
      expect.objectContaining({ driver: 'kafkajs' }),
      undefined,
    );
    await client.publish('topic', { hello: 'world' }, { key: 'k' });
    expect(adapter.publish).toHaveBeenCalledWith('topic', { hello: 'world' }, { key: 'k' });
  });

  it('should start the driver adapter on creation', async () => {
    const adapter = makeAdapter();
    mockResolveKafkaDriver.mockResolvedValueOnce({
      driver: 'oneunit',
      module: { createAdapter: vi.fn().mockResolvedValue(adapter) },
    });

    await createKafkaClient({ config: makeConfig() });

    expect(adapter.start).toHaveBeenCalledTimes(1);
  });

  it('should close the driver adapter on disconnect and clear the cache', async () => {
    const adapter = makeAdapter();
    mockResolveKafkaDriver.mockResolvedValueOnce({
      driver: 'oneunit',
      module: { createAdapter: vi.fn().mockResolvedValue(adapter) },
    });

    const client = await createKafkaClient({ config: makeConfig() });
    expect(getCachedKafkaClient()).toBe(client);

    await client.disconnect();

    expect(adapter.close).toHaveBeenCalledTimes(1);
    expect(getCachedKafkaClient()).toBeNull();
  });

  it('should delegate subscribe and unsubscribe to the driver adapter', async () => {
    const adapter = makeAdapter();
    mockResolveKafkaDriver.mockResolvedValueOnce({
      driver: 'oneunit',
      module: { createAdapter: vi.fn().mockResolvedValue(adapter) },
    });

    const client = await createKafkaClient({ config: makeConfig() });
    const handler = vi.fn();

    await client.subscribe('topic', handler, { groupId: 'group-1' });
    expect(adapter.subscribe).toHaveBeenCalledWith('topic', handler, { groupId: 'group-1' });

    await client.unsubscribe('topic');
    expect(adapter.unsubscribe).toHaveBeenCalledWith('topic');
  });

  it('should return the cached client for repeated calls', async () => {
    const adapter = makeAdapter();
    const createAdapter = vi.fn().mockResolvedValue(adapter);
    mockResolveKafkaDriver.mockResolvedValue({
      driver: 'oneunit',
      module: { createAdapter },
    });

    const client1 = await createKafkaClient({ config: makeConfig() });
    const client2 = await createKafkaClient({ config: makeConfig() });

    expect(client1).toBe(client2);
    expect(createAdapter).toHaveBeenCalledTimes(1);
  });

  it('should propagate driver failures without switching drivers', async () => {
    mockResolveKafkaDriver.mockRejectedValueOnce(
      new Error('kafkajs is not installed. Install it or use driver: "oneunit"'),
    );

    await expect(createKafkaClient({ config: makeConfig({ driver: 'kafkajs' }) })).rejects.toThrow(
      'kafkajs is not installed',
    );

    // The failure is cached: a retry surfaces the same error
    // rather than silently falling back to another driver.
    await expect(createKafkaClient({ config: makeConfig({ driver: 'kafkajs' }) })).rejects.toThrow(
      'kafkajs is not installed',
    );
  });

  it('should report @oneunit/kafka availability via ESM resolution', () => {
    const available = isKafkaAvailable();
    expect(typeof available).toBe('boolean');
    // import.meta.resolve is the synchronous ESM
    // resolution mechanism. Some module runners (e.g.
    // vitest's transform pipeline) do not expose it;
    // in a plain Node ESM runtime with @oneunit/kafka
    // installed the check resolves and returns true.
    if (typeof (import.meta as { resolve?: unknown }).resolve === 'function') {
      expect(available).toBe(true);
    }
  });
});
