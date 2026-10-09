import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KafkaAdapterConfig } from '../../../../../src/adapters/messaging/kafka/types.js';
import { KafkaDriverAdapter } from '../../../../../src/adapters/messaging/kafka/types.js';

// Mock kafkajs at the top level
const mockProducer = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
};

const mockConsumer = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn().mockResolvedValue(undefined),
  run: vi.fn().mockResolvedValue(undefined),
};

const mockKafka = {
  producer: vi.fn(() => mockProducer),
  consumer: vi.fn(() => mockConsumer),
};

vi.mock('kafkajs', () => ({
  Kafka: vi.fn(() => mockKafka),
}));

// Import after mocking
const { createKafkaAdapter } = await import('../../../../../src/adapters/messaging/kafka/kafkajs/adapter.js');

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

describe('KafkaJS Driver Adapter', () => {
  let adapter: KafkaDriverAdapter;
  let mockConsumers: Map<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConsumers = new Map();
    (mockKafka.producer as any).mockClear();
    (mockKafka.consumer as any).mockClear();
    mockProducer.connect.mockClear();
    mockProducer.disconnect.mockClear();
    mockProducer.send.mockClear();
    mockConsumer.connect.mockClear();
    mockConsumer.disconnect.mockClear();
    mockConsumer.subscribe.mockClear();
    mockConsumer.run.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create adapter with correct capabilities', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    expect(adapter.name).toBe('kafka');
    expect(adapter.capabilities.requestResponse).toBe(false);
    expect(adapter.capabilities.publishSubscribe).toBe(true);
    expect(adapter.capabilities.durableDelivery).toBe(true);
    expect(adapter.capabilities.orderedDelivery).toBe(true);
    expect(adapter.capabilities.bidirectional).toBe(false);
  });

  it('should initialize producer on start', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();

    expect(mockKafka.producer).toHaveBeenCalled();
    expect(mockProducer.connect).toHaveBeenCalled();
  });

  it('should connect producer with config', async () => {
    adapter = await createKafkaAdapter(makeConfig({ producer: { allowAutoCreateTopics: true } }));
    await adapter.start();

    expect(mockKafka.producer).toHaveBeenCalledWith({ allowAutoCreateTopics: true });
  });

  it('should configure SSL when security.ssl is enabled', async () => {
    adapter = await createKafkaAdapter(makeConfig({
      security: { ssl: true },
    }));
    await adapter.start();

    // The Kafka constructor should receive ssl: true
    const kafkaConstructor = (await import('kafkajs')).Kafka;
    expect(kafkaConstructor).toHaveBeenCalledWith(expect.objectContaining({
      ssl: true,
    }));
  });

  it('should configure SASL when security.sasl is provided', async () => {
    adapter = await createKafkaAdapter(makeConfig({
      security: {
        sasl: {
          mechanism: 'scram-sha-256',
          username: 'user',
          password: 'pass',
        },
      },
    }));
    await adapter.start();

    const kafkaConstructor = (await import('kafkajs')).Kafka;
    expect(kafkaConstructor).toHaveBeenCalledWith(expect.objectContaining({
      sasl: {
        mechanism: 'scram-sha-256',
        username: 'user',
        password: 'pass',
      },
    }));
  });

  it('should disconnect producer on close', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();
    await adapter.close();

    expect(mockProducer.disconnect).toHaveBeenCalled();
  });

  it('should disconnect all consumers on close', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();
    await adapter.subscribe('topic1', vi.fn());
    await adapter.subscribe('topic2', vi.fn());
    await adapter.close();

    expect(mockConsumer.disconnect).toHaveBeenCalledTimes(2);
  });

  it('should clear consumers map on close', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();
    await adapter.subscribe('topic1', vi.fn());
    await adapter.close();
    await adapter.close(); // Second close should be safe

    expect(mockProducer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('should report healthy when producer is connected', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();
    const health = await adapter.healthCheck();

    expect(health.status).toBe('healthy');
    expect(health.details).toEqual({ connected: true, driver: 'kafkajs' });
  });

  it('should report unhealthy when producer not connected', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    const health = await adapter.healthCheck();

    expect(health.status).toBe('unhealthy');
    expect(health.details).toEqual({ connected: false, driver: 'kafkajs' });
  });

  it('should publish message with topic prefix', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();

    await adapter.publish('test-topic', { key: 'value' }, { key: 'message-key' });

    expect(mockProducer.send).toHaveBeenCalledWith({
      topic: 'oneunit.test-topic',
      messages: [{
        key: 'message-key',
        value: JSON.stringify({ key: 'value' }),
        headers: undefined,
      }],
    });
  });

  it('should publish message with headers', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();

    await adapter.publish('test-topic', { key: 'value' }, { headers: { 'correlation-id': '123' } });

    expect(mockProducer.send).toHaveBeenCalledWith({
      topic: 'oneunit.test-topic',
      messages: [{
        key: undefined,
        value: JSON.stringify({ key: 'value' }),
        headers: { 'correlation-id': '123' },
      }],
    });
  });

  it('should reject publish when not started', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await expect(adapter.publish('topic', {})).rejects.toThrow(/Producer not connected/);
  });

  it('should create consumer with groupId on subscribe', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();

    const handler = vi.fn();
    await adapter.subscribe('test-topic', handler, { groupId: 'custom-group' });

    expect(mockKafka.consumer).toHaveBeenCalledWith({ groupId: 'custom-group' });
    expect(mockConsumer.subscribe).toHaveBeenCalledWith({
      topic: 'oneunit.test-topic',
      fromBeginning: undefined,
    });
  });

  it('should use default groupId when not provided', async () => {
    adapter = await createKafkaAdapter(makeConfig({ clientId: 'my-client' }));
    await adapter.start();

    await adapter.subscribe('test-topic', vi.fn());

    expect(mockKafka.consumer).toHaveBeenCalledWith({ groupId: 'my-client-test-topic' });
  });

  it('should handle fromBeginning option', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();

    await adapter.subscribe('test-topic', vi.fn(), { fromBeginning: true });

    expect(mockConsumer.subscribe).toHaveBeenCalledWith({
      topic: 'oneunit.test-topic',
      fromBeginning: true,
    });
  });

  it('should pass consumer config to consumer', async () => {
    adapter = await createKafkaAdapter(makeConfig({ consumer: { sessionTimeout: 30000 } }));
    await adapter.start();

    await adapter.subscribe('test-topic', vi.fn());

    expect(mockKafka.consumer).toHaveBeenCalledWith(expect.objectContaining({
      sessionTimeout: 30000,
    }));
  });

  it('should call handler with parsed message value and context', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();

    const handler = vi.fn();
    await adapter.subscribe('test-topic', handler);

    // Get the eachMessage callback that was passed to consumer.run
    const runCall = mockConsumer.run.mock.calls[0][0];
    const eachMessage = runCall.eachMessage;

    const mockPayload = {
      topic: 'oneunit.test-topic',
      partition: 0,
      message: {
        value: Buffer.from(JSON.stringify({ data: 'test' })),
        headers: { 'correlation-id': Buffer.from('abc') },
        offset: '123',
      },
    };

    await eachMessage(mockPayload);

    expect(handler).toHaveBeenCalledWith(
      { data: 'test' },
      expect.objectContaining({
        topic: 'oneunit.test-topic',
        partition: 0,
        offset: '123',
        headers: expect.objectContaining({
          'correlation-id': expect.any(Object), // Headers are Buffers in kafkajs
        }),
      })
    );
  });

  it('should handle null message value', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();

    const handler = vi.fn();
    await adapter.subscribe('test-topic', handler);

    const runCall = mockConsumer.run.mock.calls[0][0];
    const eachMessage = runCall.eachMessage;

    const mockPayload = {
      topic: 'oneunit.test-topic',
      partition: 0,
      message: {
        value: null,
        headers: {},
        offset: '123',
      },
    };

    await eachMessage(mockPayload);

    expect(handler).toHaveBeenCalledWith(null, expect.any(Object));
  });

  it('should catch and log handler errors without crashing', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();

    const handler = vi.fn().mockRejectedValue(new Error('Handler error'));
    await adapter.subscribe('test-topic', handler);

    const runCall = mockConsumer.run.mock.calls[0][0];
    const eachMessage = runCall.eachMessage;

    const mockPayload = {
      topic: 'oneunit.test-topic',
      partition: 0,
      message: {
        value: Buffer.from(JSON.stringify({ data: 'test' })),
        headers: {},
        offset: '123',
      },
    };

    // Should not throw
    await expect(eachMessage(mockPayload)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalled();
  });

  it('should store consumer for later unsubscription', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();

    await adapter.subscribe('test-topic', vi.fn());
    
    await adapter.unsubscribe('test-topic');

    expect(mockConsumer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('should handle unsubscribe of non-existent topic gracefully', async () => {
    adapter = await createKafkaAdapter(makeConfig());
    await adapter.start();

    await expect(adapter.unsubscribe('non-existent')).resolves.toBeUndefined();
  });

  it('should include consumer config in subscription', async () => {
    adapter = await createKafkaAdapter(makeConfig({ consumer: { maxWaitTimeInMs: 100 } }));
    await adapter.start();

    await adapter.subscribe('test-topic', vi.fn());

    expect(mockKafka.consumer).toHaveBeenCalledWith(expect.objectContaining({
      maxWaitTimeInMs: 100,
    }));
  });
});