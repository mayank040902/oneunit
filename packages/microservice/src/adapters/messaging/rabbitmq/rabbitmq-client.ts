import { Logger, noopLogger } from '@/observability/logger.js';

const AMQP_MISSING =
  "RabbitMQ client requires the optional 'amqplib' dependency. Install it with `npm install amqplib` (or `pnpm add amqplib`), or remove the rabbitmq adapter from your configuration.";

export interface RabbitMQClientConfig {
  url: string;
  queueName: string;
  reconnectDelay?: number;
  maxRetries?: number;
  prefetch?: number;
  durable?: boolean;
  logger?: Logger;
}

export class RabbitMQClient {
  private connection: AmqpConnection | null = null;
  private channel: AmqpChannel | null = null;
  private config: Required<Omit<RabbitMQClientConfig, 'logger'>> & { logger: Logger };
  private isConnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private lifecycleAttached = false;

  constructor(config: RabbitMQClientConfig) {
    this.config = {
      url: config.url,
      queueName: config.queueName,
      reconnectDelay: config.reconnectDelay ?? 5000,
      maxRetries: config.maxRetries ?? 10,
      prefetch: config.prefetch ?? 1,
      durable: config.durable ?? true,
      logger: config.logger ?? noopLogger,
    };
  }

  private async loadAmqp(): Promise<typeof import('amqplib')> {
    try {
      return await import('amqplib');
    } catch {
      throw new Error(AMQP_MISSING);
    }
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('RabbitMQ client is closed');
    }
    if (this.isConnected()) {
      return;
    }
    if (this.isConnecting) {
      return new Promise((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (this.isConnected()) {
            clearInterval(checkInterval);
            resolve();
          } else if (!this.isConnecting) {
            clearInterval(checkInterval);
            reject(new Error('Connection failed'));
          }
        }, 100);
      });
    }

    this.clearReconnectTimer();
    this.isConnecting = true;

    try {
      await this.establishConnection();
    } catch (error) {
      this.isConnecting = false;
      throw error;
    }
  }

  private async establishConnection(): Promise<void> {
    const amqp = await this.loadAmqp();
    try {
      this.config.logger.info(`Connecting to RabbitMQ at ${this.config.url}...`);
      this.connection = await amqp.connect(this.config.url);
      this.channel = await this.connection.createChannel();
      await this.channel.prefetch(this.config.prefetch);

      await this.channel.assertQueue(this.config.queueName, {
        durable: this.config.durable,
      });

      this.attachLifecycle();
      this.config.logger.info(`RabbitMQ connected and queue "${this.config.queueName}" asserted`);
      this.isConnecting = false;
      this.reconnectAttempts = 0;
    } catch (error) {
      this.isConnecting = false;
      this.detachLifecycle();
      this.config.logger.error(error as Error, 'Failed to connect to RabbitMQ');
      throw error;
    }
  }

  private attachLifecycle(): void {
    if (this.lifecycleAttached || !this.connection || !this.channel) return;
    this.lifecycleAttached = true;

    const onLost = (reason: string) => {
      this.config.logger.warn(`RabbitMQ connection lost: ${reason}`);
      this.handleDisconnect();
    };

    const onClose = () => onLost('connection closed');
    const onError = (err: Error) => onLost(`connection error: ${err?.message ?? err}`);

    this.connection.on('close', onClose);
    this.connection.on('error', onError as (...args: unknown[]) => void);
    this.channel.on('close', onClose);
    this.channel.on('error', onError as (...args: unknown[]) => void);
  }

  private detachLifecycle(): void {
    if (!this.lifecycleAttached || !this.connection || !this.channel) return;
    this.lifecycleAttached = false;
    // Connection and channel are already nulled by caller; listeners were on the
    // old references so they are naturally inert. No-op for safety.
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
    if (this.isConnecting) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }

    this.detachLifecycle();
    this.connection = null;
    this.channel = null;

    if (this.reconnectAttempts >= this.config.maxRetries) {
      this.config.logger.error('Max RabbitMQ reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelay * this.reconnectAttempts;
    this.config.logger.warn(
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
        this.config.logger.error(err, 'RabbitMQ reconnection failed');
        this.handleDisconnect();
      });
    }, delay);
  }

  isConnected(): boolean {
    return this.connection !== null && this.channel !== null && !this.closed;
  }

  async publish(message: object, options?: Record<string, unknown>): Promise<boolean> {
    if (this.closed) {
      throw new Error('RabbitMQ client is closed');
    }
    await this.connect();
    if (!this.channel) {
      throw new Error('Channel not available');
    }

    try {
      const buffer = Buffer.from(JSON.stringify(message));
      const result = this.channel.sendToQueue(this.config.queueName, buffer, {
        persistent: this.config.durable,
        ...options,
      });
      return result;
    } catch (error) {
      this.config.logger.error(error as Error, 'RabbitMQ publish failed');
      throw error;
    }
  }

  async consume(
    onMessage: (msg: unknown) => void,
    options?: Record<string, unknown>,
  ): Promise<string> {
    if (this.closed) {
      throw new Error('RabbitMQ client is closed');
    }
    await this.connect();
    if (!this.channel) {
      throw new Error('Channel not available');
    }

    try {
      const consumerTag = await this.channel.consume(
        this.config.queueName,
        onMessage as (msg: unknown) => void,
        {
          noAck: false,
          ...options,
        },
      );
      return consumerTag.consumerTag;
    } catch (error) {
      this.config.logger.error(error as Error, 'RabbitMQ consume setup failed');
      throw error;
    }
  }

  async ack(msg: unknown): Promise<void> {
    if (!this.channel) {
      throw new Error('Channel not available');
    }
    this.channel.ack(msg);
  }

  async nack(msg: unknown, requeue = true): Promise<void> {
    if (!this.channel) {
      throw new Error('Channel not available');
    }
    this.channel.nack(msg, false, requeue);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearReconnectTimer();
    this.detachLifecycle();

    try {
      if (this.channel) {
        await this.channel.close();
      }
      if (this.connection) {
        await this.connection.close();
      }
      this.channel = null;
      this.connection = null;
      this.config.logger.info('RabbitMQ connection closed gracefully');
    } catch (error) {
      this.config.logger.error(error as Error, 'Error closing RabbitMQ connection');
    } finally {
      this.channel = null;
      this.connection = null;
    }
  }
}

type AmqpConnection = {
  createChannel(): Promise<AmqpChannel>;
  close(): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};

type AmqpChannel = {
  prefetch(n: number): Promise<unknown>;
  assertQueue(name: string, opts?: Record<string, unknown>): Promise<unknown>;
  consume(queue: string, handler: (msg: unknown) => void, opts?: Record<string, unknown>): Promise<{ consumerTag: string }>;
  sendToQueue(queue: string, content: Buffer, opts?: Record<string, unknown>): boolean;
  ack(msg: unknown): void;
  nack(msg: unknown, allUpTo?: boolean, requeue?: boolean): void;
  close(): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};

export const createRabbitMQClient = (config: RabbitMQClientConfig): RabbitMQClient => {
  return new RabbitMQClient(config);
};
