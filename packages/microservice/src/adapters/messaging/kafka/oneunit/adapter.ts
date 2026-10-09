import { KafkaAdapterConfig, KafkaDriverAdapter } from '../types.js';

export interface OneUnitKafkaModule {
  KafkaClient: new (config: any) => OneUnitKafkaClient;
  createKafkaClient: (config: any) => Promise<OneUnitKafkaClient>;
}

export interface OneUnitKafkaClient {
  getProducer(config?: any): Promise<OneUnitKafkaProducer>;
  consume(topic: string, handler: (payload: any) => Promise<void>, options?: any): Promise<OneUnitKafkaConsumer>;
  disconnect(): Promise<void>;
}

export interface OneUnitKafkaProducer {
  send(topic: string, message: any, options?: any): Promise<void>;
}

export interface OneUnitKafkaConsumer {
  disconnect(): Promise<void>;
}

export async function createKafkaAdapter(
  config: KafkaAdapterConfig,
  oneUnitKafka: OneUnitKafkaModule
): Promise<KafkaDriverAdapter> {
  const client = await oneUnitKafka.createKafkaClient({
    brokers: config.brokers,
    clientId: config.clientId,
    ...(config.security && { ssl: config.security.ssl, sasl: config.security.sasl }),
  });

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

    async publish(topic: string, message: unknown, options: any = {}) {
      const fullTopic = `${config.topics.prefix}.${topic}`;
      await producer.send(fullTopic, message, {
        send: {
          key: options.key,
          headers: options.headers,
        },
      });
    },

    async subscribe(topic: string, handler: (message: unknown, context: any) => Promise<void>, options: any = {}) {
      const fullTopic = `${config.topics.prefix}.${topic}`;
      const groupId = options.groupId ?? `${config.clientId}-${topic}`;

      const consumer = await client.consume(fullTopic, async (payload: any) => {
        try {
          await handler(payload.message.value, {
            topic: payload.topic,
            partition: payload.partition,
            offset: payload.offset,
            headers: payload.message.headers,
          });

          if (!options.autoAck && payload.ack) {
            await payload.ack();
          }
        } catch (err) {
          console.error(`Error processing message from ${fullTopic}:`, err);
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