import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const { mockConnect, connections, channels } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  connections: [] as any[],
  channels: [] as any[],
}));

vi.mock('amqplib', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
}));

import { RabbitMQTransport } from '../../src/adapters/messaging/rabbitmq/adapter.js';
import { RabbitMQClient } from '../../src/adapters/messaging/rabbitmq/rabbitmq-client.js';
import type { RabbitMQAdapterConfig } from '../../src/adapters/messaging/rabbitmq/types.js';

function makeChannel() {
  const ch = new EventEmitter();
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

function makeConnection() {
  const conn = new EventEmitter();
  (conn as any).createChannel = vi.fn().mockImplementation(makeChannel);
  (conn as any).close = vi.fn().mockImplementation(async () => {
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
    durable: true,
    autoDelete: false,
    exclusive: false,
    noAck: false,
    ...overrides,
  };
}

beforeEach(() => {
  connections.length = 0;
  channels.length = 0;
  mockConnect.mockReset();
  mockConnect.mockImplementation(makeConnection);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RabbitMQ Transport - Stress / Edge Cases', () => {

  describe('connection state machine & reconnection', () => {
    it('RECONSTRUCT-AFTER-CLOSE: graceful disconnect triggers an unscheduled reconnect timer that is never cleared', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig());
      await t.start();
      expect(mockConnect).toHaveBeenCalledTimes(1);

      expect((t as any).reconnectTimer).toBeNull();

      await t.disconnect();

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect((t as any).reconnectAttempts).toBe(0);
      expect((t as any).reconnectTimer).toBeNull();

      await vi.advanceTimersByTimeAsync(200);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('DOUBLE-TRIGGER: connection "error" + "close" both schedule reconnects, doubling the attempt counter', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig());
      await t.start();
      const conn = connections[connections.length - 1];

      conn.emit('error', new Error('peer refused'));
      conn.emit('close');

      expect((t as any).reconnectAttempts).toBe(1);
      vi.clearAllTimers();
    });

    it('CONCURRENT-CONNECT-RACE: publish() during a reconnect window starts a second concurrent connection attempt', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig());
      await t.start();
      const ch = channels[channels.length - 1];

      // Broker drops the channel -> scheduled reconnect in 100ms
      ch.emit('close');
      expect(mockConnect).toHaveBeenCalledTimes(1);

      // Publish immediately. connect() is called synchronously and,
      // because isConnecting===false and isConnected===false, begins a
      // NEW establishConnection() instead of waiting.
      const p = t.publish('topic.orders', { orderId: 1 });
      await Promise.resolve();
      expect(mockConnect).toHaveBeenCalledTimes(2);
      await p;
      expect(mockConnect).toHaveBeenCalledTimes(2);
      vi.clearAllTimers();
    });

    it('RECONNECT-EXHAUST: after maxRetries the transport never recovers and stays null', async () => {
      vi.useFakeTimers();
      mockConnect.mockRejectedValue(new Error('boom'));
      const t = new RabbitMQTransport(baseConfig({ maxRetries: 2, reconnectDelay: 50 }));
      await expect(t.start()).rejects.toThrow('boom');

      vi.clearAllTimers();
    });
  });

  describe('publish()', () => {
    it('PUBLISH-NO-BUFFER: a publish that cannot reconnect propagates a hard error instead of buffering the message', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig());
      await t.start();
      await t.disconnect();

      // Broker stays unavailable: every connect attempt rejects.
      mockConnect.mockRejectedValue(new Error('connection refused'));

      await expect(t.publish('topic', { a: 1 })).rejects.toThrow(/closed|connection refused/);

      vi.clearAllTimers();
    });

    it('PUBLISH-BACKPRESSURE: when channel.publish returns false the message is reported as "failed" with no retry', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig());
      await t.start();
      const ch = channels[channels.length - 1];
      ch.publish.mockReturnValue(false);

      await vi.advanceTimersByTimeAsync(0);
      await expect(t.publish('topic', { a: 1 })).rejects.toThrow('Failed to publish');
    });

    it('PUBLISH-CIRCULAR: circular payloads throw synchronously-derived error from JSON.stringify', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig());
      await t.start();
      const circular: any = { a: 1 };
      circular.self = circular;
      await expect(t.publish('topic', circular)).rejects.toThrow();
    });

    it('PUBLISH-NO-CONFIRM: channel.publish success is treated as durable delivery even though amqplib is not in confirm mode', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig());
      await t.start();
      const conn = connections[connections.length - 1] as any;
      const ch = channels[channels.length - 1];

      expect(conn.createChannel).toHaveBeenCalled();
      // No confirm-channel is ever created -> publish() has no delivery
      // acknowledgement from the broker (channel.publish returns only a
      // local write-buffer signal, not a broker ack).
      expect(conn.createConfirmChannel).toBeUndefined();
      expect(ch.waitForConfirms).toBeUndefined();

      ch.publish.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(0);
      await t.publish('topic', { a: 1 }, { headers: { 'x-trace': 'abc' } });
      const publishCall = ch.publish.mock.calls[0];
      expect(publishCall[0]).toBe('test.exchange');
      expect(publishCall[3]).toMatchObject({ persistent: true, headers: { 'x-trace': 'abc' } });
    });
  });

  describe('subscribe() / consume loop', () => {
    it('POISON-LOOP: malformed JSON is nacked with requeue=true with no retry limit (infinite redelivery)', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig());
      await t.start();
      const ch = channels[channels.length - 1];

      await t.subscribe('topic', vi.fn());
      const consumeArg = ch.consume.mock.calls[0][1] as (msg: any) => Promise<void>;
      const badMsg = {
        content: Buffer.from('<<<not json>>>', 'utf8'),
        fields: { routingKey: 'topic' },
        properties: { headers: undefined },
      } as any;

      for (let i = 0; i < 5; i++) {
        await consumeArg(badMsg);
      }
      expect(ch.nack).toHaveBeenCalledTimes(5);
      // With retry limit, messages are dead-lettered after max attempts
      expect(ch.nack).toHaveBeenLastCalledWith(badMsg, false, false);
    });

    it('POISON-LOOP-HANDLER: handler rejection nacks with requeue=true (no DLQ / retry ceiling)', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig());
      await t.start();
      const ch = channels[channels.length - 1];

      const handler = vi.fn().mockRejectedValue(new Error('boom'));
      await t.subscribe('topic', handler);
      const consumeArg = ch.consume.mock.calls[0][1] as (msg: any) => Promise<void>;
      const msg = {
        content: Buffer.from(JSON.stringify({ ok: true }), 'utf8'),
        fields: { routingKey: 'topic' },
        properties: { headers: { 'x': 'y' } },
      } as any;

      for (let i = 0; i < 4; i++) {
        await consumeArg(msg);
      }
      expect(ch.nack).toHaveBeenCalledTimes(4);
      expect(ch.nack).toHaveBeenLastCalledWith(msg, false, false);
      expect(ch.ack).not.toHaveBeenCalled();
    });

    it('ACK-BRANCH: with noAck=true (autoAck) no ack/nack is ever emitted', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig({ noAck: true }));
      await t.start();
      const ch = channels[channels.length - 1];

      const handler = vi.fn().mockResolvedValue(undefined);
      await t.subscribe('topic', handler);
      const consumeArg = ch.consume.mock.calls[0][1] as (msg: any) => Promise<void>;
      const msg = {
        content: Buffer.from(JSON.stringify({ ok: true }), 'utf8'),
        fields: { routingKey: 'topic' },
        properties: { headers: { 'x': 'y' } },
      } as any;

      await consumeArg(msg);
      expect(ch.ack).not.toHaveBeenCalled();
      expect(ch.nack).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('DUPLICATE-SUBSCRIBE: re-subscribing to the same topic creates a second consumer that is orphaned after unsubscribe', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig());
      await t.start();
      const ch = channels[channels.length - 1];
      // Make consume return distinct tags
      ch.consume.mockResolvedValueOnce({ consumerTag: 'tag-A' });
      ch.consume.mockResolvedValueOnce({ consumerTag: 'tag-B' });

      await t.subscribe('topic', vi.fn());
      await t.subscribe('topic', vi.fn());

      expect(ch.consume).toHaveBeenCalledTimes(2);
      expect((t as any).subscriptions.size).toBe(1);
      expect((t as any).subscriptions.get('q.topic')).toBeDefined();
    });

    it('UNSUBSCRIBE-BY-QUEUE-NAME: unsubscribe cancels using the queue name (not the consumerTag), so cancel is a no-op against the broker', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig());
      await t.start();
      const ch = channels[channels.length - 1];

      await t.subscribe('topic', vi.fn());
      expect(ch.consume).toHaveBeenCalledTimes(1);

      await t.unsubscribe('topic');

      expect(ch.cancel).toHaveBeenCalledWith('consumer-tag-1');
    });

    it('UNSUBSCRIBE-SUBSTRING: unsubscribe("a") cancels the first queue whose name merely contains "a", not necessarily the intended one', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig({ defaultQueue: 'q' }));
      await t.start();
      const ch = channels[channels.length - 1];

      await t.subscribe('a.b', vi.fn()); // queue key: "q.a.b"
      await t.subscribe('a', vi.fn());   // queue key: "q.a"

      await t.unsubscribe('a');
      expect(ch.cancel).toHaveBeenCalledWith('consumer-tag-1');
    });

    it('UNSUBSCRIBE-MISSING: unsubscribe for a topic with no matching queue is a silent no-op (no error surfaced)', async () => {
      vi.useFakeTimers();
      const t = new RabbitMQTransport(baseConfig());
      await t.start();
      const ch = channels[channels.length - 1];

      await expect(t.unsubscribe('does-not-exist')).resolves.toBeUndefined();
      expect(ch.cancel).not.toHaveBeenCalled();
    });
  });
});

describe('RabbitMQClient (standalone) - Stress / Edge Cases', () => {
  beforeEach(() => {
    connections.length = 0;
    channels.length = 0;
    mockConnect.mockReset();
    mockConnect.mockImplementation(makeConnection);
  });

  it('CLIENT-CLOSE-CANCELS-TIMER: unlike the transport, the client stores & clears the reconnect timer on close', async () => {
    vi.useFakeTimers();
    const client = new RabbitMQClient({ url: 'amqp://x', queueName: 'q', reconnectDelay: 100, maxRetries: 10 });
    await client.connect();
    const conn = connections[connections.length - 1];

    conn.emit('close');
    expect(client.isConnected()).toBe(false);
    // client does hold a reconnectTimer ref, unlike RabbitMQTransport
    expect((client as any).reconnectTimer).not.toBeNull();

    await client.close();
    expect((client as any).reconnectTimer).toBeNull();
  });

  it('CLIENT-RECONNECT-AFTER-CLOSE: but a close event emitted by the broker still races with close()', async () => {
    vi.useFakeTimers();
    const client = new RabbitMQClient({ url: 'amqp://x', queueName: 'q', reconnectDelay: 50, maxRetries: 10 });
    await client.connect();

    // Simulate broker closing the connection; client schedules reconnect.
    const conn = connections[connections.length - 1];
    conn.emit('close');

    // Now close() is called while a reconnect is pending.
    await client.close();

    // The pending reconnect timer must not fire a new connection attempt
    vi.clearAllTimers();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});
