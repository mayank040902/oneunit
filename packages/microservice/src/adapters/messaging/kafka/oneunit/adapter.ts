import { KafkaAdapterConfig, KafkaDriverAdapter } from '../types.js';
import { Logger } from '@/observability/logger.js';
import { PublishOptions, SubscribeOptions, MessageContext } from '@/core/capabilities.js';

export interface OneUnitKafkaClientConfig {
  brokers: string[];
  clientId: string;
  ssl?: boolean;
  sasl?: { mechanism: string; username: string; password: string };
}

export interface OneUnitKafkaProducerConfig {
  [key: string]: unknown;
}

export interface OneUnitKafkaConsumerConfig {
  groupId: string;
  [key: string]: unknown;
}

export interface OneUnitKafkaMessage {
  value: unknown;
  headers?: Record<string, string>;
}

export interface OneUnitKafkaPayload {
  topic: string;
  partition: number;
  offset: string;
  message: OneUnitKafkaMessage;
  ack?: () => Promise<void>;
  nak?: () => Promise<void>;
}

export interface OneUnitKafkaModule {
  KafkaClient: new (config: OneUnitKafkaClientConfig) => OneUnitKafkaClient;
  createKafkaClient: (config: OneUnitKafkaClientConfig, options?: { logger?: Logger }) => Promise<OneUnitKafkaClient>;
}

export interface OneUnitKafkaClient {
  getProducer(config?: OneUnitKafkaProducerConfig): Promise<OneUnitKafkaProducer>;
  consume(topic: string, handler: (payload: OneUnitKafkaPayload) => Promise<void>, options?: OneUnitKafkaConsumerConfig): Promise<OneUnitKafkaConsumer>;
  disconnect(): Promise<void>;
}

export interface OneUnitKafkaProducer {
  send(topic: string, message: unknown, options?: { send?: { key?: string; headers?: Record<string, string> } }): Promise<void>;
}

export interface OneUnitKafkaConsumer {
  disconnect(): Promise<void>;
}

function toMessageContext(payload: OneUnitKafkaPayload): MessageContext {
  return {
    topic: payload.topic,
    correlationId: payload.message.headers?.['correlation-id'] as string | undefined,
    traceContext: payload.message.headers?.['trace-context'] ? JSON.parse(payload.message.headers['trace-context'] as string) as Record<string, string> : undefined,
    headers: payload.message.headers,
  };
}

export async function createKafkaAdapter(
  config: KafkaAdapterConfig,
  oneUnitKafka: OneUnitKafkaModule,
  logger?: Logger
): Promise<KafkaDriverAdapter> {
  const client = await oneUnitKafka.createKafkaClient({
    brokers: config.brokers,
    clientId: config.clientId,
    ...(config.security && { ssl: config.security.ssl, sasl: config.security.sasl }),
  }, { logger });

  const producer = await client.getProducer(config.producer);

  const consumers: Map<string, OneUnitKafkaConsumer> = new Map();
  let connected = true;

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

    async start(): Promise<void> {
      // Already started in createKafkaAdapter
    },

     async close(): Promise<void> {
      for (const consumer of consumers.values()) {
        try {
          await consumer.disconnect();
        } catch (err) {
          logger?.error?.(err as Error, 'Error disconnecting Kafka consumer');
        }
      }
      consumers.clear();
      connected = false;
      try {
        await client.disconnect();
      } catch (err) {
        logger?.error?.(err as Error, 'Error disconnecting Kafka client');
      }
    },

    async healthCheck() {
      return {
        status: connected ? 'healthy' : 'unhealthy',
        checkedAt: Date.now(),
        details: { connected, driver: 'oneunit' },
      };
    },

    async publish(topic: string, message: unknown, options: PublishOptions = {}): Promise<void> {
      const fullTopic = `${config.topics.prefix}.${topic}`;
      await producer.send(fullTopic, message, {
        send: {
          key: options.key,
          headers: options.headers,
        },
      });
    },

    async subscribe(topic: string, handler: (message: unknown, context: MessageContext) => Promise<void>, options: SubscribeOptions = {}): Promise<void> {
      const fullTopic = `${config.topics.prefix}.${topic}`;
      const groupId = options.groupId ?? `${config.clientId}-${topic}`;

      const existing = consumers.get(topic);
      if (existing) {
        try {
          await existing.disconnect();
        } catch (err) {
          logger?.error?.(err as Error, 'Error disconnecting stale consumer during re-subscribe');
        }
        consumers.delete(topic);
      }

      const maxAttempts = Number((options as Record<string, unknown>)['maxDeliveryAttempts'] ?? ((config.consumer as Record<string, unknown> | undefined)?.['maxDeliveryAttempts']) ?? 3);
      const deadLetterTopic = (options as Record<string, unknown>)['deadLetterTopic'] ?? ((config.consumer as Record<string, unknown> | undefined)?.['deadLetterTopic']);

      const consumer = await client.consume(fullTopic, async (payload: OneUnitKafkaPayload) => {
        try {
          await handler(payload.message.value, toMessageContext(payload));
          if (!options.autoAck && payload.ack) {
            await payload.ack();
          }
        } catch (err) {
          logger?.error?.(err instanceof Error ? err : new Error(String(err)), `Error processing message from ${fullTopic}`);
          if (options.autoAck) return;
          const payloadRecord = payload as unknown as Record<string, unknown>;
          const deliveryCount = Number(payloadRecord['deliveryCount'] ?? ((payloadRecord['info'] as { deliveryCount?: unknown } | undefined)?.deliveryCount) ?? 1);
          if (deliveryCount >= Math.max(1, maxAttempts)) {
            if (deadLetterTopic) {
              try {
                await (producer as { send: (...args: unknown[]) => Promise<void> }).send(deadLetterTopic, JSON.stringify({
                  topic: fullTopic,
                  partition: payload.partition,
                  offset: payload.offset,
                  error: err instanceof Error ? err.message : String(err),
                  attempts: deliveryCount,
                }));
                if (payload.ack) await payload.ack();
              } catch (deliveryError) {
                logger?.error?.(deliveryError instanceof Error ? deliveryError : new Error(String(deliveryError)), `Failed to publish Kafka message to dead-letter topic ${deadLetterTopic}`);
              }
            } else if (payload.nak) {
              await payload.nak();
            }
          } else if (payload.nak) {
            await payload.nak();
          }
        }
      }, { groupId });

      consumers.set(topic, consumer);
    },

    async unsubscribe(topic: string): Promise<void> {
      const consumer = consumers.get(topic);
      if (consumer) {
        await consumer.disconnect();
        consumers.delete(topic);
      }
    },
  };
}