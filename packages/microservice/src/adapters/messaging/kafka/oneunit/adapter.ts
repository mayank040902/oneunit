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
      await client.disconnect();
      for (const consumer of consumers.values()) {
        await consumer.disconnect();
      }
      consumers.clear();
    },

    async healthCheck() {
      return {
        status: 'healthy',
        checkedAt: Date.now(),
        details: { connected: true, driver: 'oneunit' },
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

      const consumer = await client.consume(fullTopic, async (payload: OneUnitKafkaPayload) => {
        try {
          await handler(payload.message.value, toMessageContext(payload));

          if (!options.autoAck && payload.ack) {
            await payload.ack();
          }
        } catch (err) {
          logger?.error(`Error processing message from ${fullTopic}`, { error: err });
          if (!options.autoAck && payload.nak) {
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