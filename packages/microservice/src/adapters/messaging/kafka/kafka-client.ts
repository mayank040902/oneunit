import { KafkaAdapterConfig, KafkaDriverAdapter } from './types.js';
import { resolveKafkaDriver } from './driver-resolver.js';
import { Logger } from '@/observability/logger.js';
import { MessageContext } from '@/core/capabilities.js';

export interface KafkaClient {
  publish(topic: string, message: unknown, options?: { key?: string; headers?: Record<string, string> }): Promise<void>;
  subscribe(topic: string, handler: (message: unknown, context: MessageContext) => Promise<void>, options?: { groupId?: string; autoAck?: boolean }): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
  disconnect(): Promise<void>;
}

export interface KafkaClientConfig {
  config: KafkaAdapterConfig;
  logger?: Logger;
}

let cachedKafkaClient: KafkaClient | null = null;
let kafkaInitializationPromise: Promise<KafkaClient> | null = null;

export function isKafkaAvailable(): boolean {
  try {
    import.meta.resolve('@oneunit/kafka');
    return true;
  } catch {
    return false;
  }
}

export async function createKafkaClient(config: KafkaClientConfig): Promise<KafkaClient> {
  if (cachedKafkaClient) {
    return cachedKafkaClient;
  }
  if (kafkaInitializationPromise) {
    return kafkaInitializationPromise;
  }

  const { config: kafkaConfig, logger } = config;

  let resolveInitialization!: (value: KafkaClient) => void;
  let rejectInitialization!: (reason?: unknown) => void;
  kafkaInitializationPromise = new Promise<KafkaClient>((resolve, reject) => {
    resolveInitialization = resolve;
    rejectInitialization = reject;
  });

  (async () => {
    try {
      const resolved = await resolveKafkaDriver(kafkaConfig, logger);
      const adapter: KafkaDriverAdapter = await resolved.module.createAdapter(
        kafkaConfig,
        logger,
      );
      await adapter.start();

      const client: KafkaClient = {
        async publish(topic: string, message: unknown, options?: { key?: string; headers?: Record<string, string> }) {
          await adapter.publish(topic, message, options);
        },

        async subscribe(topic: string, handler: (message: unknown, context: MessageContext) => Promise<void>, options?: { groupId?: string; autoAck?: boolean }) {
          await adapter.subscribe(topic, handler, options);
        },

        async unsubscribe(topic: string): Promise<void> {
          await adapter.unsubscribe(topic);
        },

        async disconnect(): Promise<void> {
          await adapter.close();
          cachedKafkaClient = null;
        },
      };

      cachedKafkaClient = client;
      logger?.info('Kafka client initialized', {
        clientId: kafkaConfig.clientId,
        driver: resolved.driver,
      });
      resolveInitialization(client);
    } catch (err) {
      logger?.error?.(err instanceof Error ? err : new Error(String(err)), 'Kafka initialization failed');
      rejectInitialization(err);
    } finally {
      kafkaInitializationPromise = null;
    }
  })();

  return kafkaInitializationPromise;
}

export function resetKafkaClient(): void {
  cachedKafkaClient = null;
  kafkaInitializationPromise = null;
}

export function getCachedKafkaClient(): KafkaClient | null {
  return cachedKafkaClient;
}
