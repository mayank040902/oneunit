import { TransportHealth } from '../../core/capabilities.js';
import { BaseTransport } from '../../transport/transport.js';
import { Logger } from '../../observability/logger.js';
import type { KafkaAdapterConfig } from './kafka/types.js';
import type { NatsAdapterConfig } from '../../config/schema.js';
import type { RabbitMQAdapterConfig } from './rabbitmq/types.js';

export type MessagingProvider = 'kafka' | 'nats' | 'rabbitmq' | string;

export interface MessagingAdapterConfig {
  provider: MessagingProvider;
  [key: string]: unknown;
}

export interface MessagingAdapter extends BaseTransport {
  healthCheck(): Promise<TransportHealth>;
  publish(topic: string, message: unknown, options?: unknown): Promise<void>;
  subscribe(
    topic: string,
    handler: (message: unknown, context: unknown) => Promise<void>,
    options?: unknown
  ): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
}

export interface MessagingAdapterFactory {
  create(config: MessagingAdapterConfig, logger?: Logger): Promise<MessagingAdapter> | MessagingAdapter;
}

export class DefaultMessagingAdapterFactory implements MessagingAdapterFactory {
  async create(config: MessagingAdapterConfig, logger?: Logger): Promise<MessagingAdapter> {
    const { provider, ...providerConfig } = config;
    
    switch (provider) {
      case 'kafka': {
        const { KafkaTransport } = await import('./kafka/adapter.js');
        return new KafkaTransport(providerConfig as unknown as KafkaAdapterConfig, logger);
      }
      case 'nats': {
        const { NatsTransport } = await import('./nats/index.js');
        return new NatsTransport(providerConfig as unknown as NatsAdapterConfig);
      }
      case 'rabbitmq': {
        const { RabbitMQTransport } = await import('./rabbitmq/adapter.js');
        return new RabbitMQTransport(providerConfig as unknown as RabbitMQAdapterConfig, logger);
      }
      default:
        throw new Error(`Unsupported messaging provider: ${provider}`);
    }
  }
}

let factory: MessagingAdapterFactory = new DefaultMessagingAdapterFactory();

export function setMessagingAdapterFactory(newFactory: MessagingAdapterFactory): void {
  factory = newFactory;
}

export function getMessagingAdapterFactory(): MessagingAdapterFactory {
  return factory;
}

export async function createMessagingAdapter(
  config: MessagingAdapterConfig,
  logger?: Logger
): Promise<MessagingAdapter> {
  return factory.create(config, logger);
}
