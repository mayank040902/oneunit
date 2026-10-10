import { KafkaAdapterConfig } from './types.js';
import { Logger } from '@/observability/logger.js';

export interface KafkaClient {
  publish(topic: string, message: unknown, options?: { key?: string; headers?: Record<string, string> }): Promise<void>;
  subscribe(topic: string, handler: (message: unknown, context: { topic: string; partition: number; offset: string; headers?: Record<string, string> }) => Promise<void>, options?: { groupId?: string; autoAck?: boolean }): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
  disconnect(): Promise<void>;
}

export interface KafkaClientConfig {
  config: KafkaAdapterConfig;
  logger?: Logger;
}

let cachedKafkaClient: KafkaClient | null = null;
let kafkaInitializationError: Error | null = null;

export function isKafkaAvailable(): boolean {
  try {
    require.resolve('@oneunit/kafka');
    return true;
  } catch {
    return false;
  }
}

export async function createKafkaClient(config: KafkaClientConfig): Promise<KafkaClient> {
  if (cachedKafkaClient) {
    return cachedKafkaClient;
  }

  if (kafkaInitializationError) {
    throw kafkaInitializationError;
  }

  const { config: kafkaConfig, logger } = config;

  try {
    const oneUnitKafkaModule = await import('@oneunit/kafka');
    
    if (!oneUnitKafkaModule.createKafkaClient && !oneUnitKafkaModule.KafkaClient) {
      throw new Error('@oneunit/kafka does not export required APIs (createKafkaClient, KafkaClient)');
    }

    const client = await oneUnitKafkaModule.createKafkaClient({
      brokers: kafkaConfig.brokers,
      clientId: kafkaConfig.clientId,
      ...(kafkaConfig.security && { ssl: kafkaConfig.security.ssl, sasl: kafkaConfig.security.sasl }),
    }, { logger });

    const producer = await client.getProducer(kafkaConfig.producer) as any;

    const consumers: Map<string, any> = new Map();

    cachedKafkaClient = {
      async publish(topic: string, message: unknown, options?: { key?: string; headers?: Record<string, string> }) {
        const fullTopic = `${kafkaConfig.topics.prefix}.${topic}`;
        await producer.send(fullTopic, message, {
          send: {
            key: options?.key,
            headers: options?.headers,
          },
        });
      },

      async subscribe(topic: string, handler: (message: unknown, context: { topic: string; partition: number; offset: string; headers?: Record<string, string> }) => Promise<void>, options?: { groupId?: string; autoAck?: boolean }) {
        const fullTopic = `${kafkaConfig.topics.prefix}.${topic}`;
        const groupId = options?.groupId ?? `${kafkaConfig.clientId}-${topic}`;

        const consumer = await client.consume(fullTopic, async (payload: any) => {
          try {
            await handler(payload.message.value, {
              topic: payload.topic,
              partition: payload.partition,
              offset: payload.offset,
              headers: payload.message.headers,
            });

            if (!options?.autoAck && payload.ack) {
              await payload.ack();
            }
          } catch (err) {
            logger?.error(`Error processing message from ${fullTopic}`, { error: err });
            if (!options?.autoAck && payload.nak) {
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

      async disconnect(): Promise<void> {
        await client.disconnect();
        for (const consumer of consumers.values()) {
          await consumer.disconnect();
        }
        consumers.clear();
        cachedKafkaClient = null;
      },
    };

    logger?.info('Kafka client initialized with @oneunit/kafka', { clientId: kafkaConfig.clientId });
    return cachedKafkaClient;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    
    if (
      msg.includes('Cannot find module') ||
      msg.includes('Failed to load url') ||
      msg.includes('Cannot find package')
    ) {
      kafkaInitializationError = new Error(
        '@oneunit/kafka is not installed. ' +
        'To use Kafka messaging, either:\n' +
        '  1. Install @oneunit/kafka: pnpm add @oneunit/kafka\n' +
        '  2. Or configure a KafkaJS driver by setting driver: "kafkajs" in your Kafka adapter config and installing kafkajs: pnpm add kafkajs\n' +
        '  3. Or provide your own Kafka infrastructure and client implementation.'
      );
    } else {
      kafkaInitializationError = err instanceof Error ? err : new Error(String(err));
    }
    
    throw kafkaInitializationError;
  }
}

export function resetKafkaClient(): void {
  cachedKafkaClient = null;
  kafkaInitializationError = null;
}

export function getCachedKafkaClient(): KafkaClient | null {
  return cachedKafkaClient;
}