import { BaseTransport, TransportConfig } from '@/transport/transport';
import { TransportCapabilities, TransportHealth, MessagePublisher, MessageSubscriber, PublishOptions, SubscribeOptions } from '@/core/capabilities';
import { connect, NatsConnection, Subscription } from 'nats';
import { NatsAdapterConfig } from '@/config/schema.js';

export class NatsTransport extends BaseTransport implements MessagePublisher, MessageSubscriber {
  private config: NatsAdapterConfig;
  private nc: NatsConnection | null = null;
  private js: any = null;
  private subscriptions: Map<string, Subscription> = new Map();

  constructor(config: NatsAdapterConfig) {
    super({
      name: 'nats',
      capabilities: {
        requestResponse: true,
        streaming: false,
        publishSubscribe: true,
        durableDelivery: config.jetstream?.enabled ?? false,
        orderedDelivery: true,
        bidirectional: true,
      },
    });
    this.config = config;
  }

  async start(): Promise<void> {
    const options: any = {
      servers: this.config.servers,
      name: this.config.clientName,
      ...(this.config.auth?.user && { user: this.config.auth.user }),
      ...(this.config.auth?.pass && { pass: this.config.auth.pass }),
      ...(this.config.auth?.token && { token: this.config.auth.token }),
      ...(this.config.auth?.nkey && { nkey: this.config.auth.nkey }),
      ...(this.config.auth?.creds && { creds: this.config.auth.creds }),
      ...(this.config.tls && { tls: this.config.tls }),
    };

    this.nc = await connect(options);

    if (this.config.jetstream?.enabled) {
      this.js = this.nc.jetstream();
    }

    this.nc.closed().then(() => {
      // this.started = false; - use isStarted() instead
    });
  }

  async close(): Promise<void> {
    for (const [, sub] of this.subscriptions) {
      await sub.unsubscribe();
    }
    this.subscriptions.clear();

    if (this.nc) {
      await this.nc.drain();
      this.nc = null;
    }
  }

  async healthCheck(): Promise<TransportHealth> {
    return {
      status: this.isStarted() ? 'healthy' : 'unhealthy',
      checkedAt: Date.now(),
      details: { connected: this.nc !== null, jetstream: this.js !== null },
    };
  }

  async publish(topic: string, message: unknown, options: PublishOptions = {}): Promise<void> {
    const subject = `${this.config.subjects.prefix}.${topic}`;
    const data = JSON.stringify(message);

    if (this.js && this.config.jetstream?.enabled) {
      await this.js.publish(subject, new TextEncoder().encode(data), { headers: options.headers });
    } else if (this.nc) {
      this.nc.publish(subject, new TextEncoder().encode(data));
    }
  }

  async subscribe(topic: string, handler: (message: unknown, context: any) => Promise<void>, options: SubscribeOptions = {}): Promise<void> {
    if (!this.nc) throw new Error('NATS not connected');

    const subject = `${this.config.subjects.prefix}.${topic}`;
    
    let subscription: Subscription;
    
    if (this.js && this.config.jetstream?.enabled) {
      subscription = await this.js.subscribe(subject, {
        durable: options.groupId ?? `${this.config.clientName}-${topic}`,
        ackPolicy: options.autoAck ? 'none' : 'explicit',
      });
    } else {
      subscription = this.nc.subscribe(subject);
    }

    this.subscriptions.set(topic, subscription);

    (async () => {
      for await (const msg of subscription) {
        try {
          const data = JSON.parse(new TextDecoder().decode(msg.data));
          await handler(data, {
            subject: msg.subject,
            headers: msg.headers,
          });
          
          // JetStream messages have ack/nak methods
          const jsMsg = msg as any;
          if (this.config.jetstream?.enabled && !options.autoAck && typeof jsMsg.ack === 'function') {
            await jsMsg.ack();
          }
        } catch (err) {
          console.error(`Error processing message from ${subject}:`, err);
          const jsMsg = msg as any;
          if (this.config.jetstream?.enabled && !options.autoAck && typeof jsMsg.nak === 'function') {
            await jsMsg.nak();
          }
        }
      }
    })();
  }

  async unsubscribe(topic: string): Promise<void> {
    const sub = this.subscriptions.get(topic);
    if (sub) {
      await sub.unsubscribe();
      this.subscriptions.delete(topic);
    }
  }

  getConnection(): NatsConnection | null {
    return this.nc;
  }
}

export function createNatsTransport(config: NatsAdapterConfig): NatsTransport {
  return new NatsTransport(config);
}