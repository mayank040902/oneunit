import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KafkaAdapterConfig } from '../../../../../src/adapters/messaging/kafka/types.js';
import { KafkaDriverAdapter } from '../../../../../src/adapters/messaging/kafka/types.js';

// Create mock functions
const mockGetProducer = vi.fn();
const mockConsume = vi.fn();
const mockDisconnect = vi.fn();
const mockCreateKafkaClient = vi.fn();

// Mock the module
vi.mock('@oneunit/kafka', () => ({
  createKafkaClient: mockCreateKafkaClient,
  KafkaClient: vi.fn(),
}));

// Import after mocking
const { createKafkaAdapter } = await import('../../../../../src/adapters/messaging/kafka/oneunit/adapter.js');

function makeConfig(overrides: Partial<KafkaAdapterConfig> = {}): KafkaAdapterConfig {
  return {
    brokers: ['localhost:9092'],
    clientId: 'test-client',
    topics: { prefix: 'oneunit' },
    producer: {},
    consumer: {},
    ...overrides,
  };
}

describe('OneUnit Kafka Driver Adapter', () => {
  let adapter: KafkaDriverAdapter;
  let mockClient: any;
  let mockProducer: any;
  let mockConsumer: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProducer = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    mockConsumer = {
      disconnect: vi.fn().mockResolvedValue(undefined),
    };

    mockClient = {
      getProducer: mockGetProducer.mockResolvedValue(mockProducer),
      consume: mockConsume.mockResolvedValue(mockConsumer),
      disconnect: mockDisconnect.mockResolvedValue(undefined),
    };

    mockCreateKafkaClient.mockResolvedValue(mockClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create adapter with correct capabilities', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    expect(adapter.name).toBe('kafka');
    expect(adapter.capabilities.requestResponse).toBe(false);
    expect(adapter.capabilities.publishSubscribe).toBe(true);
    expect(adapter.capabilities.durableDelivery).toBe(true);
    expect(adapter.capabilities.orderedDelivery).toBe(true);
    expect(adapter.capabilities.bidirectional).toBe(false);
  });

  it('should initialize client and producer on creation', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);

    expect(mockCreateKafkaClient).toHaveBeenCalledWith({
      brokers: ['localhost:9092'],
      clientId: 'test-client',
      ssl: undefined,
      sasl: undefined,
    });
    expect(mockGetProducer).toHaveBeenCalledWith({});
  });

  it('should pass security config to client', async () => {
    adapter = await createKafkaAdapter(makeConfig({
      security: {
        ssl: true,
        sasl: {
          mechanism: 'scram-sha-256',
          username: 'user',
          password: 'pass',
        },
      },
    }), (await import('@oneunit/kafka')) as any);

    expect(mockCreateKafkaClient).toHaveBeenCalledWith({
      brokers: ['localhost:9092'],
      clientId: 'test-client',
      ssl: true,
      sasl: {
        mechanism: 'scram-sha-256',
        username: 'user',
        password: 'pass',
      },
    });
  });

  it('should pass producer config to getProducer', async () => {
    adapter = await createKafkaAdapter(makeConfig({ producer: { acks: 'all' } }), (await import('@oneunit/kafka')) as any);

    expect(mockGetProducer).toHaveBeenCalledWith({ acks: 'all' });
  });

  it('should start without additional work (already initialized)', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();

    // start() is a no-op for oneunit driver
    expect(adapter).toBeDefined();
  });

  it('should disconnect client and consumers on close', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();
    await adapter.subscribe('topic1', vi.fn());
    await adapter.subscribe('topic2', vi.fn());
    await adapter.close();

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockConsumer.disconnect).toHaveBeenCalledTimes(2);
  });

  it('should clear consumers map on close', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();
    await adapter.subscribe('topic1', vi.fn());
    await adapter.close();
    await adapter.close(); // Second close calls disconnect again (idempotent in terms of consumers)

    // Both closes call client.disconnect()
    expect(mockDisconnect).toHaveBeenCalledTimes(2);
    // But consumer disconnect only happens once per consumer
    expect(mockConsumer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('should report healthy after initialization', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();
    const health = await adapter.healthCheck();

    expect(health.status).toBe('healthy');
    expect(health.details).toEqual({ connected: true, driver: 'oneunit' });
  });

  it('should publish message with topic prefix', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();

    await adapter.publish('test-topic', { key: 'value' }, { key: 'message-key' });

    expect(mockProducer.send).toHaveBeenCalledWith('oneunit.test-topic', { key: 'value' }, {
      send: {
        key: 'message-key',
        headers: undefined,
      },
    });
  });

  it('should publish message with headers', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();

    await adapter.publish('test-topic', { key: 'value' }, { headers: { 'correlation-id': '123' } });

    expect(mockProducer.send).toHaveBeenCalledWith('oneunit.test-topic', { key: 'value' }, {
      send: {
        key: undefined,
        headers: { 'correlation-id': '123' },
      },
    });
  });

  it('should publish without requiring explicit start (initialized in constructor)', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    // OneUnit adapter initializes producer in constructor, no start() needed
    await adapter.publish('test-topic', { key: 'value' });

    expect(mockProducer.send).toHaveBeenCalledWith('oneunit.test-topic', { key: 'value' }, {
      send: {
        key: undefined,
        headers: undefined,
      },
    });
  });

  it('should create consumer with groupId on subscribe', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();

    const handler = vi.fn();
    await adapter.subscribe('test-topic', handler, { groupId: 'custom-group' });

    expect(mockConsume).toHaveBeenCalledWith(
      'oneunit.test-topic',
      expect.any(Function),
      { groupId: 'custom-group' }
    );
  });

  it('should use default groupId when not provided', async () => {
    adapter = await createKafkaAdapter(makeConfig({ clientId: 'my-client' }), (await import('@oneunit/kafka')) as any);
    await adapter.start();

    await adapter.subscribe('test-topic', vi.fn());

    expect(mockConsume).toHaveBeenCalledWith(
      'oneunit.test-topic',
      expect.any(Function),
      { groupId: 'my-client-test-topic' }
    );
  });

  it('should call handler with message value and context', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();

    const handler = vi.fn();
    await adapter.subscribe('test-topic', handler);

    // Get the handler passed to consume
    const consumeCall = mockConsume.mock.calls[0];
    const payloadHandler = consumeCall[1];

    const mockPayload = {
      topic: 'oneunit.test-topic',
      partition: 0,
      offset: '123',
      message: {
        value: { data: 'test' },
        headers: { 'correlation-id': 'abc' },
      },
      ack: vi.fn().mockResolvedValue(undefined),
      nak: vi.fn().mockResolvedValue(undefined),
    };

    await payloadHandler(mockPayload);

    expect(handler).toHaveBeenCalledWith(
      { data: 'test' },
      expect.objectContaining({
        topic: 'oneunit.test-topic',
        partition: 0,
        offset: '123',
        headers: { 'correlation-id': 'abc' },
      })
    );
  });

  it('should call ack when autoAck is false and handler succeeds', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();

    const handler = vi.fn().mockResolvedValue(undefined);
    await adapter.subscribe('test-topic', handler, { autoAck: false });

    const consumeCall = mockConsume.mock.calls[0];
    const payloadHandler = consumeCall[1];

    const mockPayload = {
      topic: 'oneunit.test-topic',
      partition: 0,
      offset: '123',
      message: { value: { data: 'test' }, headers: {} },
      ack: vi.fn().mockResolvedValue(undefined),
      nak: vi.fn().mockResolvedValue(undefined),
    };

    await payloadHandler(mockPayload);

    expect(mockPayload.ack).toHaveBeenCalledTimes(1);
    expect(mockPayload.nak).not.toHaveBeenCalled();
  });

  it('should call nak when autoAck is false and handler throws', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();

    const handler = vi.fn().mockRejectedValue(new Error('Handler error'));
    await adapter.subscribe('test-topic', handler, { autoAck: false });

    const consumeCall = mockConsume.mock.calls[0];
    const payloadHandler = consumeCall[1];

    const mockPayload = {
      topic: 'oneunit.test-topic',
      partition: 0,
      offset: '123',
      message: { value: { data: 'test' }, headers: {} },
      ack: vi.fn().mockResolvedValue(undefined),
      nak: vi.fn().mockResolvedValue(undefined),
    };

    await payloadHandler(mockPayload);

    expect(mockPayload.nak).toHaveBeenCalledTimes(1);
    expect(mockPayload.ack).not.toHaveBeenCalled();
  });

  it('should not call ack/nak when autoAck is true', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();

    const handler = vi.fn().mockResolvedValue(undefined);
    await adapter.subscribe('test-topic', handler, { autoAck: true });

    const consumeCall = mockConsume.mock.calls[0];
    const payloadHandler = consumeCall[1];

    const mockPayload = {
      topic: 'oneunit.test-topic',
      partition: 0,
      offset: '123',
      message: { value: { data: 'test' }, headers: {} },
      ack: vi.fn().mockResolvedValue(undefined),
      nak: vi.fn().mockResolvedValue(undefined),
    };

    await payloadHandler(mockPayload);

    expect(mockPayload.ack).not.toHaveBeenCalled();
    expect(mockPayload.nak).not.toHaveBeenCalled();
  });

  it('should store consumer for later unsubscription', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();

    await adapter.subscribe('test-topic', vi.fn());
    
    await adapter.unsubscribe('test-topic');

    expect(mockConsumer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('should handle unsubscribe of non-existent topic gracefully', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();

    await expect(adapter.unsubscribe('non-existent')).resolves.toBeUndefined();
  });

  it('should handle handler errors without crashing', async () => {
    adapter = await createKafkaAdapter(makeConfig(), (await import('@oneunit/kafka')) as any);
    await adapter.start();

    const handler = vi.fn().mockRejectedValue(new Error('Handler error'));
    await adapter.subscribe('test-topic', handler, { autoAck: false });

    const consumeCall = mockConsume.mock.calls[0];
    const payloadHandler = consumeCall[1];

    const mockPayload = {
      topic: 'oneunit.test-topic',
      partition: 0,
      offset: '123',
      message: { value: { data: 'test' }, headers: {} },
      ack: vi.fn().mockResolvedValue(undefined),
      nak: vi.fn().mockResolvedValue(undefined),
    };

    // Should not throw
    await expect(payloadHandler(mockPayload)).resolves.toBeUndefined();
    expect(mockPayload.nak).toHaveBeenCalledTimes(1);
  });
});