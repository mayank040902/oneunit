import { Logger } from '@/observability/logger.js';
import { RabbitMQAdapterConfig } from './types.js';
import { RabbitMQTransport } from './adapter.js';

export type RabbitMQDriver = 'amqplib';

export interface RabbitMQDriverModule {
  createAdapter(config: RabbitMQAdapterConfig, logger?: Logger): Promise<RabbitMQTransport>;
}

export async function resolveRabbitMQDriver(
  config: RabbitMQAdapterConfig,
  logger?: Logger
): Promise<{ driver: RabbitMQDriver; module: RabbitMQDriverModule }> {
  try {
    const module = await import('./amqplib-adapter.js');
    return { driver: 'amqplib', module };
  } catch (error) {
    logger?.error?.(error as Error, 'Failed to load amqplib driver');
    throw new Error('amqplib is required for RabbitMQ transport');
  }
}
