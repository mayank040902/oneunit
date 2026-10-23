import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const { mockConnect, connections, channels } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  connections: [] as EventEmitter[],
  channels: [] as EventEmitter[],
}));

vi.mock('amqplib', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
}));

import { RabbitMQTransport } from '../../../src/adapters/messaging/rabbitmq/adapter.js';
import { RabbitMQClient } from '../../../src/adapters/messaging/rabbitmq/rabbitmq-client.js';
import type { RabbitMQAdapterConfig } from '../../../src/adapters/messaging/rabbitmq/types.js';

type AmqpChannelMock = EventEmitter & {
  prefetch: ReturnType<typeof vi.fn>;
  assertExchange: ReturnType<typeof vi.fn>;
  assertQueue: ReturnType<typeof vi.fn>;
  bindQueue: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  consume: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  ack: ReturnType<typeof vi.fn>;
  nack: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

type AmqpConnectionMock = EventEmitter & {
  createChannel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function makeChannel(): AmqpChannelMock {
  const ch = new EventEmitter() as AmqpChannelMock;
  ch.prefetch = vi.fn().mockResolvedValue(undefined);
  ch.assertExchange = vi.fn().mockResolvedValue(undefined);
  ch.assertQueue = vi.fn().mockResolvedValue(undefined);
  ch.bindQueue = vi.fn().mockResolvedValue(undefined);
  ch.publish = vi.fn().mockReturnValue(true);
  ch.consume = vi.fn().mockResolvedValue({ consumerTag: 'consumer-tag-1' });
  ch.cancel = vi.fn().mockResolvedValue(undefined);
  ch.ack = vi.fn();
  ch.nack = vi.fn();
  ch.close = vi.fn().mockImplementation(async () => {
    ch.emit('close');
    return undefined;
  });
  channels.push(ch);
  return ch;
}

function makeConnection(): AmqpConnectionMock {
  const conn = new EventEmitter() as AmqpConnectionMock;
  conn.createChannel = vi.fn().mockImplementation(async () => makeChannel());
  conn.close = vi.fn().mockImplementation(async () => {
    conn.emit('close');
    return undefined;
  });
  connections.push(conn);
  return conn;
}

function baseConfig(overrides: Partial<RabbitMQAdapterConfig> = {}): RabbitMQAdapterConfig {
  return {
    url: 'amqp://localhost:5672',
    exchangeName: 'test.exchange',
    defaultQueue: 'q',
    prefetch: 10,
    reconnectDelay: 100,
    maxRetries: 10,
    maxAttempts: 3,
    durable: true,
    autoDelete: false,
    exclusive: false,
    noAck: false,
    ...overrides,
  };
}

function lastChannel(): AmqpChannelMock {
  return channels[channels.length - 1] as AmqpChannelMock;
}

function lastConnection(): AmqpConnectionMock {
  return connections[connections.length - 1] as AmqpConnectionMock;
}

function makeMessage(body: string, routingKey = 'topic'): {
  content: Buffer;
  fields: { routingKey: string; deliveryTag: bigint; redelivered: boolean };
  properties: { headers?: Record<string, unknown> };
} {
  return {
    content: Buffer.from(body, 'utf8'),
    fields: { routingKey, deliveryTag: 1n, redelivered: false },
    properties: { headers: undefined },
  };
}

beforeEach(() => {
  connections.length = 0;
  channels.length = 0;
  mockConnect.mockReset();
  mockConnect.mockImplementation(async () => makeConnection());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RabbitMQTransport connection handling', () => {
  it('should connect once when it is started', async () => {
    const transport = new RabbitMQTransport(baseConfig());

    await transport.start();

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(transport.isConnected()).toBe(true);
  });

  it('should not reconnect after a graceful disconnect', async () => {
    vi.useFakeTimers();
    const transport = new RabbitMQTransport(baseConfig());
    await transport.start();

    await transport.disconnect();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(transport.isConnected()).toBe(false);
  });

  it('should report unhealthy when the broker connection is lost', async () => {
    const transport = new RabbitMQTransport(baseConfig());
    await transport.start();

    lastConnection().emit('close');

    expect(transport.isConnected()).toBe(false);
    const health = await transport.healthCheck();
    expect(health.status).toBe('unhealthy');
  });

  it('should reject the start when the broker is unreachable', async () => {
    mockConnect.mockRejectedValue(new Error('connection refused'));

    const transport = new RabbitMQTransport(baseConfig());

    await expect(transport.start()).rejects.toThrow('connection refused');
  });
});

describe('RabbitMQTransport.publish', () => {
  it('should publish a JSON payload to the configured exchange', async () => {
    const transport = new RabbitMQTransport(baseConfig());
    await transport.start();

    await transport.publish('orders', { id: 1 });

    const [exchange, routingKey, content, options] = lastChannel().publish.mock.calls[0]!;
    expect(exchange).toBe('test.exchange');
    expect(routingKey).toBe('orders');
    expect(JSON.parse(content.toString())).toEqual({ id: 1 });
    expect(options).toMatchObject({ persistent: true });
  });

  it('should forward the publish headers to the broker', async () => {
    const transport = new RabbitMQTransport(baseConfig());
    await transport.start();

    await transport.publish('orders', { id: 1 }, { headers: { 'x-trace': 'abc' } });

    const options = lastChannel().publish.mock.calls[0]![3];
    expect(options).toMatchObject({ headers: { 'x-trace': 'abc' } });
  });

  it('should fail the publish when the broker write buffer is full', async () => {
    const transport = new RabbitMQTransport(baseConfig());
    await transport.start();
    lastChannel().publish.mockReturnValue(false);

    await expect(transport.publish('orders', { id: 1 })).rejects.toThrow(/Failed to publish/);
  });

  it('should fail the publish when the payload cannot be serialized', async () => {
    const transport = new RabbitMQTransport(baseConfig());
    await transport.start();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    await expect(transport.publish('orders', circular)).rejects.toThrow();
  });

  it('should fail the publish when the transport was disconnected', async () => {
    const transport = new RabbitMQTransport(baseConfig());
    await transport.start();
    await transport.disconnect();
    mockConnect.mockRejectedValue(new Error('connection refused'));

    await expect(transport.publish('orders', { id: 1 })).rejects.toThrow();
  });
});

describe('RabbitMQTransport.subscribe', () => {
  it('should deliver a parsed message to the handler', async () => {
    const transport = new RabbitMQTransport(baseConfig());
    await transport.start();
    const handler = vi.fn().mockResolvedValue(undefined);
    await transport.subscribe('orders', handler);

    const consume = lastChannel().consume.mock.calls[0]![1] as (msg: unknown) => Promise<void>;
    await consume(makeMessage(JSON.stringify({ id: 7 }), 'orders'));

    expect(handler).toHaveBeenCalledWith({ id: 7 }, expect.objectContaining({ topic: 'orders' }));
    expect(lastChannel().ack).toHaveBeenCalledTimes(1);
  });

  it('should requeue the message when the handler rejects', async () => {
    const transport = new RabbitMQTransport(baseConfig());
    await transport.start();
    await transport.subscribe('orders', vi.fn().mockRejectedValue(new Error('boom')));

    const consume = lastChannel().consume.mock.calls[0]![1] as (msg: unknown) => Promise<void>;
    const message = makeMessage(JSON.stringify({ id: 7 }));
    await consume(message);

    expect(lastChannel().nack).toHaveBeenCalledWith(message, false, true);
    expect(lastChannel().ack).not.toHaveBeenCalled();
  });

  it('should dead-letter the message when the retry limit is reached', async () => {
    const transport = new RabbitMQTransport(baseConfig({ maxAttempts: 2 }));
    await transport.start();
    await transport.subscribe('orders', vi.fn().mockRejectedValue(new Error('boom')));

    const consume = lastChannel().consume.mock.calls[0]![1] as (msg: unknown) => Promise<void>;
    const message = makeMessage(JSON.stringify({ id: 7 }));
    await consume(message);
    await consume(message);

    expect(lastChannel().nack).toHaveBeenLastCalledWith(message, false, false);
  });

  it('should dead-letter a message that is not valid JSON', async () => {
    const transport = new RabbitMQTransport(baseConfig({ maxAttempts: 1 }));
    await transport.start();
    await transport.subscribe('orders', vi.fn());

    const consume = lastChannel().consume.mock.calls[0]![1] as (msg: unknown) => Promise<void>;
    const message = makeMessage('<<<not json>>>');
    await consume(message);

    expect(lastChannel().nack).toHaveBeenCalledWith(message, false, false);
  });

  it('should not ack or nack when auto-ack is enabled', async () => {
    const transport = new RabbitMQTransport(baseConfig({ noAck: true }));
    await transport.start();
    const handler = vi.fn().mockResolvedValue(undefined);
    await transport.subscribe('orders', handler);

    const consume = lastChannel().consume.mock.calls[0]![1] as (msg: unknown) => Promise<void>;
    await consume(makeMessage(JSON.stringify({ id: 7 })));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(lastChannel().ack).not.toHaveBeenCalled();
    expect(lastChannel().nack).not.toHaveBeenCalled();
  });

  it('should replace the previous consumer when the same topic is subscribed twice', async () => {
    const transport = new RabbitMQTransport(baseConfig());
    await transport.start();
    lastChannel().consume.mockResolvedValueOnce({ consumerTag: 'tag-a' });
    lastChannel().consume.mockResolvedValueOnce({ consumerTag: 'tag-b' });

    await transport.subscribe('orders', vi.fn());
    await transport.subscribe('orders', vi.fn());

    expect(lastChannel().cancel).toHaveBeenCalledWith('tag-a');
  });
});

describe('RabbitMQTransport.unsubscribe', () => {
  it('should cancel the consumer of the subscribed topic', async () => {
    const transport = new RabbitMQTransport(baseConfig());
    await transport.start();
    await transport.subscribe('orders', vi.fn());

    await transport.unsubscribe('orders');

    expect(lastChannel().cancel).toHaveBeenCalledWith('consumer-tag-1');
  });

  it('should not cancel any consumer when the topic was never subscribed', async () => {
    const transport = new RabbitMQTransport(baseConfig());
    await transport.start();
    await transport.subscribe('orders', vi.fn());

    await expect(transport.unsubscribe('unknown')).resolves.toBeUndefined();

    expect(lastChannel().cancel).not.toHaveBeenCalled();
  });
});

describe('RabbitMQClient', () => {
  it('should clear the pending reconnect when it is closed', async () => {
    vi.useFakeTimers();
    const client = new RabbitMQClient({ url: 'amqp://x', queueName: 'q', reconnectDelay: 100, maxRetries: 10 });
    await client.connect();

    lastConnection().emit('close');
    expect(client.isConnected()).toBe(false);

    await client.close();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('should report connected after a successful connect', async () => {
    const client = new RabbitMQClient({ url: 'amqp://x', queueName: 'q' });

    await client.connect();

    expect(client.isConnected()).toBe(true);
  });
});
