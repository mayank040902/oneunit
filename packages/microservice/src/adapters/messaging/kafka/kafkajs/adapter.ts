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

      const consumerEvents = (consumer as { events?: Record<string, unknown> }).events ?? {};
      const crashEvent = (consumerEvents["CRASH"] || consumerEvents["crash"] || "crash") as Parameters<typeof consumer.on>[0];
      consumer.on(crashEvent, (arg: unknown) => {
        const eventArg = arg as { payload?: { error?: unknown }; error?: unknown } | undefined;
        const err = eventArg?.payload?.error || eventArg?.error || arg;
        logger?.error?.(err as Error, `Kafka consumer crashed for ${fullTopic}`);
      });
      const connectEvent = (consumerEvents["CONNECT"] || consumerEvents["connect"] || "connect") as unknown as Parameters<typeof consumer.on>[0];
      consumer.on(connectEvent, () => {
        logger?.info('Kafka consumer connected', { topic: fullTopic, groupId });
      });
      const disconnectEvent = (consumerEvents["DISCONNECT"] || consumerEvents["disconnect"] || "disconnect") as unknown as Parameters<typeof consumer.on>[0];
      consumer.on(disconnectEvent, () => {
        logger?.warn('Kafka consumer disconnected', { topic: fullTopic, groupId });
      });

      const extendedConfig = config as unknown as Record<string, unknown>;
      const maxAttempts = Number(
        extendedConfig['maxDeliveryAttempts'] ??
          extendedConfig['maxAttempts'] ??
          ((config.consumer as unknown as Record<string, unknown> | undefined)?.['maxDeliveryAttempts']) ??
          ((config.consumer as unknown as Record<string, unknown> | undefined)?.['maxAttempts']) ??
          3,
      );
      const retryDelayMs = Number(
        extendedConfig['retryDelayMs'] ??
          extendedConfig['retryDelay'] ??
          ((config.consumer as unknown as Record<string, unknown> | undefined)?.['retryDelayMs']) ??
          ((config.consumer as unknown as Record<string, unknown> | undefined)?.['retryDelay']) ??
          100,
      );
      const deadLetterTopic = (
        extendedConfig['deadLetterTopic'] ??
        extendedConfig['deadLetterQueue'] ??
        ((config.consumer as unknown as Record<string, unknown> | undefined)?.['deadLetterTopic']) ??
        ((config.consumer as unknown as Record<string, unknown> | undefined)?.['deadLetterQueue'])
      ) as string | undefined;

      await consumer.run({
        autoCommit: false,
        eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
          const value = message.value ? JSON.parse(message.value.toString()) : null;
          const headersRecord = headersToRecord(message.headers);
          const context = {
            topic,
            correlationId: headersRecord?.['correlation-id'],
            traceContext: headersRecord?.['trace-context'] ? JSON.parse(headersRecord['trace-context']) as Record<string, string> : undefined,
            headers: headersRecord,
          };

          const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
          let lastError: unknown;

          for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
            try {
              await handler(value, context);
              await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
              return;
            } catch (err) {
              lastError = err;
              logger?.error?.(`Error processing message from ${fullTopic} (attempt ${attempt})`, { error: err });
              if (attempt < Math.max(1, maxAttempts) && retryDelayMs > 0) {
                await sleep(retryDelayMs);
              }
            }
          }

          if (deadLetterTopic) {
            try {
              await producer?.send({
                topic: deadLetterTopic,
                messages: [{
                  key: message.key ?? undefined,
                  value: JSON.stringify({
                    originalTopic: topic,
                    partition,
                    offset: message.offset,
                    headers: headersRecord,
                    value,
                    error: lastError instanceof Error ? lastError.message : String(lastError),
                    attempts: Math.max(1, maxAttempts),
                  }),
                  headers: headersRecord,
                }],
              });
              await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
            } catch (deliveryError) {
              logger?.error?.(`Failed to publish Kafka message to dead-letter topic ${deadLetterTopic}`, { error: deliveryError });
            }
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