import { BaseTransport } from '@/transport/transport';
import { TransportHealth, MessagePublisher, MessageSubscriber, PublishOptions, SubscribeOptions, MessageContext } from '@/core/capabilities.js';
import { connect, NatsConnection, Subscription, JetStreamClient, JetStreamSubscription, headers as createHeaders, MsgHdrs } from 'nats';
import { Logger, noopLogger } from '@/observability/logger.js';
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
  private logger: Logger;
  private subscriptions: Map<string, Subscription | JetStreamSubscription> = new Map();
  private processingActive: Set<string> = new Set();
  private closed = false;

  constructor(config: NatsAdapterConfig, logger?: Logger) {
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
    this.logger = (config as { logger?: Logger }).logger ?? logger ?? noopLogger;
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

    this.closed = false;
    this.nc = await connect(options);

    if (this.config.jetstream?.enabled) {
      this.js = this.nc.jetstream();
    }

    this.started = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [, sub] of this.subscriptions) {
      await sub.unsubscribe();
    }
    this.subscriptions.clear();
    this.processingActive.clear();

    if (this.nc) {
      await this.nc.drain();
      this.nc = null;
    }

    this.js = null;
    this.started = false;
  }

  async healthCheck(): Promise<TransportHealth> {
    const connected = this.nc !== null && !this.closed;
    return {
      status: this.isStarted() && connected ? 'healthy' : 'unhealthy',
      checkedAt: Date.now(),
      details: { connected, jetstream: this.js !== null },
    };
  }

  async publish(topic: string, message: unknown, options: PublishOptions = {}): Promise<void> {
    if (!this.isStarted() || !this.nc) {
      throw new Error('NATS transport not started');
    }

    const subject = `${this.config.subjects.prefix}.${topic}`;
    const data = JSON.stringify(message);

    if (this.js && this.config.jetstream?.enabled) {
      await this.js.publish(subject, new TextEncoder().encode(data), { headers: recordToHeaders(options.headers) });
    } else {
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

    const extendedConfig = this.config as Record<string, unknown>;
    const ext = extendedConfig as Record<string, unknown>;
    const maxAttempts = Number(ext['maxDeliveryAttempts'] ?? ext['maxAttempts'] ?? (this.config.jetstream as { maxDeliveryAttempts?: number } | undefined)?.maxDeliveryAttempts ?? 3);
    const retryDelayMs = Number(ext['retryDelayMs'] ?? ext['retryDelay'] ?? 100);
    const deadLetterSubject = (ext['deadLetterSubject'] ?? ext['deadLetterQueue'] ?? (this.config.jetstream as { deadLetterSubject?: string } | undefined)?.deadLetterSubject) as string | undefined;

    const processSubscription = async () => {
      this.processingActive.add(topic);
      try {
        for await (const msg of subscription) {
          if (this.closed) { this.processingActive.delete(topic); break; }
          try {
            const data = JSON.parse(new TextDecoder().decode(msg.data));
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
            const deliveryCount = ((msg as unknown as { info?: { deliveryCount?: number } }).info?.deliveryCount) ?? 1;
            this.logger.error(err instanceof Error ? err : new Error(String(err)), `Error processing message from ${subject}`);
            if (this.config.jetstream?.enabled && !options.autoAck) {
              const jsMsg = msg as JetStreamMessage;
              if (deliveryCount >= Math.max(1, maxAttempts)) {
                if (deadLetterSubject && this.nc) {
                  try {
                    const failedPayload = JSON.stringify({ originalSubject: msg.subject, deliveryCount, error: err instanceof Error ? err.message : String(err), data: new TextDecoder().decode(msg.data) });
                    if (this.js) {
                      await this.js.publish(deadLetterSubject, new TextEncoder().encode(failedPayload));
                    } else {
                      this.nc.publish(deadLetterSubject, new TextEncoder().encode(failedPayload));
                    }
                    if (typeof jsMsg.ack === 'function') await jsMsg.ack();
                  } catch (deliveryError) {
                    this.logger.error(deliveryError instanceof Error ? deliveryError : new Error(String(deliveryError)), `Failed to dead-letter NATS message to ${deadLetterSubject}`);
                  }
                } else if (typeof jsMsg.nak === 'function') {
                  await jsMsg.nak();
                }
              } else if (typeof jsMsg.nak === 'function') {
                await jsMsg.nak();
              }
            }
          }
        }
      } catch (err) {
        this.processingActive.delete(topic);
        this.logger.error(err instanceof Error ? err : new Error(String(err)), `NATS subscription iteration failed for ${subject}`);
        if (!this.closed) {
          // Wait for reconnection before re-entering the processing loop
          // to avoid duplicate handlers and uncontrolled retry storms.
          const waitAndRetry = () => {
            if (this.closed || this.processingActive.has(topic)) return;
            if (!this.nc) {
              setTimeout(waitAndRetry, retryDelayMs).unref();
              return;
            }
            this.processingActive.add(topic);
            void processSubscription();
          };
          setTimeout(waitAndRetry, retryDelayMs).unref();
        }
      }
    };

    void processSubscription();
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