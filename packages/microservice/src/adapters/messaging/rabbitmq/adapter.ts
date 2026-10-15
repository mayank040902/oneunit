import { BaseTransport } from '@/transport/transport.js';
import { TransportHealth, MessagePublisher, MessageSubscriber, PublishOptions, SubscribeOptions, MessageContext } from '@/core/capabilities.js';
import { Logger } from '@/observability/logger.js';
import type { RabbitMQAdapterConfig } from './types.js';

interface AmqpConnection {
  createChannel(): Promise<AmqpChannel>;
  close(): Promise<unknown>;
  on(event: 'error' | 'close' | string, listener: (...args: any[]) => void): this;
  off(event: 'error' | 'close' | string, listener: (...args: any[]) => void): this;
}

interface AmqpChannel {
  prefetch(n: number): Promise<unknown>;
  assertExchange(name: string, type: string, opts?: Record<string, unknown>): Promise<unknown>;
  assertQueue(
    name: string,
    opts?: { durable?: boolean; autoDelete?: boolean; exclusive?: boolean; arguments?: Record<string, unknown> },
  ): Promise<unknown>;
  bindQueue(queue: string, exchange: string, pattern: string): Promise<unknown>;
  publish(exchange: string, key: string, content: Buffer, opts?: Record<string, unknown>): boolean;
  consume(queue: string, handler: (msg: AmqpMsg | null) => void, opts?: Record<string, unknown>): Promise<{ consumerTag: string }>;
  cancel(consumerTag: string): Promise<unknown>;
  ack(msg: AmqpMsg): void;
  nack(msg: AmqpMsg, allUpTo?: boolean, requeue?: boolean): void;
  close(): Promise<unknown>;
  on(event: 'error' | 'close' | string, listener: (...args: any[]) => void): this;
  off(event: 'error' | 'close' | string, listener: (...args: any[]) => void): this;
}

interface AmqpMsg {
  content: Buffer;
  fields: { routingKey: string; deliveryTag: bigint | number; redelivered: boolean; [k: string]: unknown };
  properties: { headers?: Record<string, unknown>; correlationId?: string; replyTo?: string; [k: string]: unknown };
}

interface AmqpModule {
  connect(url: string): Promise<AmqpConnection>;
}

interface SubscriptionEntry {
  handler: (msg: unknown, context: MessageContext) => Promise<void>;
  consumerTag: string;
  options: SubscribeOptions;
}

const AMQP_MISSING =
  "RabbitMQ adapter requires the optional 'amqplib' dependency. Install it with `npm install amqplib` (or `pnpm add amqplib`), or remove the rabbitmq adapter from your configuration.";
const MAX_TRACKED_DELIVERIES = 10000;

function hashBuffer(buf: Buffer): string {
  let h = 0;
  for (let i = 0; i < buf.length; i++) h = ((h * 31 + (buf[i] ?? 0)) | 0) >>> 0;
  return h.toString(36);
}

function deliveryKey(queue: string, msg: AmqpMsg): string {
  const cid = msg.properties?.correlationId;
  if (cid) return `${queue}:${cid}`;
  return `${queue}:#:${hashBuffer(msg.content)}`;
}

export class RabbitMQTransport extends BaseTransport implements MessagePublisher, MessageSubscriber {
  private config: RabbitMQAdapterConfig;
  private logger?: Logger;
  private connection: AmqpConnection | null = null;
  private channel: AmqpChannel | null = null;
  private amqpModule: AmqpModule | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private disconnecting = false;
  private subscriptions: Map<string, SubscriptionEntry> = new Map();
  private deliveryAttempts: Map<string, number> = new Map();

  private detachLifecycle: (() => void) | null = null;

  constructor(config: RabbitMQAdapterConfig, logger?: Logger) {
    super({
      name: 'rabbitmq',
      capabilities: {
        requestResponse: false,
        streaming: false,
        publishSubscribe: true,
        durableDelivery: true,
        orderedDelivery: true,
        bidirectional: false,
      },
    });
    this.config = { ...config, maxAttempts: config.maxAttempts ?? 3 };
    this.logger = logger;
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.connect();
    this.started = true;
  }

  async close(): Promise<void> {
    await this.disconnect();
  }

  private async loadAmqp(): Promise<AmqpModule> {
    if (!this.amqpModule) {
      try {
        this.amqpModule = (await import('amqplib')) as unknown as AmqpModule;
      } catch {
        throw new Error(AMQP_MISSING);
      }
    }
    return this.amqpModule;
  }

  private async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('RabbitMQ transport is closed');
    }
    if (this.isConnected()) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.reconnectTimer) {
      this.clearReconnectTimer();
    }

    const attempt = this.establishAndWatch();
    this.connectPromise = attempt;
    attempt.finally(() => {
      if (this.connectPromise === attempt) {
        this.connectPromise = null;
      }
    });
    return attempt;
  }

  private async establishAndWatch(): Promise<void> {
    const amqp = await this.loadAmqp();
    let connection: AmqpConnection;
    let channel: AmqpChannel;
    try {
      this.logger?.info?.(`Connecting to RabbitMQ at ${this.config.url}...`);
      connection = await amqp.connect(this.config.url);
      channel = await connection.createChannel();

      await channel.prefetch(this.config.prefetch);

      await channel.assertExchange(this.config.exchangeName, 'topic', {
        durable: this.config.durable,
        autoDelete: this.config.autoDelete,
      });

      await channel.assertQueue(this.config.defaultQueue, {
        durable: this.config.durable,
        autoDelete: this.config.autoDelete,
        exclusive: this.config.exclusive,
        arguments: this.dlxArgs(),
      });
      await channel.bindQueue(this.config.defaultQueue, this.config.exchangeName, '#');
    } catch (error) {
      this.logger?.error?.(error as Error, 'Failed to connect to RabbitMQ');
      throw error;
    }

    this.connection = connection;
    this.channel = channel;
    this.reconnectAttempts = 0;
    this.attachLifecycle(connection, channel);
    this.disconnecting = false;
    this.logger?.info?.('RabbitMQ connected successfully');
  }

  private attachLifecycle(connection: AmqpConnection, channel: AmqpChannel): void {
    this.disconnecting = false;
    const onLost = (reason: string) => {
      if (this.disconnecting) return;
      this.disconnecting = true;
      this.logger?.warn?.(`RabbitMQ connection lost: ${reason}`);
      this.handleDisconnect();
    };
    const onClose = () => onLost('connection closed');
    const onError = (err: Error) => onLost(`connection error: ${err?.message ?? err}`);

    connection.on('close', onClose);
    connection.on('error', onError);
    channel.on('close', onClose);
    channel.on('error', onError);

    this.detachLifecycle = () => {
      connection.off('close', onClose);
      connection.off('error', onError);
      channel.off('close', onClose);
      channel.off('error', onError);
    };
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleDisconnect(): void {
    if (this.closed) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }

    this.detachLifecycle?.();
    this.detachLifecycle = null;
    this.connection = null;
    this.channel = null;

    if (this.reconnectAttempts >= this.config.maxRetries) {
      this.logger?.error?.('Max RabbitMQ reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelay * this.reconnectAttempts;
    this.logger?.warn?.(
      `Reconnecting to RabbitMQ in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxRetries})...`,
    );
    this.reconnectTimer = setTimeout(() => {
      if (this.closed) {
        this.reconnectTimer = null;
        return;
      }
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        if (this.closed) {
          return;
        }
        this.logger?.error?.(err, 'RabbitMQ reconnection failed');
        this.handleDisconnect();
      });
    }, delay);
  }

  async healthCheck(): Promise<TransportHealth> {
    if (!this.isConnected()) {
      return {
        status: 'unhealthy',
        checkedAt: Date.now(),
        details: { connected: false },
      };
    }
    return {
      status: 'healthy',
      checkedAt: Date.now(),
      details: { connected: true },
    };
  }

  async publish(topic: string, message: unknown, options: PublishOptions = {}): Promise<void> {
    if (this.closed) {
      throw new Error('RabbitMQ transport is closed');
    }
    await this.connect();

    if (!this.channel) {
      throw new Error('RabbitMQ channel not available');
    }

    const routingKey = topic;
    const buffer = Buffer.from(JSON.stringify(message));

    const published = this.channel.publish(this.config.exchangeName, routingKey, buffer, {
      persistent: this.config.durable,
      ...options,
      headers: options.headers,
    });

    if (!published) {
      throw new Error('Failed to publish message to RabbitMQ (channel write buffer full)');
    }
  }

  async subscribe(
    topic: string,
    handler: (message: unknown, context: MessageContext) => Promise<void>,
    options: SubscribeOptions = {},
  ): Promise<void> {
    if (this.closed) {
      throw new Error('RabbitMQ transport is closed');
    }
    await this.connect();

    if (!this.channel) {
      throw new Error('RabbitMQ channel not available');
    }

    const queueName = options.groupId || `${this.config.defaultQueue}.${topic}`;
    const manualAck = !this.config.noAck && !options.autoAck;

    await this.channel.assertQueue(queueName, {
      durable: this.config.durable,
      autoDelete: this.config.autoDelete,
      arguments: this.dlxArgs(),
    });
    await this.channel.bindQueue(queueName, this.config.exchangeName, topic);

    // Replacing a subscription for the same queue replaces the consumer on it.
    const existing = this.subscriptions.get(queueName);
    if (existing) {
      try {
        await this.channel.cancel(existing.consumerTag);
      } catch (err) {
        this.logger?.warn?.(`Failed to cancel existing consumer for ${queueName}`, { error: err });
      }
    }

    const result = await this.channel.consume(
      queueName,
      (msg) => {
        void this.dispatchMessage(msg, handler, queueName, manualAck);
      },
      { noAck: this.config.noAck || options.autoAck },
    );

    this.subscriptions.set(queueName, { handler, consumerTag: result.consumerTag, options });
  }

  private async dispatchMessage(
    msg: AmqpMsg | null,
    handler: (message: unknown, context: MessageContext) => Promise<void>,
    queueName: string,
    manualAck: boolean,
  ): Promise<void> {
    if (!msg) return;
    if (!this.channel) {
      return;
    }

    try {
      const content = msg.content.toString();
      const parsedMessage = JSON.parse(content);
      const context: MessageContext = {
        topic: msg.fields.routingKey,
        headers: msg.properties.headers as Record<string, string> | undefined,
      };

      await handler(parsedMessage, context);

      if (manualAck) {
        this.channel.ack(msg);
      }
      this.resetAttempt(msg, queueName);
    } catch (error) {
      if (!manualAck) {
        this.logger?.error?.(error as Error, 'Error processing RabbitMQ message (autoAck mode)');
        return;
      }
      const attempt = this.incrementAttempt(msg, queueName);
      this.logger?.error?.(error as Error, `Error processing RabbitMQ message (attempt ${attempt})`);
      if (attempt >= this.config.maxAttempts) {
        this.channel.nack(msg, false, false);
      } else {
        this.channel.nack(msg, false, true);
      }
    }
  }

  async unsubscribe(topic: string): Promise<void> {
    if (!this.channel) return;

    const computed = `${this.config.defaultQueue}.${topic}`;
    let key: string | undefined = this.subscriptions.has(computed) ? computed : undefined;
    if (!key) {
      key = this.subscriptions.has(topic) ? topic : undefined;
    }
    if (!key) return;

    const entry = this.subscriptions.get(key)!;
    try {
      await this.channel.cancel(entry.consumerTag);
    } catch (err) {
      this.logger?.warn?.(`Failed to cancel consumer ${entry.consumerTag} for ${key}`, { error: err });
    }
    this.subscriptions.delete(key);
    this.dispatchResetForQueue(key);
  }

  private dispatchResetForQueue(queueName: string): void {
    for (const key of Array.from(this.deliveryAttempts.keys())) {
      if (key.startsWith(`${queueName}:`)) {
        this.deliveryAttempts.delete(key);
      }
    }
  }

  private incrementAttempt(msg: AmqpMsg, queueName: string): number {
    const key = deliveryKey(queueName, msg);
    const next = (this.deliveryAttempts.get(key) ?? 0) + 1;
    this.deliveryAttempts.set(key, next);
    if (this.deliveryAttempts.size > MAX_TRACKED_DELIVERIES) {
      const oldest = this.deliveryAttempts.keys().next().value;
      if (oldest) this.deliveryAttempts.delete(oldest);
    }
    return next;
  }

  private resetAttempt(msg: AmqpMsg, queueName: string): void {
    this.deliveryAttempts.delete(deliveryKey(queueName, msg));
  }

  private dlxArgs(): Record<string, unknown> | undefined {
    if (!this.config.deadLetterExchange) return undefined;
    return { 'x-dead-letter-exchange': this.config.deadLetterExchange };
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.disconnecting = false;
    this.clearReconnectTimer();
    this.detachLifecycle?.();
    this.detachLifecycle = null;

    try {
      if (this.channel) {
        try {
          await this.channel.close();
        } catch {
          /* best-effort */
        }
      }
      if (this.connection) {
        try {
          await this.connection.close();
        } catch {
          /* best-effort */
        }
      }
    } catch (error) {
      this.logger?.error?.(error as Error, 'Error disconnecting from RabbitMQ');
    } finally {
      this.channel = null;
      this.connection = null;
      this.started = false;
      this.logger?.info?.('RabbitMQ disconnected gracefully');
    }
  }

  isConnected(): boolean {
    return this.connection !== null && this.channel !== null && !this.closed;
  }
}

export function createRabbitMQTransport(config: RabbitMQAdapterConfig, logger?: Logger): RabbitMQTransport {
  return new RabbitMQTransport(config, logger);
}
