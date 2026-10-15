import { Kafka, Producer, Consumer, EachMessagePayload, KafkaConfig, SASLOptions, IHeaders } from 'kafkajs';
import { KafkaAdapterConfig, KafkaDriverAdapter } from '../types.js';
import { Logger } from '@/observability/logger.js';
import { PublishOptions, SubscribeOptions, MessageContext } from '@/core/capabilities.js';

function headerValueToString(value: Buffer | string | (Buffer | string)[] | undefined): string | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    value = value[0];
  }
  if (Buffer.isBuffer(value)) return value.toString();
  return value;
}

function headersToRecord(headers?: IHeaders): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const strValue = headerValueToString(value);
    if (strValue !== undefined) {
      result[key] = strValue;
    }
  }
  return result;
}

export async function createKafkaAdapter(config: KafkaAdapterConfig, logger?: Logger): Promise<KafkaDriverAdapter> {
  const kafkaConfig: KafkaConfig = {
    brokers: config.brokers,
    clientId: config.clientId,
  };

  if (config.security) {
    if (config.security.ssl) {
      kafkaConfig.ssl = true;
    }
    if (config.security.sasl) {
      kafkaConfig.sasl = {
        mechanism: config.security.sasl.mechanism,
        username: config.security.sasl.username,
        password: config.security.sasl.password,
      } as SASLOptions;
    }
  }

  const kafka = new Kafka(kafkaConfig);

  let producer: Producer | null = null;
  const consumers: Map<string, Consumer> = new Map();

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
      producer = kafka.producer(config.producer);
      await producer.connect();
      logger?.info('Kafka producer connected', { clientId: config.clientId });
    },

    async close(): Promise<void> {
      if (producer) {
        await producer.disconnect();
        producer = null;
        logger?.info('Kafka producer disconnected');
      }
      for (const consumer of consumers.values()) {
        try {
          await consumer.disconnect();
        } catch (err) {
          logger?.error?.(err as Error, 'Error disconnecting Kafka consumer during close');
        }
      }
      consumers.clear();
      logger?.info('Kafka consumers disconnected');
    },


    async healthCheck() {
      return {
        status: producer ? 'healthy' : 'unhealthy',
        checkedAt: Date.now(),
        details: { connected: producer !== null, driver: 'kafkajs' },
      };
    },

    async publish(topic: string, message: unknown, options: PublishOptions = {}): Promise<void> {
      if (!producer) {
        throw new Error('Producer not connected');
      }
      const fullTopic = `${config.topics.prefix}.${topic}`;
      
      await producer.send({
        topic: fullTopic,
        messages: [{
          key: options.key,
          value: JSON.stringify(message),
          headers: options.headers,
        }],
      });
      logger?.debug('Message published', { topic: fullTopic });
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

      const consumer = kafka.consumer({ groupId, ...config.consumer, retry: { retries: 3 } });
      await consumer.connect();
      await consumer.subscribe({ topic: fullTopic, fromBeginning: options.fromBeginning });

      consumer.on((consumer as any).events?.CRASH || (consumer as any).events?.crash || "crash", (arg: any) => {
        const err = arg?.payload?.error || arg?.error || arg;
        logger?.error?.(err as Error, `Kafka consumer crashed for ${fullTopic}`);
      });
      consumer.on((consumer as any).events?.CONNECT || (consumer as any).events?.connect || "connect", () => {
        logger?.info('Kafka consumer connected', { topic: fullTopic, groupId });
      });
      consumer.on((consumer as any).events?.DISCONNECT || (consumer as any).events?.disconnect || "disconnect", () => {
        logger?.warn('Kafka consumer disconnected', { topic: fullTopic, groupId });
      });

      await consumer.run({
        autoCommit: false,
        eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
          try {
            const value = message.value ? JSON.parse(message.value.toString()) : null;
            const headersRecord = headersToRecord(message.headers);
            await handler(value, {
              topic,
              correlationId: headersRecord?.['correlation-id'],
              traceContext: headersRecord?.['trace-context'] ? JSON.parse(headersRecord['trace-context']) as Record<string, string> : undefined,
              headers: headersRecord,
            });
            await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
          } catch (err) {
            logger?.error?.(`Error processing message from ${fullTopic}`, { error: err });
            // Don't throw to prevent consumer crash
          }
        },
      });

      consumers.set(topic, consumer);
    },

    async unsubscribe(topic: string): Promise<void> {
      const consumer = consumers.get(topic);
      if (consumer) {
        await consumer.disconnect();
        consumers.delete(topic);
        logger?.info('Kafka consumer unsubscribed', { topic });
      }
    },
  };
}