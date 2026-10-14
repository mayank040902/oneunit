import { BaseTransport } from '@/transport/transport';
import { TransportHealth, MessagePublisher, MessageSubscriber, PublishOptions, SubscribeOptions, MessageContext } from '@/core/capabilities.js';
import { connect, NatsConnection, Subscription, JetStreamClient, JetStreamSubscription, headers as createHeaders, MsgHdrs } from 'nats';
import { NatsAdapterConfig } from '@/config/schema.js';

interface JetStreamMessage {
  data: Uint8Array;
  subject: string;
  headers?: MsgHdrs;
  ack?: () => Promise<void>;
  nak?: () => Promise<void>;
}

function headersToRecord(hdrs?: MsgHdrs): Record<string, string> | undefined {
  if (!hdrs) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(hdrs)) {
    result[key] = value;
  }
  return result;
}

function recordToHeaders(headers?: Record<string, string>): MsgHdrs | undefined {
  if (!headers) return undefined;
  const h = createHeaders();
  for (const [key, value] of Object.entries(headers)) {
    h.set(key, value);
  }
  return h;
}

export class NatsTransport extends BaseTransport implements MessagePublisher, MessageSubscriber {
  private config: NatsAdapterConfig;
  private nc: NatsConnection | null = null;
  private js: JetStreamClient | null = null;
  private subscriptions: Map<string, Subscription | JetStreamSubscription> = new Map();

  constructor(config: NatsAdapterConfig) {
    super({
      name: 'nats',
      capabilities: {
        requestResponse: false,
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
    const options: Record<string, unknown> = {
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
      await this.js.publish(subject, new TextEncoder().encode(data), { headers: recordToHeaders(options.headers) });
    } else if (this.nc) {
      this.nc.publish(subject, new TextEncoder().encode(data));
    }
  }

  async subscribe(topic: string, handler: (message: unknown, context: MessageContext) => Promise<void>, options: SubscribeOptions = {}): Promise<void> {
    if (!this.nc) throw new Error('NATS not connected');

    const subject = `${this.config.subjects.prefix}.${topic}`;
    
    let subscription: Subscription | JetStreamSubscription;
    
    if (this.js && this.config.jetstream?.enabled) {
      const durableName = options.groupId ?? `${this.config.clientName}-${topic}`;
      subscription = await this.js.subscribe(subject, {
        durable: durableName,
        ackPolicy: options.autoAck ? 'none' : 'explicit',
      } as Record<string, unknown>);
    } else {
      subscription = this.nc.subscribe(subject);
    }

    this.subscriptions.set(topic, subscription);

    (async () => {
      for await (const msg of subscription) {
        try {
          const data = JSON.parse(new TextDecoder().decode(msg.data));
          // NATS message headers may be MsgHdrs or undefined
          // Convert to Record<string, string> for our context
          const msgHeaders = msg.headers ? headersToRecord(msg.headers) : undefined;
          await handler(data, {
            topic: msg.subject,
            headers: msgHeaders,
          });
          
          if (this.config.jetstream?.enabled && !options.autoAck) {
            const jsMsg = msg as JetStreamMessage;
            if (typeof jsMsg.ack === 'function') {
              await jsMsg.ack();
            }
          }
        } catch (err) {
          console.error(`Error processing message from ${subject}:`, err);
          if (this.config.jetstream?.enabled && !options.autoAck) {
            const jsMsg = msg as JetStreamMessage;
            if (typeof jsMsg.nak === 'function') {
              await jsMsg.nak();
            }
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