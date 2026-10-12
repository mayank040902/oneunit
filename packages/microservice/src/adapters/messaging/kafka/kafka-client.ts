import { KafkaAdapterConfig, KafkaDriverAdapter } from './types.js';
import { resolveKafkaDriver } from './driver-resolver.js';
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
    // Synchronous ESM resolution check. require.resolve is
    // not part of the ESM module system and is not used here.
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

  if (kafkaInitializationError) {
    throw kafkaInitializationError;
  }

  const { config: kafkaConfig, logger } = config;

  try {
    // Honor the configured driver explicitly: "oneunit" selects
    // @oneunit/kafka, "kafkajs" selects KafkaJS (whether or not
    // @oneunit/kafka is installed), "auto" tries @oneunit/kafka
    // first and falls back to KafkaJS only when the module is
    // absent. An explicit selection never silently switches
    // drivers after a selection or connection failure.
    const resolved = await resolveKafkaDriver(kafkaConfig, logger);
    const adapter: KafkaDriverAdapter = await resolved.module.createAdapter(
      kafkaConfig,
      logger,
    );
    await adapter.start();

    cachedKafkaClient = {
      async publish(topic: string, message: unknown, options?: { key?: string; headers?: Record<string, string> }) {
        await adapter.publish(topic, message, options);
      },

      async subscribe(topic: string, handler: (message: unknown, context: { topic: string; partition: number; offset: string; headers?: Record<string, string> }) => Promise<void>, options?: { groupId?: string; autoAck?: boolean }) {
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

    logger?.info('Kafka client initialized', {
      clientId: kafkaConfig.clientId,
      driver: resolved.driver,
    });
    return cachedKafkaClient;

  } catch (err) {
    // Driver resolution surfaces actionable dependency errors
    // ("@oneunit/kafka is not installed. Install it or use
    // driver: \"kafkajs\""); connection failures propagate the
    // driver's own error. Cache and rethrow without switching
    // drivers.
    kafkaInitializationError = err instanceof Error ? err : new Error(String(err));
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
