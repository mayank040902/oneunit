import { Kafka, Producer, Consumer, EachMessagePayload } from 'kafkajs';
import { KafkaAdapterConfig, KafkaDriverAdapter } from '../types.js';

export async function createKafkaAdapter(config: KafkaAdapterConfig): Promise<KafkaDriverAdapter> {
  const kafkaConfig: any = {
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
      };
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
    },

    async close(): Promise<void> {
      if (producer) {
        await producer.disconnect();
        producer = null;
      }
      for (const consumer of consumers.values()) {
        await consumer.disconnect();
      }
      consumers.clear();
    },

    async healthCheck() {
      return {
        status: producer ? 'healthy' : 'unhealthy',
        checkedAt: Date.now(),
        details: { connected: producer !== null, driver: 'kafkajs' },
      };
    },

    async publish(topic: string, message: unknown, options: any = {}) {
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
    },

    async subscribe(topic: string, handler: (message: unknown, context: any) => Promise<void>, options: any = {}) {
      const fullTopic = `${config.topics.prefix}.${topic}`;
      const groupId = options.groupId ?? `${config.clientId}-${topic}`;

      const consumer = kafka.consumer({ groupId, ...config.consumer });
      await consumer.connect();
      await consumer.subscribe({ topic: fullTopic, fromBeginning: options.fromBeginning });
      
      await consumer.run({
        eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
          try {
            const value = message.value ? JSON.parse(message.value.toString()) : null;
            await handler(value, {
              topic,
              partition,
              offset: message.offset,
              headers: message.headers,
            });
          } catch (err) {
            console.error(`Error processing message from ${fullTopic}:`, err);
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
      }
    },
  };
}