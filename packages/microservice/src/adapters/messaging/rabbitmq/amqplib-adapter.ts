import { Logger } from '@/observability/logger.js';
import { RabbitMQAdapterConfig } from './types.js';
import { RabbitMQTransport } from './adapter.js';

export async function createAdapter(config: RabbitMQAdapterConfig, logger?: Logger): Promise<RabbitMQTransport> {
  const adapter = new RabbitMQTransport(config, logger);
  await adapter.start();
  return adapter;
}
